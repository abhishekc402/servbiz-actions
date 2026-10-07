// ============================================================
// Validates a build spec before anything is written from it.
//
// Mirrors server/iosApps.js#sanitizeIosConfig in servbiz-main. That is the third
// copy of these rules -- the browser form, the API, and here -- and the
// duplication is deliberate: this one is the only copy that runs on the machine
// that writes a customer's Info.plist and Swift source, and it cannot trust the
// other two to have run.
//
// If you change a field here, change it in server/iosApps.js too. The comment
// there says the same thing in the other direction.
// ============================================================

export const DELIVERY_MODES = ['xcode-project', 'ipa']

const HEX = /^#[0-9A-Fa-f]{6}$/
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/

class SpecError extends Error {}

const fail = (message) => { throw new SpecError(message) }

const colour = (value, fallback) =>
  (typeof value === 'string' && HEX.test(value) ? value.toUpperCase() : fallback)

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)

/**
 * A validated, fully defaulted spec.
 *
 * Every field gets a value, so the renderer never has to ask whether something is
 * present. A template that interpolates `undefined` produces Swift that does not
 * compile, and finding that out from a compiler error three minutes into a macOS
 * runner is the expensive way to learn a field was missing.
 */
export function parseSpec(input = {}) {
  const app = input.app ?? {}
  const build = input.build ?? {}
  const config = app.config ?? {}
  const display = config.display ?? {}
  const splash = config.splash ?? {}
  const behavior = config.behavior ?? {}

  // -- identity, none of which has a safe default --

  const bundleId = String(app.application_id ?? '')
  // Underscore first, same ordering as validateBundleId in servbiz-main: the
  // general pattern would reject it with a message that does not name the actual
  // problem, and an Android-style package id is the likeliest wrong input.
  if (bundleId.includes('_')) fail('Bundle id cannot contain underscores.')
  if (!BUNDLE_ID.test(bundleId)) fail(`Invalid bundle id: ${JSON.stringify(bundleId)}`)

  const appName = String(app.app_name ?? '').trim()
  if (!appName) fail('App name is required.')
  if (appName.length > 50) fail('App name is too long.')

  let startUrl
  try {
    startUrl = new URL(String(app.start_url))
  } catch {
    fail(`Invalid start URL: ${JSON.stringify(app.start_url)}`)
  }
  // Re-checked rather than assumed. This value is interpolated into Swift and
  // becomes the only page the app will ever open; a cleartext URL would also make
  // the app need an ATS exception, which is an App Review rejection.
  if (startUrl.protocol !== 'https:') fail('Start URL must be https.')

  const hosts = Array.isArray(app.allowed_hosts) && app.allowed_hosts.length
    ? app.allowed_hosts
    : [startUrl.hostname]

  const allowedHosts = [...new Set(
    hosts
      .map((h) => String(h).trim().toLowerCase())
      // A host containing a quote or a backslash would terminate the Swift string
      // literal it is about to be written into. Dropped rather than escaped:
      // nothing legitimate contains one, so escaping would only preserve an
      // attempt at injection in a readable form.
      .filter((h) => h && /^[a-z0-9.-]+$/.test(h) && h.includes('.'))
  )]
  if (!allowedHosts.length) fail('No usable allowed hosts.')

  // -- delivery --

  const delivery = pick(
    build.delivery ?? config.delivery,
    DELIVERY_MODES,
    'xcode-project'
  )

  // CFBundleVersion. Allocated by the database, never computed here -- two
  // builds computing "current + 1" would collide and App Store Connect would
  // reject the second upload.
  const versionCode = Number.isInteger(build.version_code) && build.version_code > 0
    ? build.version_code
    : 1
  const marketingVersion = /^[0-9]+(\.[0-9]+){0,2}$/.test(String(app.version_name ?? ''))
    ? String(app.version_name)
    : '1.0.0'

  return {
    delivery,
    artifactKind: delivery === 'ipa' ? 'ipa' : 'xcode-project',

    bundleId,
    appName,
    startUrl: startUrl.toString(),
    allowedHosts,
    marketingVersion,
    versionCode,

    display: {
      themeColor: colour(display.themeColor, '#3B6FE0'),
      backgroundColor: colour(display.backgroundColor, '#FFFFFF'),
      statusBarStyle: pick(display.statusBarStyle, ['default', 'light', 'dark'], 'default'),
      orientation: pick(
        display.orientation === 'unspecified' ? 'all' : display.orientation,
        ['all', 'portrait', 'landscape'],
        'all'
      ),
      hideStatusBar: bool(display.hideStatusBar, false),
      respectSafeArea: bool(display.respectSafeArea, true),
      allowsLinkPreview: bool(display.allowsLinkPreview, false),
      tabletSupport: bool(display.tabletSupport, true),
    },

    splash: {
      backgroundColor: colour(splash.backgroundColor, '#FFFFFF'),
      showLogo: bool(splash.showLogo, true),
      maxWaitMs: Math.min(Math.max(Math.trunc(Number(splash.maxWaitMs)) || 10000, 1000), 30000),
    },

    behavior: {
      pullToRefresh: bool(behavior.pullToRefresh, true),
      externalLinksInBrowser: bool(behavior.externalLinksInBrowser, true),
      swipeNavigation: bool(behavior.swipeNavigation, true),
      inlineMedia: bool(behavior.inlineMedia, true),
      keepScreenOn: bool(behavior.keepScreenOn, false),
      allowCamera: bool(behavior.allowCamera, false),
      allowMicrophone: bool(behavior.allowMicrophone, false),
      allowGeolocation: bool(behavior.allowGeolocation, false),
      allowPhotoLibrary: bool(behavior.allowPhotoLibrary, false),
      allowFileUploads: bool(behavior.allowFileUploads, true),
      handleDownloads: bool(behavior.handleDownloads, true),
    },

    // Apple rejects an icon with an alpha channel, so the uploaded PNG is always
    // flattened onto a colour. White when the customer chose none.
    iconBackgroundColor: colour(config.iconBackgroundColor, '#FFFFFF'),
    encryptionExempt: bool(config.encryptionExempt, true),
    // The ServBiz badge for apps made with a free credit. From the job, which
    // servbiz-main fills from mobile_apps.watermark on every build; the row is
    // the fallback for a job queued before the field existed. Never from
    // app.config, which is the customer's own settings.
    watermark: (build.watermark ?? app.watermark) === true,
  }
}

export { SpecError }
