#!/usr/bin/env node
/**
 * Read-only preflight for the build worker.
 *
 * Confirms the schema is applied, the RPCs exist, artifact storage is writable,
 * and the master key is usable -- without inserting a single row into
 * mobile_apps or mobile_app_builds. Safe to run against production.
 *
 * The one write it performs is a small object into artifact storage under a
 * `_preflight/` prefix, which it then reads back and deletes. Storage that
 * cannot round-trip is worth discovering now rather than at the end of a build.
 *
 * Usage:
 *   node tools/check-connectivity.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

for (const candidate of [join(ROOT, '.env'), join(ROOT, '..', '.env')]) {
  if (!existsSync(candidate)) continue;
  for (const line of readFileSync(candidate, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  break;
}

let pass = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
};

// Reported but not counted, so it cannot fail the run. Used for conditions the
// code already compensates for: the operator should still fix them, but blocking
// every queued build over one would be a worse outcome than proceeding.
const warnings = [];
const warn = (name, detail) => {
  warnings.push(name);
  console.log(`WARN  ${name.padEnd(46)} ${detail}`);
};

async function main() {
  // ---- environment -------------------------------------------------------
  for (const v of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SERVBIZ_MASTER_KEY']) {
    check(`env ${v}`, Boolean(process.env[v]), process.env[v] ? 'set' : 'MISSING');
  }
  const key = process.env.SERVBIZ_MASTER_KEY
    ? Buffer.from(process.env.SERVBIZ_MASTER_KEY.trim(), 'base64')
    : Buffer.alloc(0);
  check('master key is 32 bytes', key.length === 32, `${key.length} bytes`);

  // Surrounding whitespace in a credential is worth its own check because of how
  // badly it reports itself otherwise. A trailing newline on an R2 key surfaces
  // as `Invalid character in header content ["authorization"]` from deep inside
  // the AWS SDK -- no variable name, no mention of whitespace. Pasting a secret
  // into the GitHub Actions UI is a routine way to acquire one, and it is
  // invisible in every UI that displays it afterwards.
  const dirty = [
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SERVBIZ_MASTER_KEY',
    'R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
    'S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
  ].filter((v) => typeof process.env[v] === 'string' && process.env[v] !== process.env[v].trim());
  if (dirty.length > 0) {
    warn('stray whitespace in credentials',
         `trimmed at use, but re-enter without the trailing newline: ${dirty.join(', ')}`);
  }

  // ---- toolchain ---------------------------------------------------------
  check('ANDROID_HOME points at an SDK',
        Boolean(process.env.ANDROID_HOME) && existsSync(join(process.env.ANDROID_HOME ?? '', 'build-tools')),
        process.env.ANDROID_HOME ?? 'not set');
  check('gradle wrapper present', existsSync(join(ROOT, 'gradlew')));

  // ---- database ----------------------------------------------------------
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY.trim(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    for (const table of ['mobile_apps', 'mobile_app_keys', 'mobile_app_builds']) {
      const { error } = await db.from(table).select('*', { count: 'exact', head: true });
      check(`table ${table}`, !error, error?.message ?? 'reachable');
    }

    // p_max_attempts: 0 is what makes this safe, and it is not optional.
    //
    // The claim RPC selects rows WHERE attempts < p_max_attempts, so passing 0
    // makes the predicate false for every row: the function resolves, executes,
    // and updates nothing. Calling it with the default instead would claim a real
    // queued build -- and because preflight runs immediately before the worker in
    // the same job, the worker would then find an empty queue and the customer's
    // build would sit in 'running' until its lease expired. Every subsequent run
    // repeated it, incrementing attempts until the job passed max_attempts and
    // became permanently unclaimable. The check looked read-only because it is
    // harmless on an empty queue, which is the only state it was ever tried in.
    const { data: claimed, error: claimError } = await db.rpc('mobile_app_build_claim', {
      p_worker_id: '__preflight__',
      p_lease_seconds: 30,
      p_max_attempts: 0,
    });
    const claimedNothing = !claimed || (Array.isArray(claimed) && claimed.length === 0);
    check('rpc mobile_app_build_claim', !claimError && claimedNothing,
          claimError?.message ?? (claimedNothing
            ? 'callable, claimed nothing'
            : 'DANGER: preflight claimed a real build'));

    for (const fn of ['mobile_app_allocate_version', 'mobile_app_allocate_build_number']) {
      // Called with a UUID that cannot exist, so the UPDATE matches no row and
      // returns null. Proves the function is present without allocating anything.
      const { error } = await db.rpc(fn, {
        p_app_id: '00000000-0000-4000-8000-000000000000',
      });
      check(`rpc ${fn}`, !error, error?.message ?? 'callable, allocated nothing');
    }

    const { count, error: countError } = await db
      .from('mobile_apps')
      .select('*', { count: 'exact', head: true });
    // The count is fetched to prove the table really reads, but not printed: this
    // repository is public, so printing it would publish a running customer count
    // on every scheduled run.
    check('mobile_apps is readable', !countError, countError?.message ?? 'ok');
  }

  // ---- storage -----------------------------------------------------------
  try {
    const { createStorage } = await import('./storage.mjs');
    const storage = await createStorage(process.env);
    const probeKey = `_preflight/${randomBytes(8).toString('hex')}.txt`;
    const body = Buffer.from(`servbiz preflight ${new Date().toISOString()}\n`);

    const put = await storage.put(probeKey, body, 'text/plain');
    const got = await storage.get(probeKey);
    // Kind only, not describe(): that includes the bucket name and endpoint host.
    check(`storage round-trip (${storage.kind})`,
          Buffer.compare(body, got) === 0 && put.sha256.length === 64,
          'read back byte-identical');

    if (storage.kind === 's3') {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      await storage.client.send(
        new DeleteObjectCommand({ Bucket: storage.bucket, Key: probeKey })
      );
      console.log('      preflight object deleted');
    }
  } catch (e) {
    // Storage errors can quote the endpoint and bucket, so only the error type is
    // printed here. Run this locally against the same environment to see detail.
    check('storage round-trip', false, `${e.name ?? 'Error'} (run locally for detail)`);
  }

  console.log(`\n${pass}/${total} preflight checks passed`);
  if (warnings.length > 0) {
    console.log(`${warnings.length} warning(s): ${warnings.join(', ')}`);
  }
  if (pass !== total) {
    console.log('\nThe worker will not run correctly until these pass.');
  }
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
