/**
 * Artifact storage for built APKs.
 *
 * Two backends behind one interface:
 *
 *   s3     Any S3-compatible object store. Configured for Cloudflare R2, which
 *          this project already uses, and which is a better fit than Oracle
 *          Object Storage for this specifically: R2 charges nothing for egress,
 *          and egress is the entire cost profile of handing out APK downloads.
 *   local  A directory. For development and for running the worker before any
 *          object store exists.
 *
 * Objects are stored PRIVATE. Downloads are expected to go through an endpoint
 * that checks the requester owns the app, rather than through a public URL:
 * an APK is a signed artifact carrying a customer's identity, and a guessable
 * public link is a poor gate on it.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Reads a config value from the environment, trimming surrounding whitespace.
 *
 * Not cosmetic. These values become part of an AWS SigV4 `authorization` header,
 * and Node rejects a header value containing a newline outright -- with
 * `Invalid character in header content ["authorization"]`, which names neither
 * the variable nor the reason. Secret stores are a common source of exactly that:
 * pasting a key into the GitHub Actions secret UI, or `echo`ing one into a file,
 * readily leaves a trailing newline that is invisible everywhere until the first
 * request fails. Every value here is an opaque identifier or key with no
 * meaningful leading or trailing space, so trimming cannot discard signal.
 *
 * Whitespace-only is reported as absent, so the caller's own "is required"
 * message fires instead of a header error further down.
 */
const envValue = (env, name) => {
  const raw = env[name];
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * Object key for a build.
 *
 * versionCode and buildNumber both appear because they move independently:
 * a Gradle build bumps the first, a fast patch bumps the second. Using only one
 * would let a patch overwrite the artifact of the build it was derived from.
 */
export const artifactKey = (appId, versionCode, buildNumber) =>
  `mobile-apps/${appId}/v${versionCode}-b${buildNumber}.apk`;

class LocalStorage {
  constructor(root) {
    this.kind = 'local';
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  describe() {
    return `local:${this.root}`;
  }

  async put(key, body) {
    const target = join(this.root, key);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    return { key, size: body.length, sha256: sha256(body) };
  }

  async get(key) {
    const target = join(this.root, key);
    if (!existsSync(target)) throw new Error(`object not found: ${key}`);
    return readFileSync(target);
  }
}

class S3Storage {
  constructor({ bucket, endpoint, region, accessKeyId, secretAccessKey, client }) {
    this.kind = 's3';
    this.bucket = bucket;
    this.endpoint = endpoint;
    this.client = client;
    this._config = { region, accessKeyId, secretAccessKey };
  }

  static async create(config) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: config.region ?? 'auto',
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // R2 and most S3-compatible stores need path-style addressing; virtual
      // host style assumes bucket-as-subdomain, which they do not all provide.
      forcePathStyle: true,
    });
    return new S3Storage({ ...config, client });
  }

  describe() {
    // Endpoint host only. The account id embedded in an R2 endpoint is not a
    // credential, but there is no reason to write it to a log either.
    const host = (() => {
      try {
        return new URL(this.endpoint).host.replace(/^[^.]{0,6}[^.]*/, (m) => `${m.slice(0, 6)}...`);
      } catch {
        return '(unparseable endpoint)';
      }
    })();
    return `s3:${this.bucket} @ ${host}`;
  }

  async put(key, body, contentType = 'application/vnd.android.package-archive') {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const digest = sha256(body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Round-trip integrity check, and it lands in the object metadata so a
        // later download can be verified without re-hashing the whole file.
        ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
        Metadata: { sha256: digest },
      })
    );
    return { key, size: body.length, sha256: digest };
  }

  async get(key) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    const chunks = [];
    for await (const chunk of result.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
}

/**
 * Chooses a backend from the environment.
 *
 * Explicit ARTIFACT_STORAGE wins; otherwise R2 is used when its credentials are
 * present, and local storage is the fallback so the worker is runnable with no
 * cloud configuration at all.
 */
export async function createStorage(env = process.env) {
  const value = (name) => envValue(env, name);
  const requested = value('ARTIFACT_STORAGE');

  if (requested === 'local' || (!requested && !value('R2_ACCESS_KEY_ID') && !value('S3_ACCESS_KEY_ID'))) {
    return new LocalStorage(value('ARTIFACT_LOCAL_DIR') ?? '.artifacts');
  }

  if (requested === 's3' || value('S3_ACCESS_KEY_ID')) {
    for (const v of ['S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      if (!value(v)) throw new Error(`${v} is required for ARTIFACT_STORAGE=s3`);
    }
    return S3Storage.create({
      bucket: value('S3_BUCKET'),
      endpoint: value('S3_ENDPOINT'),
      region: value('S3_REGION') ?? 'auto',
      accessKeyId: value('S3_ACCESS_KEY_ID'),
      secretAccessKey: value('S3_SECRET_ACCESS_KEY'),
    });
  }

  // Cloudflare R2.
  for (const v of ['R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!value(v)) throw new Error(`${v} is required for R2 artifact storage`);
  }
  return S3Storage.create({
    bucket: value('R2_BUCKET_NAME'),
    endpoint: `https://${value('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    region: 'auto',
    accessKeyId: value('R2_ACCESS_KEY_ID'),
    secretAccessKey: value('R2_SECRET_ACCESS_KEY'),
  });
}
