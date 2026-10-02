#!/usr/bin/env node
// ============================================================
// Drains the iOS build queue.
//
// Claims a job, renders an Xcode project from its spec, and either zips that for
// the customer or runs xcodebuild to produce a signed .ipa. Then uploads the
// artifact and reports the outcome. Repeats until the queue is empty.
//
// ── TWO DELIVERY MODES, ONE RENDERER ──
//
//   xcode-project  render, zip, upload. No compiler, no Xcode, no macOS. Runs on
//                  ubuntu-latest, which is free on a public repository.
//   ipa            render, then xcodebuild archive + exportArchive with the
//                  customer's App Store Connect key. Needs macos-latest.
//
// The workflow picks the runner from the queue's contents before this starts;
// see ios-build.yml. A job of the wrong kind reaching the wrong runner is
// handled rather than assumed -- see requireRunnerFor below.
//
// ── WHAT THIS IS NOT ALLOWED TO DO ──
//
// Compute version_code. It comes from mobile_app_allocate_version(), one
// statement, in the database. Two builds computing "current + 1" would collide
// and App Store Connect rejects a duplicate CFBundleVersion.
//
// Publish after losing its lease. Every write goes through
// mobile_app_build_finish(), which checks claimed_by. A worker that stalled long
// enough to be reclaimed must not overwrite the artifact of the one that
// replaced it.
//
// Usage:
//   node tools/worker.mjs --drain         drain the queue (also the default)
//   node tools/worker.mjs --dry-run       claim nothing; render a sample and exit
//   node tools/worker.mjs --selftest      no network; verify the renderer
//
// Honours WORKER_ID, WORKER_BUDGET_MS and WORKER_MAX_JOBS, the same way the
// Android worker does.
// ============================================================
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

import { parseSpec, SpecError } from './lib/spec.mjs'
import { fill, renderProject, productName } from './lib/render.mjs'
import {
  flattenOntoColour, decodePng, encodePngRgb, REQUIRED_ICON_PX,
} from './lib/icons.mjs'

const run = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = path.join(HERE, '..', 'template')

// Overridable so a CI run is identifiable in the claimed_by column. Matches the
// Android worker, which is set to gha-<run_id> by its workflow -- that is what
// lets a stuck lease be traced back to the exact run that took it.
const WORKER_ID = (process.env.WORKER_ID || '').trim() || `${os.hostname()}-${process.pid}`

const LEASE_SECONDS = 1800          // a cold macOS archive is slow
const HEARTBEAT_MS = 120_000

/**
 * Stop claiming new work once this much wall time has gone.
 *
 * Set below the workflow's job timeout, so the worker finishes what it holds and
 * exits cleanly rather than being killed mid-archive. A killed worker leaves its
 * row in 'running' with a live lease, and nothing else can touch that job until
 * the lease expires -- half an hour of a customer's build sitting still for no
 * reason. Same reasoning and same env var as the Android worker.
 */
const BUDGET_MS = Number(process.env.WORKER_BUDGET_MS || 0) || 0
const MAX_JOBS = Number(process.env.WORKER_MAX_JOBS || 0) || 25
const STARTED_AT = Date.now()

const log = (...args) => console.log(`[ios-worker]`, ...args)

// ============================================================
// Environment
// ============================================================

const env = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback

function requireEnv(names) {
  const missing = names.filter((n) => !env(n))
  if (missing.length) {
    // Named explicitly. A worker that fails on a null dereference three
    // functions deep because SUPABASE_URL was blank costs an hour to diagnose.
    throw new Error(`Missing required environment: ${missing.join(', ')}`)
  }
}

// ============================================================
// Supabase (REST, no SDK)
// ============================================================
//
// Plain fetch against the REST endpoint rather than @supabase/supabase-js. The
// worker needs four RPCs and two table reads; a dependency would be 400 kB to
// save about thirty lines, in a repository whose whole job is to be auditable
// because it signs customers' apps.

async function rpc(name, body) {
  const base = env('SUPABASE_URL')
  const key = env('SUPABASE_SERVICE_ROLE_KEY')

  const response = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`rpc ${name} failed: ${response.status} ${text.slice(0, 300)}`)
  }
  return response.json()
}

async function selectOne(table, query) {
  const base = env('SUPABASE_URL')
  const key = env('SUPABASE_SERVICE_ROLE_KEY')

  const response = await fetch(`${base}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`select ${table} failed: ${response.status}`)
  }
  const rows = await response.json()
  return rows[0] ?? null
}

// ============================================================
// R2
// ============================================================
//
// SigV4 by hand, for the same reason as above: the AWS SDK is large and this
// needs PUT and GET of one object each.

async function r2Request({ method, key, body = null, contentType = null }) {
  const account = env('R2_ACCOUNT_ID')
  const bucket = env('R2_BUCKET_NAME', 'servbiz')
  const accessKey = env('R2_ACCESS_KEY_ID')
  const secretKey = env('R2_SECRET_ACCESS_KEY')

  const host = `${account}.r2.cloudflarestorage.com`
  const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = crypto.createHash('sha256').update(body ?? '').digest('hex')

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(contentType ? { 'content-type': contentType } : {}),
  }

  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers).sort()
    .map((h) => `${h}:${headers[h]}\n`).join('')

  const canonicalRequest = [
    method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/auto/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')

  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest()
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), 'auto'), 's3'), 'aws4_request')
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  const response = await fetch(`https://${host}${canonicalUri}`, {
    method,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  })

  return response
}

async function uploadArtifact(key, buffer, contentType) {
  const response = await r2Request({ method: 'PUT', key, body: buffer, contentType })
  if (!response.ok) {
    throw new Error(`upload failed: ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
  return {
    key,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  }
}

async function fetchIcon(key) {
  const response = await r2Request({ method: 'GET', key })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`icon fetch failed: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

// ============================================================
// Apple credentials
// ============================================================

/**
 * Decrypts a v1.<iv>.<tag>.<ciphertext> blob from server/crypto.js.
 *
 * Reimplemented rather than imported: that module lives in servbiz-main, which
 * this repository does not depend on. The format is deliberately versioned so
 * the two can be changed in step -- if a v2 appears, this must learn it before
 * the API starts writing it.
 */
function decryptSecret(blob) {
  const parts = String(blob || '').split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Stored Apple key is not in the expected format.')
  }
  const key = Buffer.from(env('CONNECTION_ENC_KEY'), 'base64')
  if (key.length !== 32) {
    throw new Error(`CONNECTION_ENC_KEY must decode to 32 bytes, got ${key.length}.`)
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'))
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3], 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

async function loadAppleAccount(userId) {
  const row = await selectOne(
    'mobile_app_apple_accounts',
    `user_id=eq.${encodeURIComponent(userId)}&select=issuer_id,key_id,team_id,private_key_enc`
  )
  if (!row) throw new Error('A signed build was queued but no Apple key is on file.')
  return {
    issuerId: row.issuer_id,
    keyId: row.key_id,
    teamId: row.team_id,
    privateKey: decryptSecret(row.private_key_enc),
  }
}

// ============================================================
// Build
// ============================================================

/**
 * Which delivery mode this runner can actually produce.
 *
 * Passed to the claim so a job this runner cannot build is never checked out in
 * the first place. Handing one back afterwards would work, but it increments
 * `attempts` on the way past, and three of those kills the build at
 * max_attempts -- intermittently, depending on which runner got there first.
 *
 * Derived from the platform rather than taken as a flag: an operator running
 * this by hand on a Mac should get the signed queue, and on Linux should not be
 * able to ask for it.
 */
const deliveryForRunner = () =>
  (process.platform === 'darwin' ? 'ipa' : 'xcode-project')

async function zipDirectory(dir, outFile) {
  // The system zip, not a Node library. Present on both GitHub runner images,
  // and produces an archive macOS Finder and Windows Explorer both open without
  // complaint -- which is more than can be said for some JS zip writers.
  await run('zip', ['-r', '-q', '-X', outFile, '.'], { cwd: dir, maxBuffer: 1 << 26 })
  return fs.readFile(outFile)
}

/**
 * Archives and exports a signed .ipa.
 *
 * -allowProvisioningUpdates with an App Store Connect key is what removes the
 * need for the customer to upload a certificate and a provisioning profile:
 * Xcode asks Apple to create and renew both during the build.
 */
async function buildSignedIpa({ projectDir, product, apple, workDir }) {
  // The key has to be a file on disk; xcodebuild takes a path, not a value.
  // 0600 in a directory only this process should be able to read.
  const keyPath = path.join(workDir, `AuthKey_${apple.keyId}.p8`)
  await fs.writeFile(keyPath, apple.privateKey, { mode: 0o600 })

  const archivePath = path.join(workDir, `${product}.xcarchive`)
  const exportPath = path.join(workDir, 'export')

  const authArgs = [
    '-allowProvisioningUpdates',
    '-authenticationKeyPath', keyPath,
    '-authenticationKeyID', apple.keyId,
    '-authenticationKeyIssuerID', apple.issuerId,
  ]

  try {
    await run('xcodebuild', [
      '-project', path.join(projectDir, `${product}.xcodeproj`),
      '-scheme', product,
      '-configuration', 'Release',
      '-destination', 'generic/platform=iOS',
      '-archivePath', archivePath,
      `DEVELOPMENT_TEAM=${apple.teamId}`,
      ...authArgs,
      'archive',
    ], { maxBuffer: 1 << 26 })

    // app-store-connect, not ad-hoc. Ad-hoc would need every tester's device
    // UDID registered up front, which we have no way to collect; TestFlight
    // reaches the same testers with none of that.
    const optionsPath = path.join(workDir, 'ExportOptions.plist')
    await fs.writeFile(optionsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>teamID</key>
	<string>${apple.teamId}</string>
	<key>destination</key>
	<string>export</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>uploadSymbols</key>
	<true/>
</dict>
</plist>
`)

    await run('xcodebuild', [
      '-exportArchive',
      '-archivePath', archivePath,
      '-exportPath', exportPath,
      '-exportOptionsPlist', optionsPath,
      ...authArgs,
    ], { maxBuffer: 1 << 26 })

    const produced = (await fs.readdir(exportPath)).find((f) => f.endsWith('.ipa'))
    if (!produced) throw new Error('exportArchive produced no .ipa')
    return fs.readFile(path.join(exportPath, produced))
  } finally {
    // The key is removed whether or not the build worked. A runner image is
    // discarded afterwards, but a failed build uploads its logs, and a .p8 left
    // in the working directory is a customer's signing credential one
    // actions/upload-artifact away from being public.
    await fs.rm(keyPath, { force: true })
  }
}

/** Renders, builds and uploads one claimed job. */
async function processBuild(build) {
  const app = await selectOne(
    'mobile_apps',
    `id=eq.${build.app_id}&select=*`
  )
  if (!app) throw new Error(`app ${build.app_id} is gone`)

  const spec = parseSpec({ app, build: { ...build.spec, version_code: null } })

  // Belt and braces. The claim filters on delivery, so this should be
  // unreachable -- but a mismatch here means a signed build is about to be
  // attempted without Xcode, and failing with a clear message beats whatever
  // `xcodebuild: command not found` turns into four frames down.
  if (spec.delivery === 'ipa' && process.platform !== 'darwin') {
    throw new Error(`a signed build reached a ${process.platform} runner; it needs macOS`)
  }

  // Allocated after validation, so a spec that was going to be rejected does not
  // consume a version number the customer then never sees used.
  const versionCode = await rpc('mobile_app_allocate_version', { p_app_id: app.id })
  spec.versionCode = Number(versionCode)

  if (spec.delivery === 'ipa') {
    spec.teamId = (await loadAppleAccount(app.user_id)).teamId
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servbiz-ios-'))
  const product = productName(spec.appName)
  const projectDir = path.join(workDir, product)

  try {
    let iconPng = null
    if (app.icon_source_key) {
      const raw = await fetchIcon(app.icon_source_key)
      if (raw) {
        const { png, width } = flattenOntoColour(raw, spec.iconBackgroundColor)
        if (width < REQUIRED_ICON_PX && spec.delivery === 'ipa') {
          throw new Error(`icon is ${width}px; the App Store requires ${REQUIRED_ICON_PX}px`)
        }
        iconPng = png
      }
    }

    await renderProject({ spec, templateDir: TEMPLATE_DIR, outDir: projectDir, iconPng })
    log(`rendered ${product} (${spec.delivery})`)

    let artifact
    let contentType
    let extension

    if (spec.delivery === 'ipa') {
      const apple = await loadAppleAccount(app.user_id)
      artifact = await buildSignedIpa({ projectDir, product, apple, workDir })
      contentType = 'application/octet-stream'
      extension = 'ipa'
    } else {
      artifact = await zipDirectory(projectDir, path.join(workDir, 'project.zip'))
      contentType = 'application/zip'
      extension = 'zip'
    }

    const key = `mobile-apps/${app.id}/ios/${spec.versionCode}-${build.id.slice(0, 8)}.${extension}`
    const uploaded = await uploadArtifact(key, artifact, contentType)
    log(`uploaded ${key} (${(uploaded.size / 1048576).toFixed(2)} MB)`)

    return { uploaded, artifactKind: spec.artifactKind }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true })
  }
}

// ============================================================
// Queue loop
// ============================================================

async function drain() {
  requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])

  const delivery = deliveryForRunner()
  log(`draining ios/${delivery} as ${WORKER_ID}`)

  let handled = 0
  // Bounded rather than while(true): a bug that keeps re-claiming the same row
  // would otherwise run until GitHub's job timeout, billing the whole time.
  for (let i = 0; i < MAX_JOBS; i++) {
    // Checked before claiming, not after. Claiming a job this worker has no time
    // left to finish is worse than leaving it queued: it takes a lease the next
    // run then has to wait out.
    if (BUDGET_MS && Date.now() - STARTED_AT > BUDGET_MS) {
      log(`time budget spent after ${handled} build(s); leaving the rest queued`)
      break
    }

    const claimed = await rpc('mobile_app_build_claim', {
      p_worker_id: WORKER_ID,
      p_lease_seconds: LEASE_SECONDS,
      p_max_attempts: 3,
      p_platform: 'ios',
      p_delivery: delivery,
    })

    const build = Array.isArray(claimed) ? claimed[0] : claimed
    if (!build) break

    log(`claimed ${build.id}`)
    const heartbeat = setInterval(() => {
      rpc('mobile_app_build_heartbeat', {
        p_build_id: build.id,
        p_worker_id: WORKER_ID,
        p_lease_seconds: LEASE_SECONDS,
      }).catch((e) => log(`heartbeat failed: ${e.message}`))
    }, HEARTBEAT_MS)

    try {
      const result = await processBuild(build)

      await rpc('mobile_app_build_finish', {
        p_build_id: build.id,
        p_worker_id: WORKER_ID,
        p_success: true,
        p_artifact_key: result.uploaded.key,
        p_artifact_size: result.uploaded.size,
        p_artifact_sha256: result.uploaded.sha256,
        p_error: null,
        p_artifact_kind: result.artifactKind,
      })
      handled++
      log(`finished ${build.id}`)
    } catch (err) {
      // The message goes in the row for operators. The API redacts it before a
      // customer sees it, so it may be specific -- but never a signing key, and
      // never a URL with query parameters.
      log(`FAILED ${build.id}: ${err.message}`)
      await rpc('mobile_app_build_finish', {
        p_build_id: build.id,
        p_worker_id: WORKER_ID,
        p_success: false,
        p_artifact_key: null,
        p_artifact_size: null,
        p_artifact_sha256: null,
        p_error: String(err.message).slice(0, 2000),
        p_artifact_kind: null,
      }).catch((e) => log(`could not record failure: ${e.message}`))
    } finally {
      clearInterval(heartbeat)
    }
  }

  log(`done; ${handled} build(s) completed`)
}

// ============================================================
// Selftest
// ============================================================
//
// No network, no database, no Xcode. Renders a project from a fixed spec and
// inspects the result, which is everything short of the parts that need macOS.
//
// This exists because the alternative way to find out that the renderer emits a
// broken pbxproj is a customer opening a corrupt project.

async function selftest() {
  let pass = 0
  let total = 0
  const check = (name, ok, detail = '') => {
    total++
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${detail}`)
  }

  const baseApp = {
    id: '11111111-2222-3333-4444-555555555555',
    user_id: 'user_selftest',
    application_id: 'com.servbiz.app.selftest-a1b2c3',
    app_name: "Raj's Café & Co (Pvt) Ltd",
    start_url: 'https://selftest.servbiz.in/',
    allowed_hosts: ['selftest.servbiz.in'],
    version_name: '1.2.3',
    icon_source_key: null,
    config: {
      display: { themeColor: '#123456', statusBarStyle: 'light', orientation: 'portrait', tabletSupport: false },
      splash: { backgroundColor: '#FFEEDD', showLogo: true, maxWaitMs: 5000 },
      behavior: { allowCamera: true, allowGeolocation: true, swipeNavigation: false },
      iconBackgroundColor: '#FF0000',
      encryptionExempt: true,
    },
  }

  console.log('-- spec validation ------------------------------------------------')

  const spec = parseSpec({ app: baseApp, build: { delivery: 'xcode-project' } })
  check('parses a complete spec', spec.bundleId === baseApp.application_id, spec.bundleId)
  check('defaults delivery to the project path', spec.delivery === 'xcode-project', spec.delivery)
  check('maps delivery to artifact kind', spec.artifactKind === 'xcode-project')
  check('keeps the marketing version', spec.marketingVersion === '1.2.3')
  check('clamps splash wait', spec.splash.maxWaitMs === 5000, String(spec.splash.maxWaitMs))
  check('on-by-default flags survive absence', spec.behavior.pullToRefresh === true)
  check('explicit false is respected', spec.behavior.swipeNavigation === false)

  const rejects = (name, mutate, expect) => {
    total++
    let message = null
    try {
      parseSpec({ app: { ...baseApp, ...mutate }, build: {} })
    } catch (e) { message = e.message }
    const ok = message !== null && (!expect || new RegExp(expect, 'i').test(message))
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${message ? message.slice(0, 40) : 'NOT REJECTED'}`)
  }

  rejects('rejects http start url', { start_url: 'http://x.example.com/' }, 'https')
  rejects('rejects a bundle id with underscores', { application_id: 'com.servbiz.app_x' }, 'underscore')
  rejects('rejects a one-part bundle id', { application_id: 'servbiz' }, 'bundle id')
  rejects('rejects an empty app name', { app_name: '   ' }, 'required')

  // A host carrying a quote would close the Swift string literal it lands in.
  const injected = parseSpec({
    app: { ...baseApp, allowed_hosts: ['ok.example.com', 'bad".example.com', 'also bad'] },
    build: {},
  })
  check('drops hosts that are not hostnames',
    injected.allowedHosts.length === 1 && injected.allowedHosts[0] === 'ok.example.com',
    injected.allowedHosts.join(','))

  console.log('-- icon flattening -----------------------------------------------')

  // A 4x4 image: top-left fully transparent, the rest opaque green.
  const side = 4
  const rgba = Buffer.alloc(side * side * 4)
  for (let i = 0; i < side * side; i++) {
    rgba[i * 4] = 0
    rgba[i * 4 + 1] = 255
    rgba[i * 4 + 2] = 0
    rgba[i * 4 + 3] = i === 0 ? 0 : 255
  }
  // Encoded as RGB first to confirm the encoder, then hand-built as RGBA so the
  // alpha path is what gets exercised.
  const rgbOnly = encodePngRgb(side, side, Buffer.from(
    Array.from({ length: side * side }, () => [0, 255, 0]).flat()
  ))
  const decodedRgb = decodePng(rgbOnly)
  check('encodes and decodes RGB', decodedRgb.width === side && decodedRgb.channels === 3,
    `${decodedRgb.width}x${decodedRgb.height} ch${decodedRgb.channels}`)

  const rgbaPng = buildRgbaPng(side, side, rgba)
  const flat = flattenOntoColour(rgbaPng, '#FF0000')
  const after = decodePng(flat.png)
  check('flattening removes the alpha channel', after.channels === 3, `ch${after.channels}`)
  check('transparent pixel takes the background',
    after.pixels[0] === 255 && after.pixels[1] === 0 && after.pixels[2] === 0,
    `rgb(${after.pixels[0]},${after.pixels[1]},${after.pixels[2]})`)
  check('opaque pixel is untouched',
    after.pixels[3] === 0 && after.pixels[4] === 255 && after.pixels[5] === 0,
    `rgb(${after.pixels[3]},${after.pixels[4]},${after.pixels[5]})`)

  console.log('-- project render ------------------------------------------------')

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servbiz-ios-selftest-'))
  try {
    spec.versionCode = 7
    const rendered = await renderProject({
      spec, templateDir: TEMPLATE_DIR, outDir, iconPng: flat.png,
    })

    const product = rendered.productName
    check('product name is filesystem safe', /^[A-Za-z0-9]+$/.test(product), product)

    const read = (rel) => fs.readFile(path.join(outDir, rel), 'utf8')

    const pbx = await read(`${product}.xcodeproj/project.pbxproj`)
    check('pbxproj has no unreplaced tokens', !/\{\{[A-Z0-9_]+\}\}/.test(pbx))
    check('pbxproj braces balance',
      (pbx.match(/\{/g) || []).length === (pbx.match(/\}/g) || []).length,
      `${(pbx.match(/\{/g) || []).length} pairs`)
    check('pbxproj declares the rootObject', pbx.includes('rootObject = 1A0000000000000000000001'))
    check('pbxproj carries the bundle id', pbx.includes(spec.bundleId))
    check('pbxproj carries the allocated version', pbx.includes('CURRENT_PROJECT_VERSION = 7'))
    check('iPhone-only device family honoured', pbx.includes('TARGETED_DEVICE_FAMILY = "1"'))

    // Every path the project references must exist, or Xcode opens a project
    // with red files in it.
    const referenced = [...pbx.matchAll(/path = ([A-Za-z0-9_./]+\.(?:swift|plist|xcassets));/g)]
      .map((m) => m[1])
    const groups = { 'AppDelegate.swift': 'Sources', 'WebViewController.swift': 'Sources', 'Config.swift': 'Sources', 'Info.plist': 'Resources', 'Assets.xcassets': 'Resources' }
    let allPresent = referenced.length > 0
    for (const ref of referenced) {
      const full = path.join(outDir, groups[ref] ?? '', ref)
      try { await fs.stat(full) } catch { allPresent = false; console.log(`       missing: ${ref}`) }
    }
    check('every referenced file exists', allPresent, `${referenced.length} refs`)

    const plist = await read('Resources/Info.plist')
    check('Info.plist has no unreplaced tokens', !/\{\{[A-Z0-9_]+\}\}/.test(plist))
    check('display name is XML-escaped',
      plist.includes('Raj&apos;s Café &amp; Co (Pvt) Ltd'),
      'apostrophe and ampersand')
    check('camera permission present when enabled', plist.includes('NSCameraUsageDescription'))
    check('location permission present when enabled', plist.includes('NSLocationWhenInUseUsageDescription'))
    check('microphone permission absent when disabled', !plist.includes('NSMicrophoneUsageDescription'))
    check('photo library absent when disabled', !plist.includes('NSPhotoLibraryUsageDescription'))
    check('portrait-only orientation written',
      plist.includes('UIInterfaceOrientationPortrait')
      && !plist.includes('UIInterfaceOrientationLandscapeLeft'))
    check('encryption exemption declared false',
      /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/.test(plist))
    check('Info.plist is well-formed XML', xmlBalanced(plist))

    const config = await read('Sources/Config.swift')
    check('Config.swift has no unreplaced tokens', !/\{\{[A-Z0-9_]+\}\}/.test(config))
    check('start url is in Config', config.includes('https://selftest.servbiz.in/'))
    check('allowed hosts are quoted Swift strings',
      config.includes('["selftest.servbiz.in"]'))
    check('status bar style mapped', config.includes('.lightContent'))
    check('orientation mask mapped', config.includes('.portrait'))
    check('splash wait is seconds not ms', config.includes('= 5.0'))

    const scheme = await read(`${product}.xcodeproj/xcshareddata/xcschemes/${product}.xcscheme`)
    check('shared scheme is written', scheme.includes(`${product}.app`))
    check('scheme targets the right blueprint', scheme.includes('1A0000000000000000000010'))

    const iconJson = JSON.parse(await read('Resources/Assets.xcassets/AppIcon.appiconset/Contents.json'))
    check('app icon declares 1024', iconJson.images[0].size === '1024x1024')
    const iconBytes = await fs.readFile(path.join(outDir, 'Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png'))
    check('app icon png written with no alpha', decodePng(iconBytes).channels === 3)

    const colourset = JSON.parse(await read('Resources/Assets.xcassets/LaunchBackground.colorset/Contents.json'))
    check('launch colour matches the spec',
      colourset.colors[0].color.components.red === '1.000'
      && colourset.colors[0].color.components.green === '0.933',
      JSON.stringify(colourset.colors[0].color.components))

    check('customer README included on the project path',
      rendered.files.includes('README.md'))

    // The signed path must not ship the README, and must carry the team id.
    const ipaSpec = parseSpec({ app: baseApp, build: { delivery: 'ipa' } })
    ipaSpec.versionCode = 8
    ipaSpec.teamId = 'TEAM123456'
    const ipaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'servbiz-ios-selftest-ipa-'))
    try {
      const ipaRender = await renderProject({ spec: ipaSpec, templateDir: TEMPLATE_DIR, outDir: ipaDir, iconPng: flat.png })
      check('signed path omits the customer README', !ipaRender.files.includes('README.md'))
      const ipaPbx = await fs.readFile(path.join(ipaDir, `${ipaRender.productName}.xcodeproj/project.pbxproj`), 'utf8')
      check('signed path bakes in the team id', ipaPbx.includes('DEVELOPMENT_TEAM = "TEAM123456"'))
      check('signed path has no unreplaced tokens', !/\{\{[A-Z0-9_]+\}\}/.test(ipaPbx))
    } finally {
      await fs.rm(ipaDir, { recursive: true, force: true })
    }

    // A missing template value must be a hard error, not an empty string.
    total++
    let threw = false
    try {
      fill('a {{NOT_A_REAL_TOKEN}} b', { PRODUCT_NAME: 'x' })
    } catch { threw = true }
    if (threw) pass++
    console.log(`${threw ? 'PASS' : 'FAIL'}  ${'unknown token is a hard error'.padEnd(54)}`)
  } finally {
    await fs.rm(outDir, { recursive: true, force: true })
  }

  console.log('='.repeat(72))
  console.log(`${pass}/${total} iOS build-host checks passed`)
  if (pass !== total) process.exitCode = 1
}

/**
 * Minimal RGBA PNG writer, for the selftest only.
 *
 * Here rather than in icons.mjs because production never writes an RGBA PNG --
 * removing the alpha channel is the entire point of that module. The selftest
 * needs one as *input*, to prove the flattening does what it claims.
 */
function buildRgbaPng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c
  }
  const crc = (buf) => {
    let c = -1
    for (const b of buf) c = (c >>> 8) ^ crcTable[(c ^ b) & 0xff]
    return (c ^ -1) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, cr])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Tag-balance check. Not a parser, but it catches a truncated template. */
function xmlBalanced(text) {
  const tags = [...text.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)(\s[^>]*?)?(\/?)>/g)]
  const stack = []
  for (const [, closing, name, , selfClose] of tags) {
    if (selfClose === '/') continue
    if (closing === '/') {
      if (stack.pop() !== name) return false
    } else {
      stack.push(name)
    }
  }
  return stack.length === 0
}

// ============================================================
// Entry
// ============================================================

const argv = process.argv.slice(2)

try {
  if (argv.includes('--selftest')) {
    await selftest()
  } else if (argv.includes('--dry-run')) {
    // Proves the renderer and the environment without touching the queue.
    requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])
    log('environment looks complete; running the renderer selftest')
    await selftest()
  } else {
    // --drain is accepted and is also the default, so the workflow can state its
    // intent the way android-build.yml does without the flag being load-bearing.
    await drain()
  }
} catch (err) {
  if (err instanceof SpecError) log(`spec rejected: ${err.message}`)
  else log(`fatal: ${err.message}`)
  process.exitCode = 1
}
