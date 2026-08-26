#!/usr/bin/env node
/**
 * Fast path: rewrites an existing release APK's cosmetics without Gradle.
 *
 * Swaps assets/config.json and the launcher icons, re-aligns, and re-signs with
 * the app's existing keystore. Seconds instead of the 60-120s a Gradle build
 * costs, which is what makes "edit your app" feel instant rather than like a
 * build queue.
 *
 * Usage:
 *   node tools/patch-app.mjs --base app.apk --patch patch.json --out dir
 *   node tools/patch-app.mjs --base app.apk --patch patch.json --out dir --dry-run
 *
 * WHAT CANNOT BE PATCHED, AND WHY
 *
 *   appName, iconBackgroundColor  compiled into resources.arsc
 *   applicationId, versionCode,   compiled into the binary AndroidManifest.xml
 *     versionName, cleartext
 *   startUrl, allowedHosts        deliberately build-time only, so a compromised
 *                                 config channel cannot repoint installed apps
 *   capability flags turning ON   the <uses-permission> entry is not in the
 *                                 shipped manifest, so the app could never be
 *                                 granted it (turning them OFF is fine)
 *
 * Anything in that list is rejected with a pointer to build-app.mjs rather than
 * silently producing an APK that does not match what was asked for.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DENSITIES,
  PERMISSION_FLAGS,
  SpecError,
  fail,
  normaliseBehavior,
  normaliseDisplay,
  normaliseRemoteConfig,
  normaliseSplash,
} from './lib/spec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Present in a patch spec, these mean "you need a full rebuild". */
const REBUILD_ONLY = [
  'appName',
  'applicationId',
  'versionCode',
  'versionName',
  'allowCleartextTraffic',
  'startUrl',
  'allowedHosts',
  'allowSubdomains',
  'iconBackgroundColor',
];

// ---------------------------------------------------------------------------
// SDK tools
// ---------------------------------------------------------------------------

function buildToolsDir() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) fail('ANDROID_HOME or ANDROID_SDK_ROOT must be set (need zipalign + apksigner)');

  const root = join(sdk, 'build-tools');
  if (!existsSync(root)) fail(`no build-tools under ${root}`);

  // Highest installed version, compared numerically rather than lexically so
  // that 35.0.0 beats 9.0.0.
  const versions = execFileSync('ls', [root], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
      return 0;
    });

  const chosen = versions.at(-1);
  if (!chosen) fail(`no build-tools versions installed under ${root}`);
  return join(root, chosen);
}

// ---------------------------------------------------------------------------
// APK inspection
// ---------------------------------------------------------------------------

const entries = (apk) =>
  execFileSync('unzip', ['-Z', '-1', apk], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

const readEntry = (apk, name) =>
  execFileSync('unzip', ['-p', apk, name], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/**
 * resources.arsc must be uncompressed for apps targeting API 30+, or the app is
 * refused at install time. Nothing here should touch it, so this is a guard
 * against a future change to how the archive is rewritten.
 */
function assertArscStored(apk, label) {
  const listing = execFileSync('unzip', ['-v', apk], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const line = listing.split('\n').find((l) => l.includes('resources.arsc'));
  if (!line) fail(`${label}: resources.arsc missing from the APK`);
  if (!/\bStored\b/.test(line)) {
    fail(
      `${label}: resources.arsc is compressed. Apps targeting API 30+ will not ` +
        `install. Offending entry: ${line.trim()}`
    );
  }
}

/**
 * Locates the launcher icon entries actually present in the APK.
 *
 * Discovered rather than hardcoded: aapt2 appends an API qualifier to density
 * folders (res/mipmap-xxhdpi-v4/), and that suffix is not something to assume.
 */
function iconEntries(apk) {
  const all = entries(apk);
  const found = {};
  for (const density of DENSITIES) {
    const re = new RegExp(`^res/mipmap-${density}(-v\\d+)?/(ic_launcher|ic_launcher_round|ic_launcher_foreground)\\.png$`);
    for (const entry of all) {
      const m = re.exec(entry);
      if (!m) continue;
      found[density] ??= {};
      found[density][m[2]] = entry;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Patch spec
// ---------------------------------------------------------------------------

function normalisePatch(raw, current) {
  if (!raw || typeof raw !== 'object') fail('patch must be a JSON object');

  const offenders = REBUILD_ONLY.filter((k) => raw[k] !== undefined);
  if (offenders.length) {
    fail(
      `${offenders.join(', ')} cannot be changed by a patch (compiled into ` +
        'resources.arsc or the binary manifest). Use build-app.mjs for these.'
    );
  }

  const next = {
    display: normaliseDisplay(raw.display ?? current.display),
    splash: normaliseSplash(raw.splash ?? current.splash),
    behavior: normaliseBehavior(raw.behavior ?? current.behavior),
    remoteConfig: normaliseRemoteConfig(raw.remoteConfig ?? current.remoteConfig),
  };

  // Capability flags may be withdrawn but never granted. The permission is
  // physically absent from the shipped manifest, so switching one on here would
  // produce an app that asks for something it can never receive.
  for (const flag of PERMISSION_FLAGS) {
    const was = current.behavior?.[flag] === true;
    const now = next.behavior[flag] === true;
    if (now && !was) {
      fail(
        `behavior.${flag} cannot be enabled by a patch: the matching ` +
          '<uses-permission> was stripped from this APK at build time. ' +
          'Use build-app.mjs to enable it.'
      );
    }
  }

  const icons = {};
  if (raw.icons && typeof raw.icons === 'object') {
    for (const density of DENSITIES) {
      const entry = raw.icons[density];
      if (entry === undefined) continue;
      const pick = (v, field) => {
        if (v === undefined) return null;
        if (typeof v !== 'string') fail(`icons.${density}.${field} must be a path`);
        const abs = resolve(v);
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          fail(`icons.${density}.${field} does not exist: ${abs}`);
        }
        if (readFileSync(abs).subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') {
          fail(`icons.${density}.${field} is not a PNG`);
        }
        return abs;
      };
      icons[density] = {
        ic_launcher: pick(typeof entry === 'string' ? entry : entry.launcher, 'launcher'),
        ic_launcher_round: pick(entry.round, 'round'),
        ic_launcher_foreground: pick(entry.foreground, 'foreground'),
      };
    }
  }

  let signing = null;
  if (raw.signing) {
    const s = raw.signing;
    if (typeof s.keyAlias !== 'string' || !/^[\w.\-]{1,64}$/.test(s.keyAlias)) {
      fail('signing.keyAlias must be 1-64 word characters');
    }
    for (const f of ['storePassword', 'keyPassword']) {
      if (typeof s[f] !== 'string' || s[f].length === 0) fail(`signing.${f} is required`);
    }
    const storeFile = resolve(s.storeFile ?? '');
    if (!existsSync(storeFile) || !statSync(storeFile).isFile()) {
      fail(`signing.storeFile does not exist: ${storeFile}`);
    }
    signing = { storeFile, ...s, keyAlias: s.keyAlias };
  }

  return { next, icons, signing };
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

function stageFiles(sandbox, config, icons, apkIcons) {
  const staged = [];

  const configPath = join(sandbox, 'assets', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  staged.push('assets/config.json');

  for (const [density, files] of Object.entries(icons)) {
    for (const [name, source] of Object.entries(files)) {
      if (!source) continue;
      const target = apkIcons[density]?.[name];
      if (!target) {
        // Not fatal, but silence here would mean a user changed their icon and
        // nothing happened.
        console.warn(`  ! ${density}/${name} has no matching entry in the APK, skipping`);
        continue;
      }
      const dest = join(sandbox, target);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
      staged.push(target);
    }
  }

  return staged;
}

function replaceEntries(apk, sandbox, staged) {
  // -0 stores rather than deflates, matching how aapt2 writes PNGs and keeping
  // resources.arsc's neighbours predictable. -X drops extra file attributes so
  // the archive stays reproducible. No shell: argv array only.
  execFileSync('zip', ['-0', '-X', '-q', apk, ...staged], { cwd: sandbox, stdio: 'inherit' });
}

function alignAndSign(bt, working, output, signing) {
  execFileSync(join(bt, 'zipalign'), ['-p', '-f', '4', working, output], { stdio: 'inherit' });

  if (!signing) {
    console.warn(
      'WARNING: no signing block in the patch. The APK is unsigned and will not install.'
    );
    return;
  }

  // Passwords go via file: URIs, never argv, so they never appear in the process
  // table. apksigner supports pass:file: for exactly this.
  const pwDir = mkdtempSync(join(tmpdir(), 'servbiz-sign-'));
  const storePw = join(pwDir, 'store');
  const keyPw = join(pwDir, 'key');
  try {
    writeFileSync(storePw, signing.storePassword, { mode: 0o600 });
    writeFileSync(keyPw, signing.keyPassword, { mode: 0o600 });

    execFileSync(
      join(bt, 'apksigner'),
      [
        'sign',
        '--ks', signing.storeFile,
        '--ks-key-alias', signing.keyAlias,
        '--ks-pass', `file:${storePw}`,
        '--key-pass', `file:${keyPw}`,
        // Matches the Gradle config: v1 is pointless at minSdk 24, v2 is
        // mandatory for install on Android 11+, v3 allows key rotation later.
        '--v1-signing-enabled', 'false',
        '--v2-signing-enabled', 'true',
        '--v3-signing-enabled', 'true',
        output,
      ],
      { stdio: 'inherit' }
    );

    execFileSync(join(bt, 'apksigner'), ['verify', '--verbose', output], { stdio: 'pipe' });
  } finally {
    rmSync(pwDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

function main() {
  const basePath = argOf('--base');
  const patchPath = argOf('--patch');
  const outDir = argOf('--out');
  const dryRun = process.argv.includes('--dry-run');

  if (!basePath || !patchPath || !outDir) {
    console.error('usage: patch-app.mjs --base <apk> --patch <patch.json> --out <dir> [--dry-run]');
    process.exit(2);
  }

  const started = Date.now();
  let sandbox;

  try {
    const base = resolve(basePath);
    if (!existsSync(base)) fail(`base APK not found: ${base}`);
    assertArscStored(base, 'base APK');

    const current = JSON.parse(readEntry(base, 'assets/config.json'));
    const raw = JSON.parse(readFileSync(resolve(patchPath), 'utf8'));
    const { next, icons, signing } = normalisePatch(raw, current);

    // buildNumber, not versionCode. versionCode lives in the compiled manifest
    // and cannot move on this path, so an in-app update check should compare this
    // instead. Same versionCode reinstalls fine as long as the signature matches.
    const config = {
      ...current,
      ...next,
      buildNumber: (Number(current.buildNumber) || 0) + 1,
    };

    console.log(`base        ${base}`);
    console.log(`appId       ${config.appId}`);
    console.log(`buildNumber ${current.buildNumber ?? 0} -> ${config.buildNumber}`);
    console.log(`icons       ${Object.keys(icons).length || 'none'}`);

    if (config.splash.backgroundColor !== current.splash?.backgroundColor) {
      console.warn(
        '  ! splash.backgroundColor changed: this restyles the in-app splash\n' +
          '    overlay only. The brief system splash window on Android 12+ comes\n' +
          '    from a compiled colour and needs a rebuild to match.'
      );
    }

    if (dryRun) {
      console.log('\n--dry-run: validated, nothing written.');
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    sandbox = mkdtempSync(join(tmpdir(), 'servbiz-patch-'));
    const working = join(sandbox, 'working.apk');
    copyFileSync(base, working);

    const staged = stageFiles(sandbox, config, icons, iconEntries(base));
    replaceEntries(working, sandbox, staged);

    mkdirSync(resolve(outDir), { recursive: true });
    const output = join(
      resolve(outDir),
      `${config.appId}-patched-${config.buildNumber}.apk`
    );

    alignAndSign(buildToolsDir(), working, output, signing);
    assertArscStored(output, 'patched APK');

    console.log(`\nreplaced    ${staged.length} entr${staged.length === 1 ? 'y' : 'ies'}`);
    console.log(`APK:        ${output}`);
    console.log(`size:       ${(statSync(output).size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`took:       ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error(e instanceof SpecError ? `Invalid patch: ${e.message}` : e);
    process.exit(1);
  } finally {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  }
}

main();
