#!/usr/bin/env node
/**
 * Build worker. Drains the mobile_app_builds queue.
 *
 * Runs on the build host, because it is the only place the Android toolchain
 * exists. Polls outbound, so the host needs no inbound port and no public
 * endpoint to secure.
 *
 * Usage:
 *   node tools/worker.mjs                 # loop until stopped
 *   node tools/worker.mjs --once          # claim at most one job, then exit
 *   node tools/worker.mjs --drain         # clear the queue, then exit (for CI)
 *   node tools/worker.mjs --dry-run       # report what it would do, build nothing
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
 *   SERVBIZ_MASTER_KEY                        required, unwraps keystores
 *   R2_* or S3_* or ARTIFACT_STORAGE=local    artifact storage
 *   ANDROID_HOME, JAVA_HOME                   required for real builds
 *   WORKER_ID                                 defaults to hostname:pid
 *   WORKER_POLL_MS                            idle poll interval, default 5000
 *   WORKER_LEASE_SECONDS                      default 900
 *
 * THREE THINGS THIS IS CAREFUL ABOUT
 *
 *   1. It never publishes an artifact it is no longer entitled to publish. The
 *      lease is heartbeaten while building; if a heartbeat is refused, another
 *      worker has taken the job over and this one abandons its output rather
 *      than racing to overwrite.
 *
 *   2. Signing material exists on disk only for the seconds a build takes, in a
 *      mode-0700 directory, removed in a finally block on every path.
 *
 *   3. version_code is never computed here. It comes from an atomic allocator in
 *      the database, because two workers computing "current + 1" would both
 *      produce the same number and one of the resulting APKs would be
 *      uninstallable as an update.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { artifactKey, createStorage } from './storage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = resolve(HERE, '..');


// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Loads .env from the repo root when the variables are not already set.
 *
 * Convenience for local runs. On the build host these should come from the
 * service manager, not a file.
 */
function loadDotEnv() {
  for (const candidate of [join(TEMPLATE_ROOT, '.env'), join(TEMPLATE_ROOT, '..', '.env')]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, 'utf8').split('\n')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m) continue;
      if (process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
    return candidate;
  }
  return null;
}

const log = (...parts) =>
  console.log(`[${new Date().toISOString()}]`, ...parts);

/**
 * Runtime settings.
 *
 * Read per-instance rather than once at import, so a caller (the test suite, or a
 * host running two workers) can vary them without reloading the module.
 */
export function workerOptions(env = process.env, argv = process.argv) {
  const leaseSeconds = Number(env.WORKER_LEASE_SECONDS ?? 900);
  return {
    workerId: env.WORKER_ID ?? `${hostname()}:${process.pid}`,
    pollMs: Number(env.WORKER_POLL_MS ?? 5000),
    leaseSeconds,
    // Three heartbeats per lease, so a single missed one is not fatal.
    heartbeatMs: Math.max(5_000, Math.floor((leaseSeconds * 1000) / 3)),
    once: argv.includes('--once'),
    dryRun: argv.includes('--dry-run'),

    // Drain mode exists for CI. On a persistent host the poll loop is free, but
    // on a GitHub runner every invocation pays ~1 minute of startup, checkout and
    // cache restore before it can build anything. Draining lets one runner clear
    // several queued jobs and pay that overhead once.
    drain: argv.includes('--drain'),
    maxJobs: Number(env.WORKER_MAX_JOBS ?? 10),
    // Runners are killed at 6 hours. Stopping well short leaves anything still
    // queued for the next dispatch rather than losing a job to a hard timeout.
    budgetMs: Number(env.WORKER_BUDGET_MS ?? 40 * 60 * 1000),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/**
 * Runs one of the build tools as a child process, asynchronously.
 *
 * Asynchronously matters more than it looks. execFileSync blocks the event loop
 * for the entire build, which means the lease heartbeat timer never fires: a
 * build longer than the lease would have its job reclaimed by another worker
 * while it was progressing perfectly well, and two workers would then produce
 * competing artifacts for the same app. The heartbeat is only real if the loop
 * stays free while the child runs.
 */
const runNode = async (script, args, cwd = TEMPLATE_ROOT) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(HERE, script), ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: Number(process.env.WORKER_BUILD_TIMEOUT_MS ?? 20 * 60 * 1000),
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    }
  );
  return stdout;
};

/**
 * Materialises the app's keystore into a short-lived directory.
 *
 * Shells out to keystore.mjs rather than reimplementing the envelope format, so
 * there is exactly one implementation of the crypto and it is the one that has
 * been tested against tampering.
 */
async function openKeystore(appId, envelope) {
  const dir = mkdtempSync(join(tmpdir(), 'servbiz-sign-'));
  const envelopePath = join(dir, 'envelope.json');
  writeFileSync(envelopePath, JSON.stringify(envelope), { mode: 0o600 });

  try {
    await runNode('keystore.mjs', ['open', '--envelope', envelopePath, '--app-id', appId, '--out-dir', dir]);
    return { dir, signing: JSON.parse(readFileSync(join(dir, 'signing.json'), 'utf8')) };
  } finally {
    rmSync(envelopePath, { force: true });
  }
}

/**
 * Generates launcher icons from the customer's uploaded image, if there is one.
 *
 * Returns an `icons` manifest ready to drop into a build spec or a patch, or null
 * when the app has no custom icon and should keep the generated placeholder.
 *
 * Regenerated on every build rather than stored: the icons are derived from the
 * source image and the icon background colour, and caching 15 files per app to
 * save roughly a second of work would mean keeping them in step with both inputs.
 *
 * A failure here is deliberately not fatal. An unreadable source image should cost
 * the customer their custom icon, not their build -- the placeholder is a valid
 * icon and the app is otherwise correct.
 */
async function prepareIcons({ app, workDir, storage, background }) {
  if (!app.icon_source_key) return null;

  try {
    const source = join(workDir, 'icon-source.png');
    writeFileSync(source, await storage.get(app.icon_source_key), { mode: 0o600 });

    const outDir = join(workDir, 'icons');
    const stdout = await runNode('make-icons.mjs', [
      '--source', source,
      '--out', outDir,
      '--background', background,
    ]);

    const icons = JSON.parse(stdout);
    log(`  generated icons for ${Object.keys(icons).length} densities`);
    return icons;
  } catch (e) {
    log(`  ! custom icon skipped: ${String(e.message ?? e).split('\n')[0]}`);
    return null;
  }
}

/** Composes a full build spec from the app row plus the job's requested changes. */
function composeSpec(app, jobSpec, versionCode, signing) {
  const requested = jobSpec ?? {};
  const config = app.config ?? {};

  return {
    appId: app.id,
    applicationId: app.application_id,
    appName: requested.appName ?? app.app_name,
    versionCode,
    versionName: requested.versionName ?? app.version_name ?? '1.0.0',
    startUrl: requested.startUrl ?? app.start_url,
    allowedHosts: requested.allowedHosts ?? app.allowed_hosts ?? [],
    allowSubdomains: requested.allowSubdomains ?? config.allowSubdomains ?? true,
    allowCleartextTraffic: requested.allowCleartextTraffic ?? false,
    display: { ...(config.display ?? {}), ...(requested.display ?? {}) },
    splash: { ...(config.splash ?? {}), ...(requested.splash ?? {}) },
    behavior: { ...(config.behavior ?? {}), ...(requested.behavior ?? {}) },
    remoteConfig: { ...(config.remoteConfig ?? {}), ...(requested.remoteConfig ?? {}) },
    iconBackgroundColor:
      requested.iconBackgroundColor ?? config.iconBackgroundColor ?? '#FFFFFF',
    ...(requested.icons ? { icons: requested.icons } : {}),
    signing,
  };
}

async function runFullBuild({ app, job, signing, workDir, storage }) {
  const versionCode = job.allocatedVersionCode;
  const spec = composeSpec(app, job.spec, versionCode, signing);

  // Composited against the background the icon will actually sit on, so a
  // transparent logo matches the adaptive background layer.
  const icons = await prepareIcons({
    app, workDir, storage, background: spec.iconBackgroundColor,
  });
  if (icons) spec.icons = icons;
  const specPath = join(workDir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec, null, 2), { mode: 0o600 });

  const outDir = join(workDir, 'out');
  const output = await runNode('build-app.mjs', ['--spec', specPath, '--out', outDir]);

  const apk = (output.match(/^APK: (.+)$/m) ?? [])[1];
  if (!apk || !existsSync(apk)) {
    throw new Error('build-app.mjs reported success but produced no APK path');
  }
  return { apk, versionCode, buildNumber: app.build_number ?? 0, spec };
}

async function runPatch({ app, job, signing, workDir, storage }) {
  if (!app.current_artifact_key) {
    throw new Error(
      'cannot patch an app with no current artifact; queue a full build first'
    );
  }

  const base = join(workDir, 'base.apk');
  writeFileSync(base, await storage.get(app.current_artifact_key), { mode: 0o600 });

  const patch = { ...(job.spec ?? {}), signing };

  // The stored colour, not a requested one: iconBackgroundColor is compiled into
  // resources.arsc, so a patch cannot change it, and compositing against a colour
  // the APK does not actually use would leave the legacy icons mismatched.
  const icons = await prepareIcons({
    app,
    workDir,
    storage,
    background: app.config?.iconBackgroundColor ?? '#FFFFFF',
  });
  if (icons) patch.icons = icons;
  const patchPath = join(workDir, 'patch.json');
  writeFileSync(patchPath, JSON.stringify(patch, null, 2), { mode: 0o600 });

  const outDir = join(workDir, 'out');
  const output = await runNode('patch-app.mjs', ['--base', base, '--patch', patchPath, '--out', outDir]);

  const apk = (output.match(/^APK:\s+(.+)$/m) ?? [])[1]?.trim();
  if (!apk || !existsSync(apk)) {
    throw new Error('patch-app.mjs reported success but produced no APK path');
  }
  return {
    apk,
    versionCode: app.version_code,
    buildNumber: job.allocatedBuildNumber,
    spec: patch,
  };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export class Worker {
  constructor(supabase, storage, options = {}) {
    this.db = supabase;
    this.storage = storage;
    this.stopping = false;
    this.opts = { ...workerOptions(), ...options };
    this.completed = 0;
    this.startedAt = Date.now();
    this.completed = 0;
    this.startedAt = Date.now();
  }

  async rpc(name, args) {
    const { data, error } = await this.db.rpc(name, args);
    if (error) throw new Error(`${name} failed: ${error.message}`);
    return data;
  }

  async claim() {
    const rows = await this.rpc('mobile_app_build_claim', {
      p_worker_id: this.opts.workerId,
      p_lease_seconds: this.opts.leaseSeconds,
    });
    return Array.isArray(rows) ? rows[0] ?? null : rows ?? null;
  }

  async loadApp(appId) {
    const { data, error } = await this.db
      .from('mobile_apps')
      .select('*')
      .eq('id', appId)
      .single();
    if (error) throw new Error(`could not load app ${appId}: ${error.message}`);
    return data;
  }

  /**
   * Returns the app's signing envelope, creating it on first build.
   *
   * Key generation lives here rather than in the API because it needs keytool,
   * and the API runs as Netlify functions where there is no JDK. The build host
   * is the only place in the system that can do this.
   *
   * The race this appears to have is closed by the schema: the partial unique
   * index on mobile_app_builds allows only one active build per app, so only one
   * worker can ever be inside this function for a given app.
   */
  async loadEnvelope(app) {
    const existing = await this.db
      .from('mobile_app_keys')
      .select('envelope')
      .eq('app_id', app.id)
      .maybeSingle();

    if (existing.error) {
      throw new Error(`could not read the signing key: ${existing.error.message}`);
    }
    if (existing.data?.envelope) return existing.data.envelope;

    log('  no signing key yet; generating one (permanent for this app)');
    const dir = mkdtempSync(join(tmpdir(), 'servbiz-newkey-'));
    try {
      const out = join(dir, 'envelope.json');
      await runNode('keystore.mjs', [
        'create',
        '--app-id', app.id,
        // The certificate CN is the app name, which is what a user inspecting the
        // APK's signature will see.
        '--cn', app.app_name,
        '--out', out,
      ]);
      const envelope = JSON.parse(readFileSync(out, 'utf8'));

      const inserted = await this.db.from('mobile_app_keys').insert({
        app_id: app.id,
        envelope,
        master_key_id: 'env:v1',
      });
      if (inserted.error) {
        throw new Error(`could not store the signing key: ${inserted.error.message}`);
      }

      // Recorded in the clear so support can confirm which key signed an APK
      // without anything having to open the envelope.
      await this.db
        .from('mobile_apps')
        .update({ cert_fingerprint_sha256: envelope.certFingerprintSha256 })
        .eq('id', app.id);

      // The fingerprint is recorded on the app row; not printed, because these logs
      // are public and it ties a signing identity to a specific build.
      log('  signing key created');
      return envelope;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async finish(job, success, artifact, errorMessage) {
    const accepted = await this.rpc('mobile_app_build_finish', {
      p_build_id: job.id,
      p_worker_id: this.opts.workerId,
      p_success: success,
      p_artifact_key: artifact?.key ?? null,
      p_artifact_size: artifact?.size ?? null,
      p_artifact_sha256: artifact?.sha256 ?? null,
      p_error: errorMessage ?? null,
    });
    if (!accepted) {
      log(`  ! finish rejected for ${job.id}: the lease was no longer ours`);
    }
    return accepted;
  }

  /**
   * Runs one job.
   *
   * The heartbeat runs on a timer for the duration. If the database refuses a
   * heartbeat the lease has been reclaimed, and everything after that point is
   * discarded: uploading would mean two workers writing different artifacts for
   * the same app with no way to tell which won.
   */
  async process(job) {
    log(`claimed ${job.kind} build ${job.id} (attempt ${job.attempts})`);

    let leaseLost = false;
    const heartbeat = setInterval(async () => {
      try {
        const ok = await this.rpc('mobile_app_build_heartbeat', {
          p_build_id: job.id,
          p_worker_id: this.opts.workerId,
          p_lease_seconds: this.opts.leaseSeconds,
        });
        if (!ok && !leaseLost) {
          leaseLost = true;
          // Stop beating: there is nothing left to renew, and continuing just
          // fills the log with the same line until the build finishes.
          clearInterval(heartbeat);
          log('  ! lease lost; this build will be abandoned');
        }
      } catch (e) {
        log(`  ! heartbeat error: ${e.message}`);
      }
    }, this.opts.heartbeatMs);

    const workDir = mkdtempSync(join(tmpdir(), 'servbiz-job-'));
    let signDir = null;

    try {
      const app = await this.loadApp(job.app_id);
      // Deliberately not logged: application_id and app_name.
      //
      // This repository is public, which makes its workflow logs readable by any
      // signed-in GitHub user. Printing the package id and display name here would
      // publish a running list of every customer who has built an app, along with
      // when and how often. The build id above is an opaque UUID and is enough to
      // correlate a run with its row in mobile_app_builds, where the identifying
      // detail already lives behind authentication.

      if (job.kind === 'full') {
        job.allocatedVersionCode = await this.rpc('mobile_app_allocate_version', {
          p_app_id: app.id,
        });
        log(`  allocated versionCode ${job.allocatedVersionCode}`);
      } else {
        job.allocatedBuildNumber = await this.rpc('mobile_app_allocate_build_number', {
          p_app_id: app.id,
        });
        log(`  allocated buildNumber ${job.allocatedBuildNumber}`);
      }

      if (this.opts.dryRun) {
        log('  --dry-run: stopping before the build');
        await this.finish(job, false, null, 'dry run');
        return;
      }

      const envelope = await this.loadEnvelope(app);
      const opened = await openKeystore(app.id, envelope);
      signDir = opened.dir;

      const built =
        job.kind === 'full'
          ? await runFullBuild({ app, job, signing: opened.signing, workDir, storage: this.storage })
          : await runPatch({ app, job, signing: opened.signing, workDir, storage: this.storage });

      // Checked before upload as well as before finish: an abandoned build should
      // not leave a stray object behind either.
      if (leaseLost) throw new Error('lease lost during build; output discarded');

      const key = artifactKey(app.id, built.versionCode, built.buildNumber);
      const artifact = await this.storage.put(key, readFileSync(built.apk));
      // Size only. The object key embeds the app's UUID, and these logs are public.
      log(`  uploaded artifact (${(artifact.size / 1024 / 1024).toFixed(2)} MB)`);

      // Record which version this row produced.
      //
      // mobile_app_builds.version_code and build_number exist in the schema but
      // nothing was writing them, so every row read back as null. That is only
      // visible once past builds are listed individually: the UI cannot label them
      // and a per-build download falls back to the app's current version, naming
      // the file after a version it is not. mobile_app_build_finish takes no
      // version arguments, so this is a plain update rather than a schema change.
      await this.db
        .from('mobile_app_builds')
        .update({ version_code: built.versionCode, build_number: built.buildNumber })
        .eq('id', job.id);

      if (leaseLost) throw new Error('lease lost after upload; not publishing');

      const published = await this.finish(job, true, artifact, null);
      if (published) {
        // Reflects what was actually built, so a later patch starts from the real
        // current state rather than from what was requested at some earlier point.
        await this.db
          .from('mobile_apps')
          .update({
            config: {
              allowSubdomains: built.spec.allowSubdomains ?? true,
              display: built.spec.display,
              splash: built.spec.splash,
              behavior: built.spec.behavior,
              remoteConfig: built.spec.remoteConfig,
              iconBackgroundColor: built.spec.iconBackgroundColor,
            },
            version_name: built.spec.versionName ?? app.version_name,
          })
          .eq('id', app.id);
        log(`  done: ${job.kind} build published`);
      }
    } catch (e) {
      const message = String(e.message ?? e).slice(0, 3500);
      // The full message is still recorded on the build row by finish() below. It
      // is not printed here: a Gradle failure routinely quotes the package name,
      // the start URL and absolute paths, and these logs are public. Read failures
      // from mobile_app_builds.error, which sits behind authentication.
      log(`  FAILED (detail recorded against build ${job.id})`);
      try {
        await this.finish(job, false, null, message);
      } catch (inner) {
        log(`  ! could not record the failure: ${inner.message}`);
      }
    } finally {
      clearInterval(heartbeat);
      // Signing material must not outlive the job on any path.
      if (signDir) rmSync(signDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  async run() {
    log(`worker ${this.opts.workerId} started`);
    // Kind only. describe() includes the bucket and the endpoint host, which name
    // the storage account, and these logs are public.
    log(`  storage ${this.storage.kind}`);
    log(`  lease ${this.opts.leaseSeconds}s, heartbeat every ${this.opts.heartbeatMs / 1000}s`);
    if (this.opts.drain) {
      log(`  drain: up to ${this.opts.maxJobs} job(s) or ${Math.round(this.opts.budgetMs / 60000)} min`);
    }
    if (this.opts.drain) {
      log(`  drain mode: up to ${this.opts.maxJobs} job(s) or ${Math.round(this.opts.budgetMs / 60000)} minutes`);
    }
    if (this.opts.dryRun) log('  --dry-run: no builds will be produced');

    while (!this.stopping) {
      let job = null;
      try {
        job = await this.claim();
      } catch (e) {
        log(`claim failed: ${e.message}`);
        await sleep(this.opts.pollMs);
        continue;
      }

      if (!job) {
        if (this.opts.once || this.opts.drain) {
          log(`nothing queued; exiting after ${this.completed} job(s)`);
          return;
        }
        await sleep(this.opts.pollMs);
        continue;
      }

      await this.process(job);
      this.completed += 1;

      if (this.opts.once) return;

      if (this.opts.drain) {
        // Both limits leave the remainder of the queue for the next run rather
        // than risking a hard runner timeout mid-build.
        if (this.completed >= this.opts.maxJobs) {
          log(`reached the ${this.opts.maxJobs}-job limit; leaving the rest queued`);
          return;
        }
        const elapsed = Date.now() - this.startedAt;
        if (elapsed > this.opts.budgetMs) {
          log(`time budget spent (${Math.round(elapsed / 1000)}s); leaving the rest queued`);
          return;
        }
      }
    }
    log('stopped');
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const dotenv = loadDotEnv();
  if (dotenv) log(`loaded environment from ${dotenv}`);

  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SERVBIZ_MASTER_KEY'].filter(
    (v) => !process.env[v]
  );
  if (missing.length) {
    console.error(`missing required environment: ${missing.join(', ')}`);
    process.exit(2);
  }

  const { createClient } = await import('@supabase/supabase-js');
  // Trimmed: a trailing newline from a secret store makes the URL unparseable and
  // puts an illegal character in the apikey header, both reported far from here.
  const supabase = createClient(
    process.env.SUPABASE_URL?.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const storage = await createStorage(process.env);
  const worker = new Worker(supabase, storage);

  // Finish the job in flight rather than dropping it: an abrupt exit leaves a
  // row in 'running' until its lease expires, which delays the customer's build
  // by the whole lease duration for no reason.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (worker.stopping) process.exit(1);
      log(`${signal} received; finishing the current job then exiting`);
      worker.stopping = true;
    });
  }

  await worker.run();
}

// Only run when invoked directly; the test suite imports Worker from here.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
