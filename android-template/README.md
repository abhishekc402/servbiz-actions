# Servbiz Android app shell

Template Android project that becomes a customer's app. One Gradle build per app
at creation time; cosmetic edits afterwards are file swaps, not rebuilds.

Distribution is **direct APK download**, not Play Store. That decision drives
three things: v2 signing is mandatory, keystores are the permanent app identity
with no Play App Signing safety net, and output is an APK rather than an AAB.

## Layout

```
android-template/
  app/src/main/
    AndroidManifest.xml          permissions are stripped per app at build time
    assets/config.json           all runtime config; the fast-patch swap target
    assets/offline.html          bundled error page, served over the asset domain
    java/com/servbiz/appshell/
      AppConfig.kt               config model + the remote-override boundary
      ConfigStore.kt             bundled -> cached-remote -> fresh-remote layering
      RemoteConfigFetcher.kt     background fetch, never blocks first paint
      UrlRules.kt                navigation policy (host allow-list, schemes)
      ExternalLauncher.kt        intent handoff, UPI/tel/mailto, downloads
      AppWebViewClient.kt        errors, first-paint signal, TLS policy
      MainActivity.kt            WebView setup, uploads, permissions, back, splash
  tools/
    lib/spec.mjs                 validation shared by both build paths
    generate-icons.mjs           placeholder launcher icons (no deps)
    build-app.mjs                spec -> signed APK          (Gradle, ~50-90s)
    patch-app.mjs                APK + patch -> signed APK   (no Gradle, ~1s)
    test-spec-validation.mjs
    example-spec.json
    device-test.sh               one command: build + install on a real phone
    keystore.mjs                 per-app keystores, envelope-encrypted
    worker.mjs                   drains the build queue
    storage.mjs                  artifact storage (R2 / S3-compatible / local)
    check-connectivity.mjs       read-only preflight, safe against production
    test-worker.mjs              worker end-to-end, real builds
    test-harness/                emulator suite (39 checks)
    test-harness/upi-stub/       stand-in UPI app, so the payment handoff is
                                 testable without a phone or real money
```

## What varies per app, and how

| Change | Path | Measured |
| --- | --- | --- |
| Colours, splash, behaviour flags, icons | `patch-app.mjs` | **0.9s** |
| App name, package id, permission set, version, start URL | `build-app.mjs` | 50-90s warm |
| Cosmetics on **already-installed** apps | remote config endpoint | no APK at all |

The Kotlin `namespace` is fixed at `com.servbiz.appshell` while `applicationId`
varies. No source file is ever rewritten per app.

### What the patch path cannot change, and why

| Field | Reason |
| --- | --- |
| `appName`, `iconBackgroundColor` | compiled into `resources.arsc` |
| `applicationId`, `versionCode`, `versionName`, cleartext flag | compiled into the binary `AndroidManifest.xml` |
| `startUrl`, `allowedHosts`, `allowSubdomains` | deliberately build-time only, so a compromised config channel cannot repoint installed apps |
| capability flags turning **on** | the `<uses-permission>` was stripped at build time, so the app could never be granted it. Turning them **off** is fine. |

Each of these is rejected with a message pointing at `build-app.mjs` rather than
silently producing an APK that does not match the request.

Two consequences worth knowing:

- **`versionCode` does not move on the patch path.** It lives in the compiled
  manifest. A patched APK installs cleanly over its base anyway (equal
  `versionCode` is a reinstall, not a downgrade — verified on device), so for
  direct download this is a non-issue. `config.json` carries an incrementing
  `buildNumber` instead, which is what an in-app update check should compare.
- **`splash.backgroundColor` is only half-patchable.** The in-app splash overlay
  picks it up immediately; the brief system splash window on Android 12+ is drawn
  from a compiled colour before any app code runs, so those two can drift until
  the next rebuild. The tool warns when a patch changes it.

### Why `android.enableResourceOptimizations=false`

AGP's resource optimiser rewrites `res/` paths to short opaque names —
`res/mipmap-xxhdpi-v4/ic_launcher.png` becomes `res/-B.png` — which makes it
impossible to swap an icon by path in a release APK. With the flag off the paths
stay readable and icon changes become a 1-second patch.

Measured cost: 1,695,250 → 1,792,105 bytes, about 95 KB or 5.7%. Do not turn it
back on without moving icons to the rebuild tier.

## Build a test app

```bash
node tools/generate-icons.mjs                      # once, if icons are missing
node tools/build-app.mjs --spec tools/example-spec.json --out /tmp/out --dry-run
```

`--dry-run` materialises the sandbox and every generated file but skips Gradle,
so you can inspect exactly what a spec produces. Drop the flag to build for real.
Add `--keep-sandbox` to keep the working tree after a real build.

A spec without a `signing` block produces an unsigned APK that will not install
anywhere. That is intentional and warned about loudly.

## Patch an existing app

```bash
node tools/patch-app.mjs --base app.apk --patch patch.json --out /tmp/out
node tools/patch-app.mjs --base app.apk --patch patch.json --out /tmp/out --dry-run
```

The patch spec holds only `display`, `splash`, `behavior`, `remoteConfig`,
`icons` and `signing`; anything omitted is carried over from the base APK's own
`config.json`. Sign with the **same keystore as the base**, or the result will not
install as an update.

What it does: copy the APK, replace `assets/config.json` and the launcher PNGs
with `zip -0` (stored, matching how aapt2 writes them), `zipalign -p 4`, then
`apksigner` with v2+v3. Passwords are written to mode-0600 files and passed as
`file:` URIs so they never reach the process table. It asserts `resources.arsc` is
still `Stored` both before and after — a compressed `resources.arsc` makes an app
targeting API 30+ un-installable.

### Toolchain

The Gradle wrapper is committed and pinned to **8.9**. Do not bump it casually:
AGP 8.7.2 does not support Gradle 9.x, and Homebrew's `gradle` formula is already
past that, which is why the wrapper is pinned rather than relying on a system
install. `build-app.mjs` falls back to a system `gradle` on PATH only if the
wrapper is missing.

Requires JDK 17 and `ANDROID_HOME` pointing at an SDK with `platforms;android-35`
and `build-tools;35.0.0`.

```bash
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools   # macOS/brew
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
```

## ARM64 build hosts

Google ships `aapt2`, `zipalign`, `aidl` and `split-select` as x86_64-only
binaries. On aarch64 (Oracle Ampere A1, Graviton, Asahi, Pi) the build fails with
an exec-format error that reads like a corrupt SDK install. Replace those four
binaries with ARM64 builds and uncomment `android.aapt2FromMavenOverride` in
`gradle.properties`, pointing at the replacement.

Without that property AGP downloads its own x86_64 `aapt2` from Maven and ignores
whatever is in the SDK directory. That is the step people miss.

## Security decisions worth not undoing

**`AppConfig.buildTime` is not remotely overridable.** `startUrl` and
`allowedHosts` come only from the bundled asset. `AppConfig.merge` carries them
over verbatim and ignores those keys in a remote payload. This caps the blast
radius of a compromised config endpoint at wrong colours rather than every
installed app being redirected to a phishing page. If you ever need remote URL
changes, sign the payload (Ed25519) and bake the public key into the APK.

**Intents parsed from page content are sanitised.** `ExternalLauncher` strips
`component` and `selector` and forces `CATEGORY_BROWSABLE` before launching.
Launching a raw `Intent.parseUri` result lets any page in the WebView invoke this
app's private components with our identity.

**TLS errors are never proceeded past.** `onReceivedSslError` cancels and shows
the error page. Calling `handler.proceed()` to accommodate one staging
certificate would strip TLS from every app built off this template.

**`allowFileAccess` is off.** The bundled error page is served through
`WebViewAssetLoader` on `appassets.androidplatform.net` instead of `file://`, so
no file access is needed anywhere.

**Permissions are stripped, not just gated.** `build-app.mjs` removes
`<uses-permission>` lines for capabilities the app has not enabled, so an app
that never uses the camera does not ask for it.

**Spec values are validated allow-list style** and Gradle is invoked with an argv
array, never a shell string. Passwords go in a mode-0600 `signing.properties`
inside the sandbox, deleted in a `finally` block, so they never reach the process
table.

## WebView behaviour this template already handles

These are the defaults that break real sites when left alone:

- Non-http schemes (`upi:`, `intent:`, `tel:`, `mailto:`, `whatsapp:`) handed to
  other apps, with `browser_fallback_url` honoured. **Razorpay and UPI checkout
  fail silently without this.** The `<queries>` block in the manifest is required
  too, or Android 11+ package visibility makes resolution fail.
- `onShowFileChooser` with multi-select, MIME filtering and optional camera
  capture. Without it every file input does nothing at all.
- The file-chooser callback is resolved exactly once on every path, including
  cancellation. Missing that permanently wedges the input.
- Camera, microphone and geolocation bridged to runtime permissions, with
  geolocation refused for off-origin frames.
- `target="_blank"` via `setSupportMultipleWindows` + `onCreateWindow`.
- Third-party cookies, DOM storage, database storage: auth and payment iframes
  need them.
- Downloads handed to `DownloadManager` with the WebView's cookies attached, so
  gated invoices are not fetched as a login page.
- Hardware back mapped to WebView history, then double-tap to exit.
- Pull-to-refresh gated on `scrollY == 0` so it does not hijack mid-page scroll.
- Splash held until `onPageCommitVisible`, with a timeout backstop.
- Insets handled manually because `targetSdk 35` forces edge-to-edge on Android
  15, where `window.statusBarColor` is ignored and `adjustResize` does not lift
  content above the keyboard on its own.

## Tests

```bash
node tools/test-spec-validation.mjs      # 44 cases, no SDK needed, ~10s
./gradlew :app:testReleaseUnitTest       # 10 cases
```

### Device/emulator suite

39 checks driven over adb against a real build. This is the only suite that
catches the WebView behaviour that matters, and it found five shipping bugs that
compiled cleanly and passed every static check.

```bash
adb reverse tcp:8099 tcp:8099                  # 127.0.0.1 is a secure context
node tools/test-harness/server.mjs &           # harness on :8099
# build a test APK with startUrl http://127.0.0.1:8099/, allowCleartextTraffic

# Optional but recommended: the stub UPI app unlocks the two payment scenarios
cd tools/test-harness/upi-stub && gradle :app:assembleDebug && cd -
adb install -r tools/test-harness/upi-stub/app/build/outputs/apk/debug/app-debug.apk

node tools/test-harness/drive.mjs --shots /tmp/shots
node tools/test-harness/server.mjs --results   # raw reports + request log
```

`adb reverse` rather than the emulator's `10.0.2.2` alias is deliberate. Chromium
refuses geolocation, camera and mic on insecure origins *before* the app's
`WebChromeClient` is consulted; `http://127.0.0.1` counts as trustworthy and
`http://10.0.2.2` does not.

### The UPI stub

`tools/test-harness/upi-stub/` is a ~9 KB app that registers for `upi://` and
reports the exact URI it was handed. It exists because the highest-risk path in
the shell was otherwise untestable without hardware:

- No emulator image ships PhonePe, GPay or Paytm.
- Razorpay's **test mode never fires a UPI intent at all** — it shows a mock page,
  and [UPI Intent requires Live Mode](https://razorpay.com/docs/payments/route/plugins/woocommerce/test-integration/?preferred-country=IN).

So verifying the handoff on a real phone would need live keys and real money. The
stub covers our half of it — recognition, intent sanitisation, launch, parameter
integrity — leaving only the PSP's half (a real app paying and deep-linking back)
for hardware.

It also carries a non-exported `PrivateActivity`, which the harness tries to
invoke directly via `intent://...;component=...;end`. That is the intent-scheme
redirect attack, and it must never be reached.

`adb reverse` rather than the emulator's `10.0.2.2` alias is deliberate. Chromium
refuses geolocation, camera and mic on insecure origins *before* the app's
`WebChromeClient` is consulted; `http://127.0.0.1` counts as trustworthy and
`http://10.0.2.2` does not. Without the tunnel, those paths cannot be tested at
all over plain HTTP.

Five things to keep in mind if you extend the driver. Every one of them cost a
debugging round where correct code looked broken, or broken tests looked green:

- **Wait for the splash to go, not just for the activity.** The page reports its
  layout before the WebView has composited, and taps dispatched in that window are
  silently dropped.
- **Assert on content, not existence.** The download check passed on a 0-byte file
  DownloadManager had created but not filled; the handoff check passed on a
  transient `mCurrentFocus=null`.
- **`logcat -c` does not reliably clear the ring on Android 15.** An assertion
  reading the whole buffer matched a line from twenty minutes earlier and reported
  a UPI handoff that had not happened. Scope by device timestamp (`-T`) or, for a
  specific app, by a freshly-started pid (`--pid=`).
- **Never pipe `dumpsys` into `grep` inside `adb shell`.** grep exits early,
  dumpsys fails writing to a closed pipe, and the output truncates intermittently
  under load. Fetch whole, filter on the host.
- **`dumpsys activity top` is not a way to find one app's views.** It dumps a set
  of tasks chosen by the system, and the app under test is often absent entirely.
  Use `uiautomator dump`, which reports the focused window — but anchor on
  `:id/refresh`, not `:id/webView`, because the WebView leaves the accessibility
  tree once it has navigated even though it is alive and rendering.

`test-spec-validation.mjs` guards the input boundary: every spec value comes from
a customer-facing form and lands in a build script, a generated XML resource or
the manifest. It drives `build-app.mjs --dry-run`, so it needs no Android SDK.

`UrlRulesTest` covers host allow-listing, including the lookalike cases
(`notacme.com`, `acme.com.attacker.net`) that a naive `contains` or `endsWith`
check would wave through.

### App name escaping

Two non-obvious behaviours, both established by testing `aapt2` directly rather
than by reading docs:

- AGP's `resValue()` **does** XML-escape `&`. Pre-escaping it yields a launcher
  label that literally reads `Bob's Tea &amp; Cake`.
- AGP **does not** escape apostrophes, and `aapt2` hard-fails on a bare one
  (`error: unescaped apostrophe in string`). So `'` must be sent as `\'`.

`escapeForResource` therefore escapes apostrophes only. After changing anything
in that area, verify the bytes in the built APK rather than trusting the build to
pass:

```bash
$ANDROID_HOME/build-tools/35.0.0/aapt2 dump resources app.apk \
  | grep -A1 'string/app_name'
```

The allow-list also has to include `\p{M}`. Indic vowel signs, Arabic points and
Thai tone marks are combining marks rather than letters, so a `\p{L}`-only check
rejects every Hindi, Tamil, Bengali, Arabic and Thai business name.

## Verified on this template

Built and inspected on macOS arm64, AGP 8.7.2 / Gradle 8.9 / JDK 17 /
build-tools 35.0.0:

- `:app:assembleRelease` succeeds; 1.63 MB signed APK.
- Identity lands correctly: package `com.servbiz.app.acme_a1b2c3`, versionCode 7,
  versionName 1.2.0, targetSdk 35.
- Launcher label stored byte-exact as `Bob's Tea & Cake`, and as `चाय और केक` in
  a second build.
- Permission stripping works on the real artifact: with camera enabled and
  mic/location disabled, the APK ships INTERNET, ACCESS_NETWORK_STATE, CAMERA and
  WRITE_EXTERNAL_STORAGE (maxSdk 28) only. `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`
  is added by androidx and is expected.
- Signatures: v1 false, v2 true, v3 true. Certificate SHA-256 matches the
  generated per-app keystore. Zipalign verified.
- `assets/config.json` and `assets/offline.html` are present in the APK with the
  spec's values baked in.

### Runtime, on an Android 15 emulator (API 35, arm64, WebView 124)

34/34 device checks pass. Verified working: same-host navigation, hardware back
through WebView history, bundled error page with retry, `target=_blank`, `tel:`
handoff to the dialer, `upi:` degrading loudly with no handler installed,
`intent:` `browser_fallback_url` routed back in-app, off-host links to Chrome,
file chooser opening and re-opening after cancel, download landing on disk with
real bytes, and the geolocation permission prompt. No crashes in any scenario.

Also confirmed on the artifact: `enableOnBackInvokedCallback` accepted, insets
applied correctly (63px status/nav strips tinted `themeColor`, light icons on
dark), splash overlay going GONE on first paint, and the v2 signature accepted at
install time.

### Four bugs the emulator found that the compiler did not

1. **`loadUrl` inside `shouldOverrideUrlLoading` is dropped.** The error page's
   Try again button did nothing. Fixed by posting the load.
2. **`onPageStarted` can fire *after* `onReceivedHttpError` for the same URL**, so
   clearing `lastFailedUrl` on navigation start wiped the failure just recorded
   and Retry fell back to the start URL. Now only a different URL clears it.
3. **Re-assigning `location.href` to the same value is a no-op**, so only the
   first retry press ever worked. The sentinel now carries a counter.
4. **`hidden` does not hide SVG elements** — the UA `[hidden]` rule is scoped to
   the HTML namespace, so both error glyphs painted on top of each other. Now a
   CSS class.

Plus one design correction: `browser_fallback_url` used to be forced into an
external browser, which abandons WebView cookies mid-payment. It is now
re-classified and stays in-app when the host is ours.

### UPI handoff, verified against the stub

- `upi://pay?pa=test@upi&pn=Test&am=1.00&cu=INR` arrives at the handler **byte for
  byte**, with all four required parameters intact. A handoff that opens a payment
  app with a mangled amount or payee is worse than one that fails outright.
- `CATEGORY_BROWSABLE` is present on the delivered intent.
- Flags are `0x10000000` — `FLAG_ACTIVITY_NEW_TASK` alone, with no
  URI-permission grant bits that would let page content hand out access to
  content providers.
- The intent-scheme redirect attack is blocked: a URL naming the stub's
  non-exported `PrivateActivity` had its component stripped and resolved by scheme
  to the public activity instead. The private component was never reached.

### Still needs a physical device

Only the PSP's half: a real payment app opening, the user paying, and the deep
link back into the app. Everything on our side of that boundary is now verified.
Worth doing on hardware before a customer sees this, but it is no longer the
unknown that blocks other work.

### Patch path, verified on device

Patched a real signed APK in **0.9s** (versus 50s for the equivalent Gradle
build), replacing `config.json` plus all 15 icon files, then confirmed:

- v2+v3 signatures valid, signer certificate identical to the base.
- Identity untouched: same package, `versionCode` 1, label `Patch Test`.
- `resources.arsc` still `Stored`; archive still 4-byte aligned.
- `classes.dex` byte-identical, proving no code was disturbed.
- `config.json` carries the new values; `startUrl` unchanged.
- **Installs over the base** with equal `versionCode`, no crash on launch.
- The new `themeColor` (`#D6006E`) is live at runtime, confirmed by sampling the
  status-bar pixels; the new icon bytes match on the installed APK pulled back
  off the device.
- All three illegal patches rejected: renaming the app, enabling a stripped
  camera permission, and repointing `startUrl`.

The 34-check device suite still passes with `enableResourceOptimizations=false`.

## The worker

Drains `mobile_app_builds`. Runs on the build host, because that is the only place
the Android toolchain exists. Polls outbound, so the host needs no inbound port.

```bash
node tools/check-connectivity.mjs    # read-only preflight, safe in production
node tools/worker.mjs --once         # claim at most one job, then exit
node tools/worker.mjs                # loop
```

Schema lives in `supa migration/supabase-mobile-apps-schema.sql`.

### Artifact storage: R2, not Oracle

`storage.mjs` speaks S3 and is configured for Cloudflare R2, which this project
already uses. R2 is the better fit here than Oracle Object Storage for one
specific reason: **it charges nothing for egress**, and egress is the entire cost
profile of handing out APK downloads. Set `ARTIFACT_STORAGE=local` to run with no
object store at all, or `S3_*` for any other S3-compatible target.

Objects are stored private. Downloads should go through an endpoint that checks
the requester owns the app; an APK is a signed artifact carrying a customer's
identity, and a guessable public URL is a poor gate on it.

### Three invariants the worker holds

**It never computes `version_code`.** That comes from an atomic allocator in the
database. Two workers computing "current + 1" would both produce the same number,
and one of the resulting APKs would be uninstallable as an update.

**It never publishes an artifact it is no longer entitled to publish.** The lease
is heartbeaten throughout; a refused heartbeat means another worker took the job
over, and this one discards its output rather than racing to overwrite. Checked
before upload as well as before finish, so an abandoned build does not even leave
a stray object behind.

**Signing material exists on disk only for the seconds a build takes**, in a
mode-0700 directory removed in a `finally` on every path.

### The bug the worker test found

The heartbeat was decorative. Builds were invoked with `execFileSync`, which
blocks the event loop for the entire build, so the heartbeat timer never fired
once a build started. Any build longer than the lease would have had its job
reclaimed by another worker while it was progressing perfectly well, and two
workers would then produce competing artifacts for the same app.

The fix is `execFile` promisified and awaited. The test now forces
`heartbeatMs: 50` rather than deriving it from the lease, because deriving it made
the test depend on the build outrunning the interval — and a warm Gradle cache
finished in 11s against a 15s heartbeat, so the guard under test never engaged and
the check passed for the wrong reason.

### Verified

`node tools/test-worker.mjs` — 21 checks, real Gradle, real keystores, real
patches. Only the database is substituted (an in-memory stand-in mirroring the
RPC semantics), because the SQL itself is verified against Postgres by
`verify-mobile-apps-schema.sh` and repeating it here would mean writing test rows
into a live project.

Among the assertions: the artifact's certificate fingerprint matches the app's own
envelope, so the worker demonstrably signs with *that app's* key and not another;
a patch bumps `build_number` while leaving `version_code` untouched; and a patch
cannot repoint `startUrl`.

`node tools/check-connectivity.mjs` passes 13/13 against the live project and R2.

## Deploying the build host

See `provision/ORACLE-SETUP.md` for the full runbook. In short:

```bash
./android-template/provision/deploy.sh user@host --no-restart   # push code
ssh user@host 'cd /opt/servbiz/android-template && sudo ./provision/setup-build-host.sh'
# fill in /etc/servbiz-worker.env, then:
ssh user@host 'sudo systemctl start servbiz-worker'
```

`setup-build-host.sh` installs JDK 17, the Android SDK, Node, swap, a service user
and a hardened systemd unit. It is idempotent.

It deliberately **stops** on aarch64 rather than downloading ARM64 replacements for
`aapt2`, `zipalign`, `aidl` and `split-select` unattended. Those binaries sit in the
path that produces customer APKs, so they should be fetched and checksummed by a
human. The script prints both routes (drop-in binaries, or Box64 emulation of
Google's own) and picks the binaries up on re-run.

Redeploys afterwards are one command; `deploy.sh` excludes build output, caches and
anything that could carry a secret, and restarts the worker gracefully so a job in
flight finishes rather than being dropped.

## Not built yet

- OCI Vault as the master-key provider (currently read from the environment).
- The remote config endpoint.
- The Netlify functions: create an app, queue a build, authorise a download.
- Push notifications via FCM.
