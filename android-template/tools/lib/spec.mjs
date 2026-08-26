/**
 * Validation and normalisation shared by build-app.mjs (Gradle path) and
 * patch-app.mjs (fast path).
 *
 * Shared on purpose. These rules are the input boundary for values that arrive
 * from a customer-facing form and end up in a build script, a generated XML
 * resource and an app manifest. Two copies would drift, and the copy that drifted
 * would be the one with the hole in it.
 */

export class SpecError extends Error {}

export const fail = (msg) => {
  throw new SpecError(msg);
};

// --- primitives ------------------------------------------------------------

export function bool(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail('expected a boolean');
  return value;
}

export function validColor(value, field) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    fail(`${field} must be a #RRGGBB hex colour, got ${JSON.stringify(value)}`);
  }
  return value.toUpperCase();
}

export function validEnum(value, allowed, field, fallback) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) fail(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}

export function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];

/**
 * Capability flags that decide which <uses-permission> entries the manifest
 * carries. build-app.mjs strips the ones an app has not enabled.
 *
 * This is why they can only ever be turned OFF by a patch: the permission simply
 * is not in the shipped manifest, so flipping a flag on in config.json would
 * produce an app that asks for a capability it can never be granted, and fails
 * at runtime with no useful explanation.
 */
export const PERMISSION_FLAGS = [
  'allowCamera',
  'allowMicrophone',
  'allowGeolocation',
  'handleDownloads',
];

// --- cosmetic sections (patchable) -----------------------------------------

export function normaliseDisplay(display = {}) {
  return {
    fullscreen: bool(display.fullscreen, false),
    orientation: validEnum(
      display.orientation,
      ['unspecified', 'portrait', 'landscape'],
      'display.orientation',
      'unspecified'
    ),
    themeColor: validColor(display.themeColor ?? '#0F172A', 'display.themeColor'),
    backgroundColor: validColor(display.backgroundColor ?? '#FFFFFF', 'display.backgroundColor'),
    lightStatusBarIcons: bool(display.lightStatusBarIcons, true),
  };
}

export function normaliseSplash(splash = {}) {
  return {
    backgroundColor: validColor(splash.backgroundColor ?? '#FFFFFF', 'splash.backgroundColor'),
    showLogo: bool(splash.showLogo, true),
    maxWaitMs: clampInt(splash.maxWaitMs, 1000, 30000, 10000),
  };
}

export function normaliseBehavior(behavior = {}) {
  return {
    pullToRefresh: bool(behavior.pullToRefresh, true),
    externalLinksInBrowser: bool(behavior.externalLinksInBrowser, true),
    userAgentSuffix:
      typeof behavior.userAgentSuffix === 'string' &&
      /^[\w.\-/ ]{0,64}$/.test(behavior.userAgentSuffix)
        ? behavior.userAgentSuffix
        : 'ServbizApp/1.0',
    allowFileUploads: bool(behavior.allowFileUploads, true),
    allowGeolocation: bool(behavior.allowGeolocation, false),
    allowCamera: bool(behavior.allowCamera, false),
    allowMicrophone: bool(behavior.allowMicrophone, false),
    allowMixedContent: bool(behavior.allowMixedContent, false),
    // Defaults false so Android 13+ predictive back keeps working; an
    // always-enabled back callback suppresses the system animation.
    confirmExitOnBack: bool(behavior.confirmExitOnBack, false),
    openPopupsInApp: bool(behavior.openPopupsInApp, true),
    handleDownloads: bool(behavior.handleDownloads, true),
  };
}

export function normaliseRemoteConfig(remote = {}) {
  const enabled = bool(remote.enabled, false);
  let url = null;

  if (enabled) {
    if (typeof remote.url !== 'string') fail('remoteConfig.url is required when enabled');
    let parsed;
    try {
      parsed = new URL(remote.url);
    } catch {
      fail(`remoteConfig.url "${remote.url}" is not a valid URL`);
    }
    if (parsed.protocol !== 'https:') fail('remoteConfig.url must be https');
    url = parsed.toString();
  }

  return { enabled, url, timeoutMs: clampInt(remote.timeoutMs, 500, 10000, 2500) };
}
