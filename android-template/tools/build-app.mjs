#!/usr/bin/env node
/**
 * Turns a build spec into a signed release APK.
 *
 * This is the slow path: it runs Gradle and is only needed when the package id,
 * app name, version or permission set changes -- in practice, once per app at
 * creation time. Cosmetic edits afterwards go through the fast-patch path.
 *
 * Usage:
 *   node tools/build-app.mjs --spec spec.json --out /tmp/out
 *   node tools/build-app.mjs --spec spec.json --out /tmp/out --dry-run
 *
 * --dry-run materialises the sandbox and every generated file but skips Gradle,
 * which is how you inspect what a spec would actually produce.
 *
 * SECURITY NOTES
 *  - Every value in the spec is treated as untrusted. Validation is allow-list
 *    based and happens before anything is written.
 *  - Gradle is invoked with execFileSync and an argv array. No spec value is
 *    ever interpolated into a shell string, so there is no shell to inject into.
 *  - The app name is XML-escaped before it reaches a generated resource file.
 *  - signing.properties is written into the sandbox and deleted in a finally
 *    block. Passwords are never logged, never passed as argv (where they would
 *    be visible in /proc), and never written outside the sandbox.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DENSITIES,
  SpecError,
  bool,
  fail,
  normaliseBehavior,
  normaliseDisplay,
  normaliseRemoteConfig,
  normaliseSplash,
  validColor,
} from './lib/spec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = resolve(HERE, '..');

// ---------------------------------------------------------------------------
// Validation specific to a full build (identity, versioning, origin)
// ---------------------------------------------------------------------------

/**
 * Android application id rules: two or more dot-separated segments, each
 * starting with a letter, containing only letters, digits and underscores.
 *
 * Segments that are Java keywords are rejected because AGP will fail later with
 * a far less obvious error.
 */
const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package',
  'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient',
  'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
]);

function validApplicationId(value) {
  if (typeof value !== 'string') fail('applicationId must be a string');
  if (value.length > 155) fail('applicationId is too long');
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value)) {
    fail(
      `applicationId "${value}" is invalid: needs 2+ dot-separated segments, ` +
        'lowercase letters/digits/underscore, each starting with a letter'
    );
  }
  for (const segment of value.split('.')) {
    if (JAVA_KEYWORDS.has(segment)) {
      fail(`applicationId segment "${segment}" is a reserved Java keyword`);
    }
  }
  return value;
}

/**
 * The app name lands in a generated `<string name="app_name">` resource, so it
 * has to be safe as XML text AND as an Android string resource. Rather than
 * trying to sanitise arbitrary input, only a known-good character set is
 * accepted and the two characters that still need escaping are escaped.
 */
function validAppName(value) {
  if (typeof value !== 'string') fail('appName must be a string');
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 50) {
    fail('appName must be 1-50 characters');
  }
  // Straight and curly apostrophes are both allowed because real business names
  // use them ("Bob's Cafe"). Angle brackets, quotes, backslash and percent are
  // excluded: the first three would break the generated XML and percent triggers
  // Android's string-formatting path.
  // \p{M} is not optional. Indic vowel signs, Arabic and Hebrew points and Thai
  // tone marks are combining marks, not letters, so a \p{L}-only allow-list
  // rejects "चाय और केक" and with it every Hindi, Tamil, Bengali, Arabic and
  // Thai business name.
  //
  // ZWNJ/ZWJ (U+200C/U+200D) are allowed because Indic scripts need them to
  // render certain conjuncts. Other format characters stay out, notably the bidi
  // overrides, which can make a name display as something other than what it
  // actually contains.
  if (!/^[\p{L}\p{M}\p{N} .,'\u2019&()\-_+!\u200C\u200D]+$/u.test(trimmed)) {
    fail(
      `appName "${trimmed}" contains unsupported characters. Allowed: letters in ` +
        "any script, digits, space, and . , ' & ( ) - _ + !"
    );
  }
  return trimmed;
}

/**
 * Escapes an app name for Android's string-resource dialect. Only apostrophes.
 *
 * The division of labour here is not obvious and was established by testing
 * aapt2 directly:
 *
 *   AGP's resValue() writer DOES XML-escape `&`, so passing `&amp;` yields
 *   `&amp;amp;` and a launcher label that literally reads "Bob's Tea &amp; Cake".
 *
 *   AGP does NOT escape apostrophes, and aapt2 hard-fails on a bare one:
 *   "error: unescaped apostrophe in string". So `'` must be sent as `\'`.
 *
 * Verified with aapt2 compile on single-string resource files:
 *   "Bob s Tea and Cake"      OK
 *   "Bob s Tea &amp; Cake"    OK
 *   "Bob's Tea and Cake"      FAIL  unescaped apostrophe
 *   "Bob\'s Tea &amp; Cake"   OK
 *
 * Every other risky character (backslash, quote, angle brackets, percent, and a
 * leading @ or ?) is rejected outright by validAppName rather than escaped here.
 */
function escapeForResource(value) {
  return value.replace(/'/g, "\\'");
}

function validVersionCode(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2_100_000_000) {
    fail('versionCode must be an integer between 1 and 2100000000');
  }
  return value;
}

function validVersionName(value) {
  if (typeof value !== 'string' || !/^[0-9]+(\.[0-9]+){0,3}(-[a-z0-9.]+)?$/i.test(value)) {
    fail('versionName must look like 1.0.0 or 1.0.0-beta1');
  }
  return value;
}

const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

function validHost(value) {
  if (typeof value !== 'string') fail('allowedHosts entries must be strings');
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (host.length > 253 || !HOSTNAME.test(host)) {
    fail(`"${value}" is not a valid hostname`);
  }
  return host;
}

function validStartUrl(value, allowCleartext) {
  if (typeof value !== 'string') fail('startUrl must be a string');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`startUrl "${value}" is not a valid URL`);
  }
  if (url.protocol !== 'https:' && !(allowCleartext && url.protocol === 'http:')) {
    fail(
      `startUrl must be https (got ${url.protocol}). Set allowCleartextTraffic ` +
        'only if the customer site genuinely cannot serve TLS.'
    );
  }
  if (!url.hostname || !HOSTNAME.test(url.hostname.toLowerCase())) {
    fail(`startUrl host "${url.hostname}" is not a valid hostname`);
  }
  return url.toString();
}

function validExistingFile(path, field) {
  if (typeof path !== 'string' || path.length === 0) fail(`${field} must be a path`);
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    fail(`${field} does not point at an existing file: ${abs}`);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Spec -> normalised build inputs
// ---------------------------------------------------------------------------

function normaliseSpec(raw) {
  if (!raw || typeof raw !== 'object') fail('spec must be a JSON object');

  const allowCleartext = bool(raw.allowCleartextTraffic, false);
  const splash = raw.splash ?? {};

  const spec = {
    appId: typeof raw.appId === 'string' && raw.appId.trim() ? raw.appId.trim() : fail('appId is required'),
    applicationId: validApplicationId(raw.applicationId),
    appName: validAppName(raw.appName),
    versionCode: validVersionCode(raw.versionCode),
    versionName: validVersionName(raw.versionName ?? '1.0.0'),
    allowCleartextTraffic: allowCleartext,

    startUrl: validStartUrl(raw.startUrl, allowCleartext),
    allowedHosts: (Array.isArray(raw.allowedHosts) ? raw.allowedHosts : []).map(validHost),
    allowSubdomains: bool(raw.allowSubdomains, true),

    display: normaliseDisplay(raw.display),
    splash: normaliseSplash(raw.splash),
    behavior: normaliseBehavior(raw.behavior),
    remoteConfig: normaliseRemoteConfig(raw.remoteConfig),

    iconBackgroundColor: validColor(
      raw.iconBackgroundColor ?? splash.backgroundColor ?? '#FFFFFF',
      'iconBackgroundColor'
    ),

    icons: {},
    signing: null,
  };

  // Fall back to the start URL's own host so a spec that forgets allowedHosts
  // produces an app locked to its own origin rather than an open browser.
  if (spec.allowedHosts.length === 0) {
    spec.allowedHosts = [new URL(spec.startUrl).hostname.toLowerCase()];
  }

  if (raw.icons && typeof raw.icons === 'object') {
    for (const density of DENSITIES) {
      const entry = raw.icons[density];
      if (entry === undefined) continue;
      spec.icons[density] = {
        launcher: validExistingFile(entry.launcher ?? entry, `icons.${density}.launcher`),
        round: entry.round ? validExistingFile(entry.round, `icons.${density}.round`) : null,
        foreground: entry.foreground
          ? validExistingFile(entry.foreground, `icons.${density}.foreground`)
          : null,
      };
    }
  }

  if (raw.signing) {
    const s = raw.signing;
    if (typeof s.keyAlias !== 'string' || !/^[\w.\-]{1,64}$/.test(s.keyAlias)) {
      fail('signing.keyAlias must be 1-64 word characters');
    }
    if (typeof s.storePassword !== 'string' || s.storePassword.length === 0) {
      fail('signing.storePassword is required');
    }
    if (typeof s.keyPassword !== 'string' || s.keyPassword.length === 0) {
      fail('signing.keyPassword is required');
    }
    spec.signing = {
      storeFile: validExistingFile(s.storeFile, 'signing.storeFile'),
      storePassword: s.storePassword,
      keyPassword: s.keyPassword,
      keyAlias: s.keyAlias,
    };
  }

  return spec;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['build', '.gradle', '.git', 'node_modules']);

function materialiseSandbox(spec) {
  const sandbox = mkdtempSync(join(tmpdir(), 'servbiz-build-'));

  cpSync(TEMPLATE_ROOT, sandbox, {
    recursive: true,
    filter: (src) => !SKIP_DIRS.has(basename(src)),
  });

  writeConfigJson(sandbox, spec);
  writeIcons(sandbox, spec);
  stripUnusedPermissions(sandbox, spec);

  return sandbox;
}

function writeConfigJson(sandbox, spec) {
  // Mirrors AppConfig.kt. The `buildTime` block is the set of fields remote
  // config is structurally unable to override.
  const config = {
    configVersion: 1,
    appId: spec.appId,
    buildTime: {
      startUrl: spec.startUrl,
      allowedHosts: spec.allowedHosts,
      allowSubdomains: spec.allowSubdomains,
    },
    display: spec.display,
    splash: spec.splash,
    behavior: spec.behavior,
    remoteConfig: spec.remoteConfig,
  };

  writeFileSync(
    join(sandbox, 'app', 'src', 'main', 'assets', 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8'
  );
}

function writeIcons(sandbox, spec) {
  for (const [density, files] of Object.entries(spec.icons)) {
    const dir = join(sandbox, 'app', 'src', 'main', 'res', `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    cpSync(files.launcher, join(dir, 'ic_launcher.png'));
    cpSync(files.round ?? files.launcher, join(dir, 'ic_launcher_round.png'));
    if (files.foreground) {
      cpSync(files.foreground, join(dir, 'ic_launcher_foreground.png'));
    }
  }
}

/**
 * Removes <uses-permission> lines for capabilities this app has not enabled.
 *
 * Runtime config already gates these, but an app that never uses the camera
 * should not ask for the permission at all -- users read the permission list,
 * and shipping a blanket set across every generated app is the kind of thing
 * that makes a product look untrustworthy.
 */
function stripUnusedPermissions(sandbox, spec) {
  const path = join(sandbox, 'app', 'src', 'main', 'AndroidManifest.xml');
  let xml = readFileSync(path, 'utf8');

  const drop = [];
  if (!spec.behavior.allowCamera) {
    drop.push('android.permission.CAMERA');
  }
  if (!spec.behavior.allowMicrophone) {
    drop.push('android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS');
  }
  if (!spec.behavior.allowGeolocation) {
    drop.push(
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION'
    );
  }
  if (!spec.behavior.handleDownloads) {
    drop.push('android.permission.WRITE_EXTERNAL_STORAGE');
  }

  for (const permission of drop) {
    // Matches both the single-line form and the multi-line form used for
    // WRITE_EXTERNAL_STORAGE (which carries android:maxSdkVersion).
    const pattern = new RegExp(
      `[ \\t]*<uses-permission\\b[^>]*?${permission.replace(/\./g, '\\.')}\\b[\\s\\S]*?/>\\s*\\n`,
      'g'
    );
    const before = xml;
    xml = xml.replace(pattern, '');
    if (xml === before) {
      throw new Error(
        `Permission stripper did not match ${permission}. AndroidManifest.xml ` +
          'was reformatted -- update the regex in tools/build-app.mjs.'
      );
    }
  }

  writeFileSync(path, xml, 'utf8');
  return drop;
}

// ---------------------------------------------------------------------------
// Gradle
// ---------------------------------------------------------------------------

function gradleArgs(spec) {
  return [
    ':app:assembleRelease',
    `-Pservbiz.applicationId=${spec.applicationId}`,
    `-Pservbiz.appName=${escapeForResource(spec.appName)}`,
    `-Pservbiz.versionCode=${spec.versionCode}`,
    `-Pservbiz.versionName=${spec.versionName}`,
    `-Pservbiz.allowCleartextTraffic=${spec.allowCleartextTraffic}`,
    `-Pservbiz.splashBackgroundColor=${spec.splash.backgroundColor}`,
    `-Pservbiz.iconBackgroundColor=${spec.iconBackgroundColor}`,
    '--no-daemon',
    '--console=plain',
    '--stacktrace',
  ];
}

function runGradle(sandbox, spec) {
  const wrapper = join(sandbox, 'gradlew');
  const useWrapper = existsSync(wrapper);
  const command = useWrapper ? wrapper : 'gradle';

  const args = gradleArgs(spec);
  if (process.env.SERVBIZ_GRADLE_OFFLINE === '1') args.push('--offline');

  // execFileSync with an argv array: no shell is spawned, so nothing in the
  // spec can be interpreted as a command even if validation were bypassed.
  execFileSync(command, args, {
    cwd: sandbox,
    stdio: 'inherit',
    env: {
      ...process.env,
      JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8',
    },
    timeout: Number(process.env.SERVBIZ_BUILD_TIMEOUT_MS ?? 15 * 60 * 1000),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main() {
  const specPath = arg('--spec');
  const outDir = arg('--out');
  const dryRun = process.argv.includes('--dry-run');
  const keepSandbox = process.argv.includes('--keep-sandbox');

  if (!specPath || !outDir) {
    console.error(
      'usage: build-app.mjs --spec <spec.json> --out <dir> [--dry-run] [--keep-sandbox]'
    );
    process.exit(2);
  }

  let spec;
  try {
    spec = normaliseSpec(JSON.parse(readFileSync(resolve(specPath), 'utf8')));
  } catch (e) {
    console.error(e instanceof SpecError ? `Invalid spec: ${e.message}` : e);
    process.exit(1);
  }

  let sandbox;
  let signingPath;

  try {
    sandbox = materialiseSandbox(spec);
    signingPath = join(sandbox, 'signing.properties');

    if (spec.signing) {
      // Written as a file rather than passed as argv so the passwords never
      // appear in the process table.
      writeFileSync(
        signingPath,
        [
          `storeFile=${spec.signing.storeFile}`,
          `storePassword=${spec.signing.storePassword}`,
          `keyAlias=${spec.signing.keyAlias}`,
          `keyPassword=${spec.signing.keyPassword}`,
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o600 }
      );
    } else {
      console.warn(
        'WARNING: no signing block in spec. The release APK will be unsigned ' +
          'and will not install on any device.'
      );
    }

    console.log(`app        ${spec.appName} (${spec.applicationId})`);
    console.log(`version    ${spec.versionName} (${spec.versionCode})`);
    console.log(`start url  ${spec.startUrl}`);
    console.log(`hosts      ${spec.allowedHosts.join(', ')}`);
    console.log(`sandbox    ${sandbox}`);

    if (dryRun) {
      console.log('\n--dry-run: sandbox prepared, Gradle skipped.');
      console.log(`Inspect it at ${sandbox}`);
      return;
    }

    runGradle(sandbox, spec);

    const built = join(
      sandbox, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'
    );
    if (!existsSync(built)) {
      throw new Error(`Gradle reported success but ${built} is missing`);
    }

    mkdirSync(resolve(outDir), { recursive: true });
    const target = join(
      resolve(outDir),
      `${spec.applicationId}-${spec.versionName}-${spec.versionCode}.apk`
    );
    cpSync(built, target);

    console.log(`\nAPK: ${target}`);
    console.log(`size: ${(statSync(target).size / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    // Signing material must not outlive the build, even when it failed.
    if (signingPath) rmSync(signingPath, { force: true });
    if (sandbox && !keepSandbox && !dryRun) {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
}

main();
