// ============================================================
// Turns a validated spec into a complete Xcode project on disk.
//
// Pure filesystem work -- no Xcode, no network, no macOS. That is what lets the
// Xcode-project delivery run on a free Linux runner, and it is also what makes
// this module testable: worker.mjs --selftest renders a project and inspects it
// without a Mac anywhere in sight.
//
// The one rule here: every value that reaches a template goes through an escaper
// appropriate to where it lands. A hostname in a Swift string literal, an app
// name in XML, and a product name in a pbxproj have three different sets of
// characters that end the surrounding token, and the spec validator alone is not
// a substitute for escaping at the point of use.
// ============================================================
import { promises as fs } from 'node:fs'
import path from 'node:path'

// ------------------------------------------------------------
// Escaping
// ------------------------------------------------------------

/** For a Swift "..." literal. */
const swiftString = (value) =>
  String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

/** For XML text content. */
const xml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/**
 * A target name the pbxproj and the filesystem both tolerate.
 *
 * Xcode's PRODUCT_NAME becomes the executable name, so it cannot contain spaces,
 * slashes or quotes. The customer's real name is not lost -- it goes in
 * CFBundleDisplayName, which is what actually appears under the icon.
 */
export const productName = (appName) => {
  const safe = String(appName)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(0, 40)
  return safe || 'App'
}

// ------------------------------------------------------------
// Spec to template values
// ------------------------------------------------------------

const STATUS_BAR_STYLE = {
  default: '.default',
  light: '.lightContent',
  dark: '.darkContent',
}

const ORIENTATION_MASK = {
  all: '.allButUpsideDown',
  portrait: '.portrait',
  landscape: '.landscape',
}

// iPhone omits upside-down: Apple's own apps do not offer it and a phone-shaped
// site rotated 180 degrees is never what anyone wanted. iPad includes it,
// because an iPad has no natural "up".
const ORIENTATIONS = {
  iphone: {
    all: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    portrait: ['UIInterfaceOrientationPortrait'],
    landscape: ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  },
  ipad: {
    all: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    portrait: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown'],
    landscape: ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  },
}

/**
 * The NS*UsageDescription keys for whatever was switched on.
 *
 * The strings matter more than they look. This text is what iOS shows in the
 * permission prompt, and App Review rejects a description that does not say what
 * the app does with the data -- "needs camera access" is not enough.
 */
function usageDescriptions(spec) {
  const name = spec.appName
  const entries = []

  if (spec.behavior.allowCamera) {
    entries.push(['NSCameraUsageDescription',
      `${name} uses the camera when you take a photo or scan a code.`])
  }
  if (spec.behavior.allowMicrophone) {
    entries.push(['NSMicrophoneUsageDescription',
      `${name} uses the microphone when you record audio or make a call.`])
  }
  if (spec.behavior.allowGeolocation) {
    entries.push(['NSLocationWhenInUseUsageDescription',
      `${name} uses your location to show nearby places and delivery options.`])
  }
  if (spec.behavior.allowPhotoLibrary) {
    entries.push(['NSPhotoLibraryUsageDescription',
      `${name} needs access to your photos so you can attach them.`])
    // Separate key, and separate prompt. Without it, "save this image" fails
    // silently on a site that offers it.
    entries.push(['NSPhotoLibraryAddUsageDescription',
      `${name} saves images to your photo library when you choose to.`])
  }

  if (!entries.length) return ''
  return entries
    .map(([key, text]) => `\t<key>${key}</key>\n\t<string>${xml(text)}</string>`)
    .join('\n') + '\n'
}

function plistOrientations(spec, device) {
  return ORIENTATIONS[device][spec.display.orientation]
    .map((o) => `\t\t<string>${o}</string>`)
    .join('\n') + '\n'
}

/** Every {{TOKEN}} the templates can contain, and nothing else. */
export function templateValues(spec) {
  return {
    PRODUCT_NAME: productName(spec.appName),
    DISPLAY_NAME: xml(spec.appName),
    BUNDLE_ID: spec.bundleId,
    MARKETING_VERSION: spec.marketingVersion,
    BUILD_VERSION: String(spec.versionCode),
    // Empty is valid and means "no team". Correct for the Xcode-project
    // delivery: the customer's own Xcode fills it in from their Apple ID, and a
    // stale team id baked in here would fail to sign on their machine.
    TEAM_ID: spec.teamId ?? '',
    DEVICE_FAMILY: spec.display.tabletSupport ? '1,2' : '1',

    START_URL: swiftString(spec.startUrl),
    ALLOWED_HOSTS: spec.allowedHosts.map((h) => `"${swiftString(h)}"`).join(', '),
    EXTERNAL_LINKS_IN_BROWSER: String(spec.behavior.externalLinksInBrowser),

    THEME_COLOR: spec.display.themeColor,
    BACKGROUND_COLOR: spec.display.backgroundColor,
    SPLASH_COLOR: spec.splash.backgroundColor,
    SHOW_LOGO: String(spec.splash.showLogo),
    // Swift wants seconds as a TimeInterval; the spec carries milliseconds.
    SPLASH_MAX_WAIT: (spec.splash.maxWaitMs / 1000).toFixed(1),

    STATUS_BAR_STYLE: STATUS_BAR_STYLE[spec.display.statusBarStyle],
    HIDE_STATUS_BAR: String(spec.display.hideStatusBar),
    HIDE_STATUS_BAR_PLIST: spec.display.hideStatusBar ? 'true' : 'false',
    RESPECT_SAFE_AREA: String(spec.display.respectSafeArea),
    ORIENTATION_MASK: ORIENTATION_MASK[spec.display.orientation],
    ORIENTATIONS_IPHONE: plistOrientations(spec, 'iphone'),
    ORIENTATIONS_IPAD: plistOrientations(spec, 'ipad'),

    PULL_TO_REFRESH: String(spec.behavior.pullToRefresh),
    SWIPE_NAVIGATION: String(spec.behavior.swipeNavigation),
    INLINE_MEDIA: String(spec.behavior.inlineMedia),
    ALLOWS_LINK_PREVIEW: String(spec.display.allowsLinkPreview),
    KEEP_SCREEN_ON: String(spec.behavior.keepScreenOn),

    USAGE_DESCRIPTIONS: usageDescriptions(spec),
    ENCRYPTION_EXEMPT_PLIST: spec.encryptionExempt ? 'false' : 'true',
  }
}

/**
 * Substitutes {{TOKEN}} and refuses to leave any behind.
 *
 * An unreplaced token is a hard error, not a warning. `{{TEAM_ID}}` surviving
 * into a pbxproj produces a project that opens and then fails to sign with a
 * message naming neither the token nor the template; a missing value in Swift
 * produces a compile error on a macOS runner minutes later. Both are far cheaper
 * to catch here.
 *
 * ENCRYPTION_EXEMPT_PLIST reads inverted on purpose: the plist key is
 * ITSAppUsesNonExemptEncryption, so "exempt" means the key is false.
 */
export function fill(template, values) {
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, token) => {
    if (!(token in values)) {
      throw new Error(`Template uses {{${token}}}, which the spec does not provide.`)
    }
    return values[token]
  })

  const leftover = out.match(/\{\{[A-Z0-9_]+\}\}/g)
  if (leftover) throw new Error(`Unreplaced tokens: ${[...new Set(leftover)].join(', ')}`)
  return out
}

// ------------------------------------------------------------
// Asset catalog
// ------------------------------------------------------------

/**
 * The single-size App Icon entry Xcode 14+ uses.
 *
 * Modern Xcode takes one 1024x1024 image and derives every other size at build
 * time, which is why the API requires a 1024 upload. The old nineteen-entry
 * appiconset still works but means nineteen files to write and keep correct, for
 * an identical result.
 */
const APP_ICON_CONTENTS = {
  images: [{ filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
  info: { author: 'servbiz', version: 1 },
}

const LAUNCH_LOGO_CONTENTS = {
  images: [
    { filename: 'LaunchLogo.png', idiom: 'universal', scale: '1x' },
    { idiom: 'universal', scale: '2x' },
    { idiom: 'universal', scale: '3x' },
  ],
  info: { author: 'servbiz', version: 1 },
}

/** #RRGGBB as the float components an Xcode colorset wants. */
function colourSet(hex) {
  const n = parseInt(hex.slice(1), 16)
  const component = (v) => (v / 255).toFixed(3)
  return {
    colors: [{
      color: {
        'color-space': 'srgb',
        components: {
          alpha: '1.000',
          blue: component(n & 0xff),
          green: component((n >> 8) & 0xff),
          red: component((n >> 16) & 0xff),
        },
      },
      idiom: 'universal',
    }],
    info: { author: 'servbiz', version: 1 },
  }
}

const json = (value) => JSON.stringify(value, null, 2) + '\n'

// ------------------------------------------------------------
// Render
// ------------------------------------------------------------

/**
 * Writes the whole project into `outDir`.
 *
 * @param {object}  spec        from parseSpec
 * @param {string}  templateDir the template/ directory
 * @param {string}  outDir      created if absent; must be empty
 * @param {Buffer?} iconPng     the customer's 1024px icon, already flattened
 * @returns {Promise<{projectDir: string, productName: string, files: string[]}>}
 */
export async function renderProject({ spec, templateDir, outDir, iconPng = null }) {
  const values = templateValues(spec)
  const name = values.PRODUCT_NAME
  const written = []

  const write = async (relative, contents) => {
    const target = path.join(outDir, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, contents)
    written.push(relative)
  }

  const template = async (relative) =>
    fs.readFile(path.join(templateDir, relative), 'utf8')

  // -- the project file --
  await write(
    `${name}.xcodeproj/project.pbxproj`,
    fill(await template('project.pbxproj.tmpl'), values)
  )

  // Makes Xcode open the project rather than offering a scheme-less window on
  // first launch. Without it the customer has to pick a scheme by hand, which
  // reads as a broken project.
  await write(
    `${name}.xcodeproj/xcshareddata/xcschemes/${name}.xcscheme`,
    fill(await template('scheme.xcscheme.tmpl'), values)
  )

  // -- sources --
  await write('Sources/AppDelegate.swift', await template('Sources/AppDelegate.swift'))
  await write('Sources/WebViewController.swift', await template('Sources/WebViewController.swift'))
  await write('Sources/Config.swift', fill(await template('Sources/Config.swift.tmpl'), values))

  // -- resources --
  await write('Resources/Info.plist', fill(await template('Resources/Info.plist.tmpl'), values))
  await write('Resources/Assets.xcassets/Contents.json', json({ info: { author: 'servbiz', version: 1 } }))
  await write('Resources/Assets.xcassets/AppIcon.appiconset/Contents.json', json(APP_ICON_CONTENTS))
  await write(
    'Resources/Assets.xcassets/LaunchBackground.colorset/Contents.json',
    json(colourSet(spec.splash.backgroundColor))
  )

  if (iconPng) {
    await write('Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png', iconPng)
    // The launch logo reuses the icon rather than being a second upload. The
    // alternative is asking for two images to show the same logo twice.
    if (spec.splash.showLogo) {
      await write('Resources/Assets.xcassets/LaunchLogo.imageset/Contents.json', json(LAUNCH_LOGO_CONTENTS))
      await write('Resources/Assets.xcassets/LaunchLogo.imageset/LaunchLogo.png', iconPng)
    }
  }

  // -- for the customer, on the project path only --
  if (spec.delivery === 'xcode-project') {
    await write('README.md', fill(await template('README.md.tmpl'), values))
  }

  return { projectDir: outDir, productName: name, files: written }
}
