#!/usr/bin/env node
/**
 * End-to-end test for the build worker.
 *
 * Drives the real Worker class, the real keystore envelope format, the real
 * build-app.mjs and patch-app.mjs, and real Gradle. Only the database is
 * substituted: an in-memory stand-in that mirrors the RPC semantics of
 * supabase-mobile-apps-schema.sql.
 *
 * WHY SUBSTITUTE THE DATABASE
 *   The SQL semantics -- atomic version allocation, SKIP LOCKED claiming, lease
 *   expiry, refusing to publish without the lease -- are verified directly
 *   against Postgres by supa-migration/verify-mobile-apps-schema.sh. Repeating
 *   that here would mean writing test rows into a live project. What this file
 *   tests is the orchestration on top: does the worker allocate before building,
 *   sign with the right key, upload the right bytes, abandon work when it loses
 *   the lease, and clean up signing material on every path.
 *
 * Requires ANDROID_HOME and JDK 17. Takes a couple of minutes: the builds are real.
 *
 * Usage:
 *   node tools/test-worker.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = resolve(HERE, '..');

// A dedicated master key, so the test never depends on (or exercises) the real one.
process.env.SERVBIZ_MASTER_KEY = randomBytes(32).toString('base64');
process.env.ARTIFACT_STORAGE = 'local';
process.env.WORKER_ID = 'test-worker';
process.env.WORKER_LEASE_SECONDS = '900';

const APP_ID = '3f6b1d64-0000-4000-8000-00000000abcd';

let pass = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// In-memory stand-in for the schema
// ---------------------------------------------------------------------------

class FakeDb {
  constructor() {
    this.app = {
      id: APP_ID,
      user_id: '11111111-1111-1111-1111-111111111111',
      application_id: 'com.servbiz.app.workertest',
      app_name: 'Worker Test',
      start_url: 'https://worker.example.com/',
      allowed_hosts: ['worker.example.com'],
      version_code: 0,
      version_name: '1.0.0',
      build_number: 0,
      config: {
        allowSubdomains: true,
        display: { themeColor: '#0F172A', backgroundColor: '#FFFFFF' },
        splash: { backgroundColor: '#0F172A', showLogo: true },
        behavior: { allowCamera: false, allowGeolocation: false },
        remoteConfig: { enabled: false, url: null, timeoutMs: 2500 },
        iconBackgroundColor: '#0F172A',
      },
      status: 'draft',
      current_artifact_key: null,
    };
    this.keys = new Map();
    this.builds = [];
    this.finishCalls = [];
    this.keyInserts = [];
    this.heartbeatReturns = true;
    this.appUpdates = [];
    this.buildUpdates = [];
  }

  enqueue(kind, spec = {}) {
    const job = {
      id: `build-${this.builds.length + 1}`,
      app_id: APP_ID,
      kind,
      status: 'queued',
      spec,
      attempts: 0,
      claimed_by: null,
    };
    this.builds.push(job);
    return job;
  }

  async rpc(name, args) {
    switch (name) {
      case 'mobile_app_build_claim': {
        const job = this.builds.find((b) => b.status === 'queued');
        if (!job) return { data: null, error: null };
        job.status = 'running';
        job.claimed_by = args.p_worker_id;
        job.attempts += 1;
        return { data: [job], error: null };
      }
      // Mirrors the SQL: a single statement that increments and returns.
      case 'mobile_app_allocate_version':
        this.app.version_code += 1;
        return { data: this.app.version_code, error: null };

      case 'mobile_app_allocate_build_number':
        this.app.build_number += 1;
        return { data: this.app.build_number, error: null };

      case 'mobile_app_build_heartbeat':
        return { data: this.heartbeatReturns, error: null };

      case 'mobile_app_build_finish': {
        const job = this.builds.find((b) => b.id === args.p_build_id);
        this.finishCalls.push(args);
        // The SQL refuses when the caller is not the current lease holder.
        if (!job || job.status !== 'running' || job.claimed_by !== args.p_worker_id) {
          return { data: false, error: null };
        }
        job.status = args.p_success ? 'succeeded' : 'failed';
        if (args.p_success) {
          this.app.status = 'ready';
          this.app.current_artifact_key = args.p_artifact_key ?? this.app.current_artifact_key;
        }
        return { data: true, error: null };
      }
      default:
        return { data: null, error: { message: `unknown rpc ${name}` } };
    }
  }

  from(table) {
    const db = this;
    return {
      select() {
        return {
          eq(_col, _val) {
            const read = () => {
              if (table === 'mobile_apps') return { data: db.app, error: null };
              if (table === 'mobile_app_keys') {
                const envelope = db.keys.get(APP_ID);
                return envelope
                  ? { data: { envelope }, error: null }
                  : { data: null, error: null };
              }
              return { data: null, error: { message: 'unknown table' } };
            };
            return {
              async single() {
                const r = read();
                // .single() errors when there is no row; .maybeSingle() does not.
                if (table === 'mobile_app_keys' && !r.data) {
                  return { data: null, error: { message: 'no rows' } };
                }
                return r;
              },
              async maybeSingle() {
                return read();
              },
            };
          },
        };
      },
      async insert(values) {
        if (table === 'mobile_app_keys') {
          db.keys.set(values.app_id, values.envelope);
          db.keyInserts.push(values);
        }
        return { data: null, error: null };
      },
      // Recorded per table. This used to funnel every update into appUpdates and
      // merge it into db.app whatever the target, so a write to another table both
      // polluted the app-update assertions and mutated the app fixture.
      update(values) {
        return {
          async eq() {
            if (table === 'mobile_apps') {
              db.appUpdates.push(values);
              Object.assign(db.app, values);
            } else if (table === 'mobile_app_builds') {
              db.buildUpdates.push(values);
            }
            return { data: null, error: null };
          },
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createEnvelope(workDir) {
  const out = join(workDir, 'envelope.json');
  execFileSync(
    process.execPath,
    [join(HERE, 'keystore.mjs'), 'create', '--app-id', APP_ID, '--cn', 'Worker Test', '--out', out],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env }
  );
  return JSON.parse(readFileSync(out, 'utf8'));
}

const signDirsLeftBehind = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith('servbiz-sign-')).length;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.ANDROID_HOME) {
    console.error('ANDROID_HOME must be set (real Gradle builds are run)');
    process.exit(2);
  }

  const workDir = mkdtempSync(join(tmpdir(), 'servbiz-workertest-'));
  process.env.ARTIFACT_LOCAL_DIR = join(workDir, 'artifacts');

  const { createStorage, artifactKey } = await import('./storage.mjs');
  const workerModule = await import('./worker.mjs');
  const storage = await createStorage(process.env);

  try {
    const envelope = createEnvelope(workDir);
    check('fixture: keystore envelope created', Boolean(envelope.wrappedDek),
          `fingerprint ${String(envelope.certFingerprintSha256).slice(0, 17)}...`);

    // ---- 1. first build with no key on file: the worker must mint one -----
    // Key generation lives on the build host because Netlify functions have no
    // JDK, so a brand new app arrives here with nothing to sign with.
    const virginDb = new FakeDb();
    const virginWorker = new workerModule.Worker(virginDb, storage, { once: true });
    virginDb.enqueue('full');
    await virginWorker.run();

    check('first build: keystore generated on demand',
          virginDb.keyInserts.length === 1 &&
          Boolean(virginDb.keyInserts[0].envelope?.wrappedDek),
          `${virginDb.keyInserts.length} key(s) stored`);
    check('first build: fingerprint recorded on the app row',
          /^[0-9A-F:]{95}$/.test(virginDb.app.cert_fingerprint_sha256 ?? ''),
          String(virginDb.app.cert_fingerprint_sha256).slice(0, 17) + '...');
    check('first build: published with the generated key',
          virginDb.finishCalls.at(-1)?.p_success === true,
          virginDb.finishCalls.at(-1)?.p_error ?? '');

    // ---- 2. a real full build with a pre-existing key ---------------------
    let db = new FakeDb();
    db.keys.set(APP_ID, envelope);
    let worker = new workerModule.Worker(db, storage, { once: true });
    db.enqueue('full');
    const before = signDirsLeftBehind();
    await worker.run();

    const fullFinish = db.finishCalls.at(-1);
    check('full build: published', fullFinish?.p_success === true,
          fullFinish?.p_error ?? '');
    check('full build: versionCode allocated before building', db.app.version_code === 1,
          `version_code=${db.app.version_code}`);
    check('full build: artifact key encodes version and build number',
          fullFinish?.p_artifact_key === artifactKey(APP_ID, 1, 0),
          fullFinish?.p_artifact_key ?? '');
    check('full build: app promoted to ready with the artifact',
          db.app.status === 'ready' && db.app.current_artifact_key === fullFinish?.p_artifact_key,
          `${db.app.status} / ${db.app.current_artifact_key}`);
    check('full build: sha256 recorded', /^[0-9a-f]{64}$/.test(fullFinish?.p_artifact_sha256 ?? ''),
          (fullFinish?.p_artifact_sha256 ?? '').slice(0, 16));
    check('full build: config written back to the app row', db.appUpdates.length === 1,
          Object.keys(db.appUpdates[0] ?? {}).join(', '));

    // Without this the build row's version_code and build_number stay null, and a
    // per-build download cannot name the version it is serving.
    const versionWrite = db.buildUpdates.find((u) => u.version_code != null);
    check('full build: version recorded on the build row',
          versionWrite?.version_code === 1 && versionWrite?.build_number === 0,
          `v${versionWrite?.version_code}-b${versionWrite?.build_number}`);
    check('full build: no signing directories left behind',
          signDirsLeftBehind() <= before, `${signDirsLeftBehind()} present`);

    // The artifact must be a real, correctly signed APK, not just bytes.
    const stored = await storage.get(fullFinish.p_artifact_key);
    const apkPath = join(workDir, 'built.apk');
    writeFileSync(apkPath, stored);
    const bt = join(process.env.ANDROID_HOME, 'build-tools', '35.0.0');
    const verify = execFileSync(join(bt, 'apksigner'), ['verify', '--verbose', apkPath], {
      encoding: 'utf8',
    });
    check('full build: artifact carries a valid v2 signature',
          /v2 scheme \(APK Signature Scheme v2\): true/.test(verify));

    const badging = execFileSync(join(bt, 'aapt2'), ['dump', 'badging', apkPath], {
      encoding: 'utf8',
    });
    check('full build: identity matches the app row',
          badging.includes("name='com.servbiz.app.workertest'") &&
          badging.includes("versionCode='1'"),
          (badging.match(/^package:.*$/m) ?? [''])[0].slice(0, 74));

    // The certificate in the APK must be the one from the envelope, which is what
    // proves the worker signed with this app's key and not some other.
    const certs = execFileSync(join(bt, 'apksigner'), ['verify', '--print-certs', apkPath], {
      encoding: 'utf8',
    });
    const apkFingerprint = (certs.match(/SHA-256 digest: ([0-9a-f]{64})/) ?? [])[1];
    const envelopeFingerprint = String(envelope.certFingerprintSha256).replace(/:/g, '').toLowerCase();
    check('full build: signed with THIS app\'s key', apkFingerprint === envelopeFingerprint,
          `${String(apkFingerprint).slice(0, 16)} vs ${envelopeFingerprint.slice(0, 16)}`);

    // ---- 3. a real patch on top of it ------------------------------------
    const patchDb = db;
    patchDb.enqueue('patch', { display: { themeColor: '#D6006E' } });
    worker = new workerModule.Worker(patchDb, storage, { once: true });
    await worker.run();

    const patchFinish = patchDb.finishCalls.at(-1);
    check('patch: published', patchFinish?.p_success === true, patchFinish?.p_error ?? '');
    check('patch: buildNumber allocated, versionCode untouched',
          patchDb.app.build_number === 1 && patchDb.app.version_code === 1,
          `v${patchDb.app.version_code} b${patchDb.app.build_number}`);
    check('patch: artifact key reflects the new build number',
          patchFinish?.p_artifact_key === artifactKey(APP_ID, 1, 1),
          patchFinish?.p_artifact_key ?? '');

    const patched = await storage.get(patchFinish.p_artifact_key);
    const patchedPath = join(workDir, 'patched.apk');
    writeFileSync(patchedPath, patched);
    const patchedConfig = JSON.parse(
      execFileSync('unzip', ['-p', patchedPath, 'assets/config.json'], { encoding: 'utf8' })
    );
    check('patch: the requested colour is live in the artifact',
          patchedConfig.display.themeColor === '#D6006E',
          patchedConfig.display.themeColor);
    check('patch: buildNumber incremented inside config.json',
          patchedConfig.buildNumber === 1, String(patchedConfig.buildNumber));
    check('patch: start URL not repointed by a patch',
          patchedConfig.buildTime.startUrl === 'https://worker.example.com/',
          patchedConfig.buildTime.startUrl);

    // ---- 4. losing the lease mid-build -----------------------------------
    const lostDb = new FakeDb();
    lostDb.keys.set(APP_ID, envelope);
    lostDb.heartbeatReturns = false;
    // heartbeatMs is forced low rather than derived from the lease. Deriving it
    // made this test depend on the build outrunning the interval, and a warm
    // Gradle cache finished in 11s against a 15s heartbeat -- so the guard under
    // test never engaged and the check passed for the wrong reason.
    const lostWorker = new workerModule.Worker(lostDb, storage, {
      once: true,
      heartbeatMs: 50,
    });
    lostDb.enqueue('full');
    await lostWorker.run();

    const lostFinish = lostDb.finishCalls.at(-1);
    check('lease lost: the build is not published',
          lostFinish?.p_success === false, lostFinish?.p_error?.split('\n')[0]?.slice(0, 60) ?? '');
    check('lease lost: no artifact recorded',
          !lostFinish?.p_artifact_key, String(lostFinish?.p_artifact_key));

    // ---- 5. patching an app with no artifact -----------------------------
    const freshDb = new FakeDb();
    freshDb.keys.set(APP_ID, envelope);
    freshDb.enqueue('patch', { display: { themeColor: '#123456' } });
    const freshWorker = new workerModule.Worker(freshDb, storage, { once: true });
    await freshWorker.run();
    const freshFinish = freshDb.finishCalls.at(-1);
    check('patch with no base artifact: fails with a clear reason',
          freshFinish?.p_success === false &&
          /queue a full build first/.test(freshFinish?.p_error ?? ''),
          (freshFinish?.p_error ?? '').split('\n')[0]?.slice(0, 60));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${pass}/${total} worker checks passed`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
