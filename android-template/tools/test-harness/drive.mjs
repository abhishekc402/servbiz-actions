#!/usr/bin/env node
/**
 * Drives the shell through the WebView paths that break in practice, on a
 * connected device or emulator.
 *
 * Taps are computed from the layout the harness page reports (see /layout in
 * server.mjs) rather than guessed from a screenshot, so this stays correct if
 * the page reflows or the device resolution changes.
 *
 * Prerequisites:
 *   1. tools/test-harness/server.mjs running on the host
 *   2. a test APK installed and pointed at http://10.0.2.2:8099
 *   3. adb on PATH or ANDROID_HOME set
 *
 * Usage:
 *   node tools/test-harness/drive.mjs
 *   node tools/test-harness/drive.mjs --pkg com.servbiz.app.rt --shots /tmp/shots
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, '.state');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

const PKG = argOf('--pkg', 'com.servbiz.app.rt');
const ACTIVITY = `${PKG}/com.servbiz.appshell.MainActivity`;
const SHOTS = argOf('--shots', '/tmp/shots');
const ADB = process.env.ANDROID_HOME
  ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb')
  : 'adb';

mkdirSync(SHOTS, { recursive: true });

// --- adb helpers -----------------------------------------------------------

const adb = (...args) =>
  execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * Runs an adb shell command, tolerating a non-zero exit status.
 *
 * Necessary because almost every useful probe here ends in `grep`, and grep exits
 * 1 when it matches nothing -- which is a normal, expected outcome, not an error.
 */
const shell = (cmd) => {
  try {
    return adb('shell', cmd);
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const screenshot = (name) => {
  const buf = execFileSync(ADB, ['exec-out', 'screencap', '-p'], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'buffer',
  });
  writeFileSync(join(SHOTS, `${name}.png`), buf);
};

/**
 * Fetches a dumpsys section whole and filters on this side.
 *
 * Deliberately not `dumpsys ... | grep` inside adb shell. grep exits as soon as
 * it has what it needs, dumpsys then fails writing to a closed pipe, and the
 * output arrives truncated -- intermittently, and only under load. That produced
 * two false failures in this suite: a splash that looked like it never went away
 * and a WebView that looked like it had vanished, both against a perfectly
 * healthy app.
 */
const dump = (section) => shell(`dumpsys ${section}`);

const firstLineMatching = (text, re) =>
  text.split('\n').find((line) => re.test(line)) ?? '';

/**
 * Whatever currently owns the screen.
 *
 * mCurrentFocus rather than topResumedActivity because it also reflects dialogs
 * and the system file chooser, which is what several scenarios need to detect.
 */
const foreground = () => {
  const focus = firstLineMatching(dump('window'), /mCurrentFocus/);
  const m = focus.match(/\s(\S+\/\S+)\}/);
  if (m) return m[1];

  const resumed = firstLineMatching(dump('activity activities'), /topResumedActivity/);
  const fallback = (resumed.match(/u0 (\S+\/\S+)/) ?? [])[1];
  return fallback ?? (focus.trim() || '(unknown)');
};

const inForeground = () => foreground().startsWith(PKG);

/**
 * Log reading is scoped by device timestamp, not by clearing the buffer.
 *
 * `logcat -c` does not reliably empty every ring on Android 15, so assertions
 * that read the whole buffer were matching entries from earlier runs. That is
 * worse than a flake: a stale line makes a check pass for something that never
 * happened, which is exactly what "upi handoff verified" did on one run.
 *
 * markLog() captures the device clock; readLog() only considers lines at or
 * after that instant.
 */
let logMark = null;

const markLog = () => {
  adb('logcat', '-c');
  logMark = shell('date +"%m-%d %H:%M:%S.000"').trim();
  return logMark;
};

const clearLog = () => markLog();

const readLog = (pattern) => {
  const args = ['logcat', '-d', '-v', 'brief'];
  if (logMark) args.push('-T', logMark);
  let out;
  try {
    out = adb(...args);
  } catch {
    // -T is rejected by some builds if the mark is malformed; fall back rather
    // than failing the whole scenario.
    out = adb('logcat', '-d', '-v', 'brief');
  }
  return out
    .split('\n')
    .filter((l) => pattern.test(l))
    .join('\n');
};

// --- harness state ---------------------------------------------------------

const readJson = (f, fallback) => {
  const p = join(STATE, f);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};

const results = () => readJson('results.json', []);
const layout = () => readJson('layout.json', null);

const reportedSince = (mark) => results().slice(mark);
const hasReport = (mark, name) => reportedSince(mark).some((r) => r.name === name && r.pass);

// --- tapping ---------------------------------------------------------------

let scale = null;
let topInset = 63;

function calibrate() {
  const l = layout();
  if (!l) throw new Error('no layout.json - is the harness page loaded in the app?');

  // Physical width from the device, CSS width from the page. devicePixelRatio is
  // not usable here: useWideViewPort makes the CSS viewport and the physical
  // width disagree (421 CSS px reported at dpr 2.625 on a 1080px screen).
  const size = shell('wm size');
  const physW = Number((size.match(/(\d+)x(\d+)/) ?? [])[1]);
  scale = physW / l.innerWidth;

  // The WebView starts below the status bar because the root applies insets as
  // padding. Read the real offset out of the view hierarchy rather than assuming.
  const dump = shell('dumpsys activity top | grep -m1 "app:id/refresh"');
  const m = dump.match(/(\d+),(\d+)-(\d+),(\d+)/);
  if (m) topInset = Number(m[2]);

  console.log(
    `calibrated: device ${size.trim().split(': ')[1]}, css ${l.innerWidth}x${l.innerHeight}, ` +
      `scale ${scale.toFixed(4)}, webview top ${topInset}px\n`
  );
  return l;
}

/**
 * Taps an element by id.
 *
 * Deliberately refuses to scroll. An earlier version swiped the element into view
 * and then assumed the scroll had landed exactly where asked, which silently
 * mis-tapped and produced confusing failures. The harness page is instead sized
 * to fit one viewport, and anything off-screen is a loud error.
 */
async function tap(id) {
  const l = layout();
  const el = l.elements[id];
  if (!el) throw new Error(`element ${id} not present in layout.json`);
  if (el.y + el.h / 2 > l.innerHeight) {
    throw new Error(
      `element ${id} is below the fold (y=${el.y}, viewport=${l.innerHeight}). ` +
        'Make the harness page shorter rather than scrolling.'
    );
  }

  const x = Math.round(el.x * scale);
  const y = Math.round(topInset + el.y * scale);
  shell(`input tap ${x} ${y}`);
  return { x, y };
}

const back = () => shell('input keyevent KEYCODE_BACK');

/**
 * Polls a predicate instead of sleeping a guessed interval.
 *
 * Fixed sleeps made this suite flaky in exactly the places that matter: a cold
 * Chrome start on an emulator takes well over 4s, and a logcat line can land a
 * beat after the tap. Both produced failures for behaviour that was correct.
 */
async function waitFor(predicate, { timeoutMs = 12000, everyMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = await predicate();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
}

/**
 * True once the shell has dropped its splash overlay, which it does on first
 * content paint. Read from the live view hierarchy: the flag column after the
 * view hash is V for visible and G for gone.
 */
/**
 * The visible UI of the focused window, as XML.
 *
 * Replaces `dumpsys activity top`, which turned out to be the wrong tool: it
 * dumps a list of tasks chosen by the system, and our app was frequently absent
 * from it entirely once other apps had tasks lying around. That made
 * "is the splash gone" unanswerable and stalled the whole suite.
 *
 * uiautomator reports only NODES THAT ARE VISIBLE, which is a better signal
 * anyway: a GONE overlay simply is not in the tree, so there are no view flag
 * columns to parse.
 */
const STUB_PKG = 'com.servbiz.upistub';

/** Whether the stub payment app is installed (it enables two scenarios). */
const stubInstalled = () => dump(`package ${STUB_PKG}`).includes(STUB_PKG);

/**
 * Reads the stub's log lines, scoped to its current process.
 *
 * The stub is force-stopped before each scenario, so a fresh pid guarantees the
 * lines belong to this run. Necessary because timestamp filtering alone let a
 * line from twenty minutes earlier satisfy "the UPI handoff worked" -- a check
 * that passed while proving nothing, which is worse than one that fails.
 */
const stubLog = (pattern) => {
  const pid = shell(`pidof ${STUB_PKG}`).trim().split(/\s+/)[0];
  if (!/^\d+$/.test(pid)) return '';
  let out;
  try {
    out = adb('logcat', '-d', '-v', 'brief', `--pid=${pid}`);
  } catch {
    return '';
  }
  return out.split('\n').filter((l) => pattern.test(l)).join('\n');
};

const resetStub = () => shell(`am force-stop ${STUB_PKG}`);

const uiDump = () => {
  // uiautomator legitimately fails mid-transition with a null root node. Returning
  // an empty string on failure lets the surrounding waitFor retry, rather than
  // treating a failed dump as "the view is not there".
  const result = shell('uiautomator dump /sdcard/servbiz-ui.xml 2>&1');
  if (!/dumped to/i.test(result)) return '';
  return shell('cat /sdcard/servbiz-ui.xml');
};

/**
 * Keyed on :id/refresh (the SwipeRefreshLayout wrapping the WebView) rather than
 * on :id/webView itself.
 *
 * The WebView drops out of the accessibility tree once it has navigated -- the
 * node is simply absent even though the view is alive and rendering. Asserting on
 * it produced a suite that believed the splash never lifted and the WebView had
 * vanished. Its parent container is always reported, so it is the stable anchor.
 */
const shellUiPresent = () => uiDump().includes(':id/refresh');

const splashGone = () => {
  const xml = uiDump();
  // Positive evidence of the shell UI as well as absence of the splash, so a
  // failed or empty dump cannot read as success.
  return xml.includes(':id/refresh') && !xml.includes(':id/splashOverlay');
};

async function reloadApp() {
  shell(`am force-stop ${PKG}`);
  await sleep(600);
  const before = layout()?.at ?? null;
  shell(`am start -n ${ACTIVITY}`);

  // Three separate conditions, because each one alone is insufficient:
  //   - a fresh layout report means the page parsed and measured
  //   - splash GONE means the WebView actually painted
  //   - foreground means no dialog stole focus
  //
  // Waiting only for the layout report is not enough. The page's script runs
  // before the WebView has composited, and taps dispatched in that window are
  // silently dropped -- which produced a suite where almost every interaction
  // "failed" against code that was working correctly.
  const ready = await waitFor(() => {
    const l = layout();
    return Boolean(l) && l.at !== before && inForeground() && splashGone();
  }, { timeoutMs: 25000 });

  if (!ready) {
    throw new Error(
      `app not interactive after launch (layout=${Boolean(layout())}, ` +
        `fg=${foreground()}, splashGone=${splashGone()})`
    );
  }
  await sleep(900);
}

// --- assertions ------------------------------------------------------------

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
};

const noCrash = (label) => {
  const crash = readLog(/FATAL EXCEPTION|AndroidRuntime: FATAL|Process crashed/);
  check(`${label}: no crash`, crash === '', crash.split('\n')[0] ?? '');
};

// --- scenarios -------------------------------------------------------------

/** Waits for a named harness report to arrive after `mark`. */
const awaitReport = (mark, name, timeoutMs = 10000) =>
  waitFor(() => hasReport(mark, name), { timeoutMs });

/** Waits for a logcat line to appear. */
const awaitLog = (pattern, timeoutMs = 8000) =>
  waitFor(() => (readLog(pattern) === '' ? false : readLog(pattern)), { timeoutMs });

/**
 * Waits for a *named* other app to take the screen.
 *
 * Requires a real package/activity pair. An earlier version accepted anything
 * that was not our own package, which meant the transient `mCurrentFocus=null`
 * during a window transition satisfied "handed off to another app" -- a check
 * that passed without proving anything.
 */
const awaitHandoff = (timeoutMs = 15000) =>
  waitFor(() => {
    const fg = foreground();
    const looksLikeComponent = /^[\w.]+\/[\w.]+$/.test(fg) && fg.includes('.');
    return looksLikeComponent && !fg.startsWith(PKG) ? fg : false;
  }, { timeoutMs });

async function scenarioSameHostAndBack() {
  console.log('\n--- same-host navigation + hardware back ---');
  await reloadApp();
  clearLog();
  let mark = results().length;

  await tap('sameHost');
  check('nav: same-host link loaded in-app', await awaitReport(mark, 'nav:secondPageReached'));
  check('nav: stayed inside the app', inForeground(), foreground());
  screenshot('02-second-page');

  back();
  const backHome = await waitFor(() => inForeground());
  check('back: returned to the app, did not exit', backHome, foreground());
  check('back: shell UI intact, not a blank window',
        await waitFor(() => shellUiPresent()));
  screenshot('03-after-back');
  noCrash('same-host');
}

async function scenarioErrorPageAndRetry() {
  console.log('\n--- main-frame 5xx -> bundled error page -> retry ---');
  await reloadApp();
  clearLog();
  const l = layout();

  await tap('boom');
  // Matches both log sites: onReceivedError ("Main frame failed: code=") and
  // onReceivedHttpError ("Main frame HTTP error: 500").
  const errLog = await awaitLog(/Main frame (failed|HTTP error)/);
  check('error: main-frame 5xx detected', errLog !== false,
        String(errLog).split('\n')[0] ?? '(no log line)');
  check('error: still in the app', inForeground(), foreground());
  screenshot('04-error-page');
  noCrash('error-page');

  // The bundled error page is not measured by the harness, so its retry button
  // is located by proportion: full-width, centred, a little past mid-viewport.
  //
  // The log is cleared first so the assertion cannot be satisfied by the failure
  // that produced this page in the first place -- it has to be a fresh request.
  clearLog();
  const x = Math.round((l.innerWidth / 2) * scale);
  const y = Math.round(topInset + l.innerHeight * 0.62 * scale);
  shell(`input tap ${x} ${y}`);

  // Retry re-requests the URL that failed, so a second 500 is the expected proof
  // that the servbiz-shell://retry sentinel produced a real navigation.
  const retried = await awaitLog(/Main frame HTTP error: 500/, 12000);
  check('retry: sentinel re-requested the failed URL', retried !== false,
        String(retried).split('\n')[0]?.trim() ?? '(no fresh error line)');
  screenshot('05-after-retry');
  noCrash('retry');
}

async function scenarioIntentHandoff() {
  console.log('\n--- intent handoff ---');

  // tel: has a real handler on the emulator (the dialer), so this proves the
  // whole handoff mechanism, which is the same code path a UPI app would take.
  await reloadApp();
  clearLog();
  await tap('tel');
  const telFg = await awaitHandoff();
  check('intent tel: handed to another app', telFg !== false, String(telFg));
  screenshot('06-tel-handoff');
  noCrash('tel');
  back();
  await waitFor(() => inForeground(), { timeoutMs: 8000 });

  // Graceful degradation when nothing can handle upi:. Only meaningful without
  // the stub installed -- with it, the correct behaviour is a successful handoff,
  // which scenarioUpiHandoff covers instead.
  if (stubInstalled()) {
    console.log('  (skipping the no-handler case: upi-stub is installed)');
  } else {
    await reloadApp();
    clearLog();
    await tap('upi');
    const upiLog = await awaitLog(/No activity found to handle scheme: upi/);
    check('intent upi: missing handler logged, not silent', upiLog !== false,
          String(upiLog).split('\n')[0] ?? '(no ExternalLauncher log)');
    check('intent upi: app survived and stayed foreground', inForeground(), foreground());
    screenshot('07-upi-no-handler');
    noCrash('upi');
  }

  // intent: with an uninstallable package plus a browser_fallback_url on our own
  // host. Should land back IN the WebView, not in an external browser.
  await reloadApp();
  clearLog();
  const mark = results().length;
  await tap('intentFallback');
  const reached = await awaitReport(mark, 'intent:browserFallbackUrl', 12000);
  check('intent: browser_fallback_url honoured', reached,
        String(await awaitLog(/browser_fallback_url/, 1000)).split('\n')[0] ?? '');
  check('intent: fallback kept in-app (session preserved)', inForeground(), foreground());
  screenshot('08-intent-fallback');
  noCrash('intent-fallback');
}

/**
 * The intent-scheme redirect attack.
 *
 * Requires the upi-stub app to be installed: the harness link names its
 * non-exported PrivateActivity explicitly, which is exactly what an unsanitised
 * Intent.parseUri result would launch. buildSafeIntent strips the component and
 * forces CATEGORY_BROWSABLE, so it must resolve by scheme to the stub's public
 * activity instead.
 */
async function scenarioIntentHijack() {
  console.log('\n--- intent-scheme redirect attack (needs upi-stub installed) ---');

  if (!stubInstalled()) {
    console.log('  (skipped: install tools/test-harness/upi-stub first)');
    return;
  }

  resetStub();
  await reloadApp();
  clearLog();
  await tap('intentHijack');
  await waitFor(() => stubLog(/LAUNCHED/) || false, { timeoutMs: 10000 });

  check('hijack: private component was NOT invoked',
        stubLog(/PRIVATE ACTIVITY REACHED/) === '',
        stubLog(/PRIVATE ACTIVITY REACHED/).split('\n')[0] ?? '');

  const landed = stubLog(/URI /);
  check('hijack: component stripped, resolved by scheme instead',
        /upi:\/\//.test(landed), landed.split('\n')[0]?.trim() ?? '(stub never launched)');

  const cats = stubLog(/CATEGORIES/);
  check('hijack: CATEGORY_BROWSABLE was forced on',
        /BROWSABLE/.test(cats), cats.split('\n')[0]?.trim() ?? '');

  // 0x10000000 is FLAG_ACTIVITY_NEW_TASK alone. Any URI-permission grant bits
  // here would mean page content could hand out access to content providers.
  const flags = stubLog(/FLAGS/);
  check('hijack: no URI-permission grant flags leaked',
        /FLAGS 0x10000000\b/.test(flags), flags.split('\n')[0]?.trim() ?? '');

  screenshot('16-intent-hijack');
  noCrash('intent-hijack');
}

/** Verifies a real upi:// handoff against the stub payment app. */
async function scenarioUpiHandoff() {
  console.log('\n--- upi:// handoff to an installed handler (needs upi-stub) ---');

  if (!stubInstalled()) {
    console.log('  (skipped: install tools/test-harness/upi-stub first)');
    return;
  }

  resetStub();
  await reloadApp();
  clearLog();
  await tap('upi');
  const fg = await awaitHandoff();
  check('upi: handed to the payment app', String(fg).includes('upistub'), String(fg));

  // The parameters are the point. A handoff that opens the payment app with a
  // mangled amount or payee is worse than one that fails outright.
  const required = await waitFor(() => stubLog(/REQUIRED/) || false, { timeoutMs: 8000 });
  check('upi: pa/pn/am/cu all arrived intact',
        /pa=test@upi pn=Test am=1\.00 cu=INR/.test(String(required)),
        String(required).split('\n')[0]?.trim() ?? '(no REQUIRED line)');

  screenshot('17-upi-handoff');
  noCrash('upi-handoff');
}

async function scenarioPopup() {
  console.log('\n--- target=_blank popup ---');
  await reloadApp();
  clearLog();
  const mark = results().length;
  await tap('popup');
  check('popup: target=_blank resolved', await awaitReport(mark, 'nav:secondPageReached'));
  check('popup: handled in-app', inForeground(), foreground());
  screenshot('09-popup');
  noCrash('popup');
}

async function scenarioOffHost() {
  console.log('\n--- off-host link -> external browser ---');
  await reloadApp();
  clearLog();
  await tap('offHost');

  // A cold Chrome start on an emulator regularly takes 6-10s, so this polls
  // rather than sampling once.
  const fg = await awaitHandoff(20000);
  check('offhost: left the app for a browser', fg !== false, String(fg));
  check('offhost: handoff was logged',
        (await awaitLog(/Opened an off-host link in the browser/, 2000)) !== false);
  screenshot('10-offhost');
  noCrash('offhost');
  shell('am force-stop com.android.chrome');
  await waitFor(() => inForeground(), { timeoutMs: 8000 });
}

async function scenarioFileChooser() {
  console.log('\n--- file chooser (opens, and cancelling does not wedge it) ---');
  await reloadApp();
  clearLog();

  await tap('fAny');
  const fg1 = await awaitHandoff();
  check('upload: chooser opened', fg1 !== false, String(fg1));
  screenshot('11-chooser-1');

  back();
  check('upload: back from chooser returned to the app',
        await waitFor(() => inForeground()), foreground());

  // The activity regaining focus does not mean the WebView is accepting touches
  // again; taps in that window are dropped. Verified manually: with a generous
  // settle the chooser reopens every time.
  await sleep(2500);

  // The regression that matters: a cancelled chooser must resolve its callback.
  // If it does not, the file input is permanently dead for the rest of the
  // session and the second tap does nothing at all.
  await tap('fAny');
  const fg2 = await awaitHandoff();
  check('upload: chooser opens AGAIN after cancel', fg2 !== false, String(fg2));
  screenshot('12-chooser-2');
  back();
  await waitFor(() => inForeground(), { timeoutMs: 8000 });
  noCrash('file-chooser');
}

async function scenarioDownload() {
  console.log('\n--- download via DownloadManager ---');
  await reloadApp();
  clearLog();
  shell('rm -f /sdcard/Download/shell-test*.pdf');

  await tap('dl');

  // Size, not just existence. DownloadManager creates the file before it writes
  // to it, so checking only for the filename passes on a 0-byte placeholder --
  // observed happening, which would have hidden a genuinely broken download.
  const landed = await waitFor(() => {
    const size = shell('stat -c %s /sdcard/Download/shell-test.pdf').trim();
    return /^\d+$/.test(size) && Number(size) > 0 ? size : false;
  }, { timeoutMs: 20000 });

  const listing = shell('ls -la /sdcard/Download/');
  check('download: file landed with real content', landed !== false,
        `${landed || 0} bytes :: ${listing.split('\n').filter((l) => /pdf/.test(l)).join(' | ').trim()}`);
  screenshot('13-download');
  noCrash('download');
}

async function scenarioGeolocation() {
  console.log('\n--- geolocation permission bridge ---');
  shell(`pm revoke ${PKG} android.permission.ACCESS_FINE_LOCATION`);
  shell(`pm revoke ${PKG} android.permission.ACCESS_COARSE_LOCATION`);
  await reloadApp();
  clearLog();

  const secure = results().filter((r) => r.name === 'secureContext').pop();
  const isSecure = secure?.pass === true;
  check('geo: harness is a secure context (required by Chromium)', isSecure,
        secure?.detail ?? '(not reported)');

  if (!isSecure) {
    // Chromium blocks the Geolocation API outright on insecure origins, before
    // onGeolocationPermissionsShowPrompt is ever called. Asserting anything about
    // the app's bridge here would be testing the browser engine, not the shell.
    console.log('  (skipping the permission bridge: needs a trustworthy origin)');
    return;
  }

  const mark = results().length;
  await tap('geo');
  const prompt = await waitFor(() => {
    const fg = foreground();
    return /GrantPermissions|PermissionDialog|permissioncontroller/i.test(fg) ? fg : false;
  }, { timeoutMs: 10000 });
  check('geo: OS permission prompt shown', prompt !== false, String(prompt || foreground()));
  screenshot('14-geo-prompt');

  if (prompt !== false) {
    shell(`pm grant ${PKG} android.permission.ACCESS_FINE_LOCATION`);
    shell(`pm grant ${PKG} android.permission.ACCESS_COARSE_LOCATION`);
    back();
    await waitFor(() => inForeground(), { timeoutMs: 8000 });
  }

  const granted = shell(`dumpsys package ${PKG} | grep ACCESS_FINE_LOCATION`);
  check('geo: permission survived manifest stripping',
        /ACCESS_FINE_LOCATION/.test(granted), granted.trim().split('\n')[0] ?? '');
  screenshot('15-geo-result');
  noCrash('geolocation');
}

// --- main ------------------------------------------------------------------

async function main() {
  console.log(`driving ${PKG} via ${ADB}\n`);
  await reloadApp();
  calibrate();

  await scenarioSameHostAndBack();
  await scenarioErrorPageAndRetry();
  await scenarioPopup();
  await scenarioIntentHandoff();
  await scenarioUpiHandoff();
  await scenarioIntentHijack();
  await scenarioOffHost();
  await scenarioFileChooser();
  await scenarioDownload();
  await scenarioGeolocation();

  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed}/${checks.length} checks passed`);
  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    console.log('\nfailures:');
    for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
  }
  console.log(`screenshots in ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`\ndriver error: ${e.message}`);
  process.exit(2);
});
