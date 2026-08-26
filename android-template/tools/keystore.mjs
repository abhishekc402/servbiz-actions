#!/usr/bin/env node
/**
 * Per-app signing keystores, envelope-encrypted at rest.
 *
 * WHY THIS IS THE MOST SENSITIVE PIECE IN THE SYSTEM
 *
 * Distribution is direct APK download, so there is no Play App Signing to fall
 * back on. The keystore IS the app's identity, permanently:
 *
 *   - Lose it and the customer's app can never be updated again. Not by them,
 *     not by us. Their only option is to ship a new app with a new package id
 *     and ask every user to reinstall.
 *   - Leak it and anyone can build an APK that Android accepts as an update to
 *     their app, on their users' phones, under their name.
 *
 * Hence: one key per app, never a shared one, and the plaintext exists only
 * inside a build sandbox for the seconds a signing run takes.
 *
 * ENVELOPE SCHEME
 *
 *   payload      = {keystore, storePassword, keyPassword, keyAlias}
 *   payload      encrypted with a random 32-byte DEK   (AES-256-GCM)
 *   DEK          encrypted with the master key         (AES-256-GCM)
 *   both         authenticated with the appId as AAD
 *
 * The appId as additional authenticated data matters: without it, an attacker
 * with database write access could move app A's envelope onto app B's row and
 * have the worker sign B's APK with A's key. With it, decryption fails.
 *
 * Only the wrapped DEK ever needs re-encrypting to rotate the master key.
 *
 * MASTER KEY
 *
 * Held outside this tool, in SERVBIZ_MASTER_KEY. For production that variable
 * should be populated from OCI Vault (or equivalent) at process start, never
 * committed and never written to disk. `provider` is recorded in the envelope so
 * a Vault-backed provider can be added later without breaking existing rows.
 *
 * Usage:
 *   node tools/keystore.mjs init-master-key
 *   node tools/keystore.mjs create --app-id <uuid> --cn "Acme Services" --out env.json
 *   node tools/keystore.mjs fingerprint --envelope env.json
 *   node tools/keystore.mjs open --envelope env.json --app-id <uuid> --out-dir /tmp/sign
 *   node tools/keystore.mjs export --envelope env.json --app-id <uuid> --out-dir ./custody
 *   node tools/keystore.mjs rewrap --envelope env.json --app-id <uuid> --new-key <base64>
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ENVELOPE_VERSION = 1;
const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** 30 years. A signing certificate that expires strands the app. */
const VALIDITY_DAYS = 10950;

class KeystoreError extends Error {}
const fail = (msg) => {
  throw new KeystoreError(msg);
};

// ---------------------------------------------------------------------------
// Master key
// ---------------------------------------------------------------------------

function masterKey() {
  // Trimmed because secret stores hand back trailing newlines. Base64 decoding
  // happens to tolerate one, so this is belt-and-braces rather than a live bug --
  // but the value is compared and re-encoded elsewhere, where it would not be.
  const raw = process.env.SERVBIZ_MASTER_KEY?.trim();
  if (!raw) {
    fail(
      'SERVBIZ_MASTER_KEY is not set. Generate one with:\n' +
        '  node tools/keystore.mjs init-master-key\n' +
        'In production this should come from OCI Vault at process start, ' +
        'not from a file.'
    );
  }
  let key;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    fail('SERVBIZ_MASTER_KEY is not valid base64');
  }
  if (key.length !== KEY_BYTES) {
    fail(`SERVBIZ_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Envelope crypto
// ---------------------------------------------------------------------------

function seal(plaintext, key, aad) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body };
}

function unseal({ iv, tag, body }, key, aad, what) {
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // Deliberately vague about which check failed, and deliberately loud about
    // the two likely causes.
    fail(
      `could not decrypt ${what}. Either SERVBIZ_MASTER_KEY is not the key this ` +
        'envelope was created with, or the envelope does not belong to this appId.'
    );
  }
}

function buildEnvelope({ appId, keystore, storePassword, keyPassword, keyAlias, fingerprint }) {
  const dek = randomBytes(KEY_BYTES);
  const payload = Buffer.from(
    JSON.stringify({
      keystore: keystore.toString('base64'),
      storePassword,
      keyPassword,
      keyAlias,
      createdAt: new Date().toISOString(),
    }),
    'utf8'
  );

  const sealedPayload = seal(payload, dek, appId);
  const sealedDek = seal(dek, masterKey(), appId);
  dek.fill(0);

  return {
    v: ENVELOPE_VERSION,
    alg: ALGO,
    provider: 'env',
    appId,
    // Safe to store in the clear and safe to log. Lets support confirm which key
    // signed a given APK without ever opening the envelope.
    certFingerprintSha256: fingerprint,
    keyAlias,
    wrappedDek: sealedDek.body.toString('base64'),
    wrapIv: sealedDek.iv,
    wrapTag: sealedDek.tag,
    payload: sealedPayload.body.toString('base64'),
    payloadIv: sealedPayload.iv,
    payloadTag: sealedPayload.tag,
  };
}

function openEnvelope(envelope, appId) {
  if (envelope.v !== ENVELOPE_VERSION) fail(`unsupported envelope version ${envelope.v}`);
  if (envelope.alg !== ALGO) fail(`unsupported algorithm ${envelope.alg}`);

  // Compared in constant time. Not a secret, but this is the check that binds an
  // envelope to an app and it costs nothing to do properly.
  const declared = Buffer.from(String(envelope.appId), 'utf8');
  const supplied = Buffer.from(String(appId), 'utf8');
  if (declared.length !== supplied.length || !timingSafeEqual(declared, supplied)) {
    fail(`envelope belongs to a different appId`);
  }

  const dek = unseal(
    { iv: envelope.wrapIv, tag: envelope.wrapTag, body: Buffer.from(envelope.wrappedDek, 'base64') },
    masterKey(),
    appId,
    'the data key'
  );

  const payload = unseal(
    { iv: envelope.payloadIv, tag: envelope.payloadTag, body: Buffer.from(envelope.payload, 'base64') },
    dek,
    appId,
    'the keystore payload'
  );
  dek.fill(0);

  const parsed = JSON.parse(payload.toString('utf8'));
  return { ...parsed, keystore: Buffer.from(parsed.keystore, 'base64') };
}

// ---------------------------------------------------------------------------
// keytool
// ---------------------------------------------------------------------------

function javaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  try {
    return execFileSync('/usr/libexec/java_home', ['-v', '17'], { encoding: 'utf8' }).trim();
  } catch {
    fail('JAVA_HOME is not set and java_home could not find a JDK 17');
  }
}

const keytool = () => join(javaHome(), 'bin', 'keytool');

/**
 * Runs keytool with the password supplied via a mode-0600 file.
 *
 * keytool accepts `-storepass:file`, so the password never appears in argv and
 * therefore never appears in the process table, where any other local user could
 * read it out of /proc.
 */
function runKeytool(args, password, cwd) {
  const pwFile = join(cwd, 'kt.pw');
  writeFileSync(pwFile, password, { mode: 0o600 });
  try {
    return execFileSync(keytool(), args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(pwFile, { force: true });
  }
}

function generateKeystore({ cn, storePassword, keyAlias, cwd }) {
  const keystorePath = join(cwd, 'app.jks');
  const pwFile = join(cwd, 'kt.pw');
  writeFileSync(pwFile, storePassword, { mode: 0o600 });

  try {
    execFileSync(
      keytool(),
      [
        '-genkeypair',
        '-keystore', keystorePath,
        '-alias', keyAlias,
        '-keyalg', 'RSA',
        '-keysize', '4096',
        '-sigalg', 'SHA256withRSA',
        '-validity', String(VALIDITY_DAYS),
        '-storetype', 'PKCS12',
        '-storepass:file', pwFile,
        '-keypass:file', pwFile,
        '-dname', `CN=${cn}, O=Servbiz, C=IN`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const listing = execFileSync(
      keytool(),
      ['-list', '-v', '-keystore', keystorePath, '-storepass:file', pwFile],
      { encoding: 'utf8' }
    );
    const fingerprint = (listing.match(/SHA256:\s*([0-9A-F:]+)/i) ?? [])[1] ?? null;
    if (!fingerprint) fail('could not read the certificate fingerprint back from keytool');

    return { keystore: readFileSync(keystorePath), fingerprint };
  } finally {
    rmSync(pwFile, { force: true });
    rmSync(keystorePath, { force: true });
  }
}

/**
 * Certificate DN sanitisation.
 *
 * The value lands inside a `-dname` argument. It is passed via argv (not a
 * shell), so injection is not the risk; a malformed DN that makes keytool fail
 * confusingly is. Commas, plus signs, equals and quotes are DN metacharacters.
 */
function validCn(value) {
  if (typeof value !== 'string') fail('--cn must be a string');
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 64) fail('--cn must be 1-64 characters');
  if (!/^[\p{L}\p{M}\p{N} .\-_&()']+$/u.test(trimmed)) {
    fail(`--cn "${trimmed}" contains characters that are not valid in a certificate DN`);
  }
  return trimmed;
}

function validAppId(value) {
  if (typeof value !== 'string' || !/^[\w.:-]{1,128}$/.test(value)) {
    fail('--app-id must be 1-128 characters of letters, digits, . : - _');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

const readEnvelope = () => {
  const p = argOf('--envelope') ?? fail('--envelope is required');
  const abs = resolve(p);
  if (!existsSync(abs)) fail(`envelope not found: ${abs}`);
  return { path: abs, envelope: JSON.parse(readFileSync(abs, 'utf8')) };
};

const writeSecret = (path, contents) => {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
};

const commands = {
  'init-master-key'() {
    const key = randomBytes(KEY_BYTES).toString('base64');
    console.log(`export SERVBIZ_MASTER_KEY='${key}'`);
    console.error(
      '\nStore this in a secret manager, not in a file and not in the repo.\n' +
        'Every app keystore is unrecoverable without it. Losing it means no\n' +
        'customer app can ever be updated again.'
    );
  },

  create() {
    const appId = validAppId(argOf('--app-id') ?? fail('--app-id is required'));
    const cn = validCn(argOf('--cn') ?? fail('--cn is required'));
    const keyAlias = argOf('--alias') ?? 'app';
    if (!/^[\w.\-]{1,64}$/.test(keyAlias)) fail('--alias must be 1-64 word characters');

    masterKey(); // fail early, before doing work

    const cwd = mkdtempSync(join(tmpdir(), 'servbiz-ks-'));
    try {
      // 32 bytes of entropy, hex-encoded. Never shown, never logged; it only
      // ever exists inside the envelope.
      const storePassword = randomBytes(32).toString('hex');
      const { keystore, fingerprint } = generateKeystore({
        cn, storePassword, keyAlias, cwd,
      });

      const envelope = buildEnvelope({
        appId, keystore, storePassword, keyPassword: storePassword, keyAlias, fingerprint,
      });

      const out = argOf('--out');
      if (out) {
        writeSecret(resolve(out), `${JSON.stringify(envelope, null, 2)}\n`);
        console.error(`envelope written to ${resolve(out)}`);
      } else {
        process.stdout.write(`${JSON.stringify(envelope)}\n`);
      }

      console.error(`appId       ${appId}`);
      console.error(`alias       ${keyAlias}`);
      console.error(`validity    ${VALIDITY_DAYS} days`);
      console.error(`SHA-256     ${fingerprint}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },

  fingerprint() {
    const { envelope } = readEnvelope();
    // Stored in the clear precisely so this needs no master key.
    console.log(envelope.certFingerprintSha256 ?? '(not recorded)');
  },

  open() {
    const { envelope } = readEnvelope();
    const appId = validAppId(argOf('--app-id') ?? envelope.appId);
    const outDir = resolve(argOf('--out-dir') ?? fail('--out-dir is required'));

    const opened = openEnvelope(envelope, appId);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    chmodSync(outDir, 0o700);

    const keystorePath = join(outDir, 'keystore.jks');
    writeSecret(keystorePath, opened.keystore);

    // Shaped to drop straight into a build spec's `signing` block.
    writeSecret(
      join(outDir, 'signing.json'),
      `${JSON.stringify({
        storeFile: keystorePath,
        storePassword: opened.storePassword,
        keyPassword: opened.keyPassword,
        keyAlias: opened.keyAlias,
      }, null, 2)}\n`
    );

    console.error(`keystore    ${keystorePath}`);
    console.error(`signing     ${join(outDir, 'signing.json')}`);
    console.error(
      '\nBoth files are mode 0600 and contain live signing material.\n' +
        'Delete this directory as soon as the build finishes.'
    );
  },

  export() {
    const { envelope } = readEnvelope();
    const appId = validAppId(argOf('--app-id') ?? envelope.appId);
    const outDir = resolve(argOf('--out-dir') ?? fail('--out-dir is required'));

    const opened = openEnvelope(envelope, appId);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    chmodSync(outDir, 0o700);

    writeSecret(join(outDir, `${appId}.jks`), opened.keystore);
    writeSecret(
      join(outDir, `${appId}-README.txt`),
      [
        'ANDROID APP SIGNING KEY',
        '',
        `App id:      ${appId}`,
        `Key alias:   ${opened.keyAlias}`,
        `Password:    ${opened.storePassword}`,
        `SHA-256:     ${envelope.certFingerprintSha256 ?? '(unknown)'}`,
        '',
        'This key is the permanent identity of your Android app.',
        '',
        'If you lose it, your app can never be updated again -- not by you and',
        'not by us. Every future version would have to ship as a brand new app',
        'that your users install from scratch.',
        '',
        'If someone else obtains it, they can build an app that Android will',
        'accept as an update to yours, on your users devices, in your name.',
        '',
        'Keep it in a password manager or offline backup. Do not email it and do',
        'not put it in shared storage.',
        '',
      ].join('\n')
    );

    console.error(`exported to ${outDir}`);
    console.error('This directory contains an unencrypted signing key. Handle accordingly.');
  },

  /** Re-wraps the DEK under a new master key. The keystore is not re-generated. */
  rewrap() {
    const { path, envelope } = readEnvelope();
    const appId = validAppId(argOf('--app-id') ?? envelope.appId);
    const newKeyRaw = argOf('--new-key') ?? fail('--new-key (base64, 32 bytes) is required');

    const newKey = Buffer.from(newKeyRaw, 'base64');
    if (newKey.length !== KEY_BYTES) fail(`--new-key must decode to ${KEY_BYTES} bytes`);

    const opened = openEnvelope(envelope, appId);
    const previous = process.env.SERVBIZ_MASTER_KEY;
    try {
      process.env.SERVBIZ_MASTER_KEY = newKey.toString('base64');
      const next = buildEnvelope({
        appId,
        keystore: opened.keystore,
        storePassword: opened.storePassword,
        keyPassword: opened.keyPassword,
        keyAlias: opened.keyAlias,
        fingerprint: envelope.certFingerprintSha256,
      });
      const out = resolve(argOf('--out') ?? path);
      writeSecret(out, `${JSON.stringify(next, null, 2)}\n`);
      console.error(`re-wrapped under the new master key: ${out}`);
    } finally {
      process.env.SERVBIZ_MASTER_KEY = previous;
    }
  },
};

function main() {
  const command = process.argv[2];
  if (!command || !commands[command]) {
    console.error(`usage: keystore.mjs <${Object.keys(commands).join('|')}> [options]`);
    process.exit(2);
  }
  try {
    commands[command]();
  } catch (e) {
    console.error(e instanceof KeystoreError ? `error: ${e.message}` : e);
    process.exit(1);
  }
}

main();
