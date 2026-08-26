#!/bin/bash
# Builds a throwaway shell APK for a URL, installs it on a connected phone, and
# streams the logs that matter.
#
# Purpose: verify a real payment flow (Razorpay / UPI) end to end. An emulator
# cannot do this -- no emulator image ships PhonePe, GPay or Paytm, so the
# bounce out to a payment app and the deep link back are untestable there.
#
# Usage:
#   ./tools/device-test.sh --url https://yoursite.servbiz.in/pricing
#   ./tools/device-test.sh --url https://... --name "Payment Test" --keep
#
# The keystore is generated fresh into a temp dir and thrown away unless --keep
# is passed. This app is disposable; do not reuse its key for anything real.

set -euo pipefail

URL=""
APP_NAME="Servbiz Device Test"
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --url)  URL="$2"; shift 2 ;;
    --name) APP_NAME="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$URL" ]; then
  echo "usage: $0 --url https://your-site/page [--name \"App Name\"] [--keep]" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# ---------------------------------------------------------------------------
# Toolchain
# ---------------------------------------------------------------------------

: "${ANDROID_HOME:=/opt/homebrew/share/android-commandlinetools}"
export ANDROID_HOME
if [ ! -d "$ANDROID_HOME" ]; then
  echo "ANDROID_HOME does not exist: $ANDROID_HOME" >&2
  echo "Set it to your Android SDK, e.g. export ANDROID_HOME=~/Library/Android/sdk" >&2
  exit 1
fi

if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/libexec/java_home ]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 17)"
fi
export JAVA_HOME
ADB="$ANDROID_HOME/platform-tools/adb"

# ---------------------------------------------------------------------------
# Device
# ---------------------------------------------------------------------------

echo "==> looking for a connected device"
"$ADB" start-server > /dev/null 2>&1 || true
DEVICES="$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')"

if [ -z "$DEVICES" ]; then
  cat >&2 <<'EOF'
No device found. On the phone:
  1. Settings > About phone > tap "Build number" seven times
  2. Settings > System > Developer options > enable "USB debugging"
  3. Connect by USB, then accept the "Allow USB debugging?" prompt
Then re-run this script.
EOF
  exit 1
fi

COUNT="$(echo "$DEVICES" | wc -l | tr -d ' ')"
if [ "$COUNT" != "1" ]; then
  echo "More than one device attached; disconnect the others:" >&2
  echo "$DEVICES" >&2
  exit 1
fi

SERIAL="$DEVICES"
case "$SERIAL" in
  emulator-*)
    echo "WARNING: $SERIAL is an emulator." >&2
    echo "The payment flow cannot be tested here -- no payment apps are installed." >&2
    echo "Connect a physical phone with your UPI/payment app on it." >&2
    exit 1
    ;;
esac

MODEL="$("$ADB" -s "$SERIAL" shell getprop ro.product.model | tr -d '\r')"
RELEASE="$("$ADB" -s "$SERIAL" shell getprop ro.build.version.release | tr -d '\r')"
echo "    $MODEL, Android $RELEASE ($SERIAL)"

echo "==> payment apps present on the device"
"$ADB" -s "$SERIAL" shell pm list packages 2>/dev/null \
  | grep -iE "phonepe|google.android.apps.nbu.paisa|paytm|bhim|amazon|cred|mobikwik" \
  | sed 's/^package:/    /' || echo "    (none detected -- a UPI handoff will have nothing to open)"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

WORK="$(mktemp -d "${TMPDIR:-/tmp}/servbiz-devicetest.XXXXXX")"
cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "kept: $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

echo "==> generating a throwaway keystore"
PW="$(openssl rand -hex 24)"
printf '%s' "$PW" > "$WORK/pw"
chmod 600 "$WORK/pw"
"$JAVA_HOME/bin/keytool" -genkeypair -keystore "$WORK/t.jks" -alias t \
  -keyalg RSA -keysize 4096 -validity 3650 \
  -storepass "$PW" -keypass "$PW" \
  -dname "CN=Servbiz Device Test, O=Servbiz, C=IN" 2>/dev/null

echo "==> building"
URL="$URL" APP_NAME="$APP_NAME" WORK="$WORK" node - <<'NODE'
const fs = require('node:fs');
const url = new URL(process.env.URL);
if (url.protocol !== 'https:') {
  console.error(`startUrl must be https, got ${url.protocol}`);
  process.exit(1);
}
const work = process.env.WORK;
const pw = fs.readFileSync(`${work}/pw`, 'utf8');
fs.writeFileSync(`${work}/spec.json`, JSON.stringify({
  appId: 'device-test',
  applicationId: 'com.servbiz.app.devicetest',
  appName: process.env.APP_NAME,
  versionCode: 1,
  versionName: '0.1.0',
  startUrl: url.toString(),
  // Payment flows redirect across the PSP's own hosts, so the checkout domains
  // have to be in-app too or the user gets bounced to a browser mid-payment.
  allowedHosts: [
    url.hostname,
    'razorpay.com',
    'rzp.io',
    'payments.razorpay.com',
    'api.razorpay.com',
  ],
  allowSubdomains: true,
  display: { orientation: 'unspecified', themeColor: '#0F172A',
             backgroundColor: '#FFFFFF', lightStatusBarIcons: true },
  splash: { backgroundColor: '#0F172A', showLogo: true, maxWaitMs: 10000 },
  behavior: {
    pullToRefresh: true, externalLinksInBrowser: true,
    userAgentSuffix: 'ServbizApp/1.0 DeviceTest',
    allowFileUploads: true, allowGeolocation: false,
    allowCamera: false, allowMicrophone: false,
    allowMixedContent: false, confirmExitOnBack: false,
    openPopupsInApp: true, handleDownloads: true,
  },
  remoteConfig: { enabled: false, url: null, timeoutMs: 2500 },
  iconBackgroundColor: '#0F172A',
  signing: { storeFile: `${work}/t.jks`, storePassword: pw,
             keyPassword: pw, keyAlias: 't' },
}, null, 2));
NODE

node tools/build-app.mjs --spec "$WORK/spec.json" --out "$WORK/out" \
  | grep -E "^app |^start url|^hosts|^APK:|^size:"

# Glob into an array rather than parsing ls, so a TMPDIR containing a space
# cannot silently produce a truncated path.
shopt -s nullglob
APKS=("$WORK"/out/*.apk)
shopt -u nullglob
[ ${#APKS[@]} -gt 0 ] || { echo "build produced no APK" >&2; exit 1; }
APK="${APKS[0]}"

echo "==> installing on $MODEL"
"$ADB" -s "$SERIAL" uninstall com.servbiz.app.devicetest > /dev/null 2>&1 || true
"$ADB" -s "$SERIAL" install "$APK" | tail -1

echo "==> launching"
"$ADB" -s "$SERIAL" logcat -c
"$ADB" -s "$SERIAL" shell am start -n \
  com.servbiz.app.devicetest/com.servbiz.appshell.MainActivity > /dev/null

cat <<'EOF'

────────────────────────────────────────────────────────────────────
  Now on the phone: go through a real payment.

  Watch for these lines below:
    nav upi://...      -> EXTERNAL_INTENT     link was recognised
    Handed upi: off to an external app        payment app opened
    No activity found to handle scheme        no app installed for it

  WHAT TO REPORT BACK
    1. Did the payment app actually open?
    2. Did you get back into the app afterwards?
    3. Did the site show the payment as successful?
    4. Paste anything below marked FATAL or "No activity found".

  Ctrl-C when you are done.
────────────────────────────────────────────────────────────────────

EOF

exec "$ADB" -s "$SERIAL" logcat -v brief \
  AppWebViewClient:D ExternalLauncher:D MainActivity:D ConfigStore:D \
  AndroidRuntime:E ActivityManager:W chromium:E "*:S"
