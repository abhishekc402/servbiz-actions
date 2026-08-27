#!/usr/bin/env node
/**
 * Turns one customer-supplied square PNG into the launcher icons an APK needs.
 *
 * Produces, per density, the three files both build-app.mjs and patch-app.mjs
 * accept:
 *
 *   ic_launcher.png             legacy square icon, full bleed
 *   ic_launcher_round.png       legacy round icon, circle-masked
 *   ic_launcher_foreground.png  adaptive foreground, logo inset into the safe zone
 *
 * and prints a JSON manifest of their paths on stdout, shaped exactly like the
 * `icons` field of a build spec or a patch, so the worker can pass it straight
 * through without knowing any of this.
 *
 * ON THE TWO LEGACY FILES
 *   A transparent upload gets composited onto the icon background colour for the
 *   legacy files, because pre-API-26 launchers draw the PNG directly with no
 *   background layer -- a transparent logo would otherwise appear to float on
 *   whatever the launcher's wallpaper is. The adaptive foreground keeps its
 *   transparency, since there the background is a separate layer.
 *
 * Usage:
 *   node tools/make-icons.mjs --source icon.png --out /path/to/dir
 *   node tools/make-icons.mjs --source icon.png --out dir --background '#0F172A'
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  decodePng,
  encodePng,
  resizeRgba,
  solid,
  over,
  insetInto,
  circleMask,
  hexToRgb,
  DENSITIES,
  ADAPTIVE_SAFE_FRACTION,
} from './lib/png.mjs';

// A logo smaller than the largest icon we must emit would be upscaled, which looks
// worse than anything else this tool can do. 432px is the xxxhdpi adaptive size.
const MIN_SOURCE = 432;

function fail(message) {
  console.error(`make-icons: ${message}`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

function main() {
  const sourcePath = arg('--source');
  const outDir = arg('--out');
  const background = arg('--background') ?? '#FFFFFF';

  if (!sourcePath || !outDir) {
    fail('usage: make-icons.mjs --source <icon.png> --out <dir> [--background #RRGGBB]');
  }

  let source;
  try {
    source = decodePng(readFileSync(resolve(sourcePath)));
  } catch (e) {
    fail(`could not read the source icon: ${e.message}`);
  }

  if (source.width !== source.height) {
    fail(`source icon must be square, got ${source.width}x${source.height}`);
  }
  if (source.width < MIN_SOURCE) {
    fail(`source icon must be at least ${MIN_SOURCE}px, got ${source.width}px`);
  }

  let bg;
  try {
    bg = hexToRgb(background);
  } catch (e) {
    fail(e.message);
  }

  const manifest = {};
  for (const { dir, legacy, adaptive } of DENSITIES) {
    const densityKey = dir.replace('mipmap-', '');
    const target = join(resolve(outDir), dir);
    mkdirSync(target, { recursive: true });

    // Legacy square: flattened onto the background so a transparent logo is not
    // left floating on an old launcher.
    const flat = resizeRgba(source.rgba, source.width, source.height, legacy, legacy);
    const square = over(solid(legacy, legacy, bg), flat);
    const squarePath = join(target, 'ic_launcher.png');
    writeFileSync(squarePath, encodePng({ width: legacy, height: legacy, rgba: square }));

    // Legacy round: the same pixels, circle-masked. Re-flattened from a fresh copy
    // so the mask does not eat into the already-composited square above.
    const roundBase = over(
      solid(legacy, legacy, bg),
      resizeRgba(source.rgba, source.width, source.height, legacy, legacy)
    );
    const round = circleMask(roundBase, legacy);
    const roundPath = join(target, 'ic_launcher_round.png');
    writeFileSync(roundPath, encodePng({ width: legacy, height: legacy, rgba: round }));

    // Adaptive foreground: transparent, logo confined to the safe zone so the
    // launcher's mask cannot clip it.
    const foreground = insetInto(
      source.rgba, source.width, source.height, adaptive, ADAPTIVE_SAFE_FRACTION
    );
    const foregroundPath = join(target, 'ic_launcher_foreground.png');
    writeFileSync(
      foregroundPath,
      encodePng({ width: adaptive, height: adaptive, rgba: foreground })
    );

    manifest[densityKey] = {
      launcher: squarePath,
      round: roundPath,
      foreground: foregroundPath,
    };
  }

  // stdout is the manifest and nothing else, so a caller can parse it directly.
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main();
