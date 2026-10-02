#!/usr/bin/env node
// ============================================================
// Reports what kinds of iOS build are waiting, as GITHUB_OUTPUT lines.
//
//   has_project=true|false
//   has_signed=true|false
//
// Read-only, and deliberately not a claim. The workflow uses this to decide
// whether to start a macOS runner at all, and claiming here would check rows out
// to a job that is not going to build them.
//
// Its own file rather than an inline `node -e` in the workflow. A multi-line
// script embedded in YAML has to survive two layers of quoting, cannot be run
// locally to check, and is the kind of thing that breaks silently on an edit --
// and this one decides whether the signed queue gets drained at all.
//
// Fails open. If the queue cannot be read, it claims there is project work: a
// needless run costs about a minute, whereas a wrongly skipped one leaves a
// customer waiting for the next sweep.
// ============================================================

const env = (name) => (process.env[name] ?? '').trim()

const SUPABASE_URL = env('SUPABASE_URL')
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')

const emit = (hasProject, hasSigned) => {
  process.stdout.write(`has_project=${hasProject}\n`)
  process.stdout.write(`has_signed=${hasSigned}\n`)
}

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[peek] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing')
  emit(true, false)
  process.exit(0)
}

// !inner on the join makes it a filter rather than a left join, which is what
// restricts the result to iOS apps.
const url =
  `${SUPABASE_URL}/rest/v1/mobile_app_builds` +
  `?select=spec,status,mobile_apps!inner(platform)` +
  `&status=eq.queued` +
  `&mobile_apps.platform=eq.ios`

let rows
try {
  const response = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    console.error(`[peek] queue read failed: ${response.status}`)
    emit(true, false)
    process.exit(0)
  }
  rows = await response.json()
} catch (err) {
  console.error(`[peek] queue read failed: ${err.message}`)
  emit(true, false)
  process.exit(0)
}

// Absent delivery means the project path, matching the default in spec.mjs and
// the COALESCE in mobile_app_build_claim. A spec written before delivery existed
// must not be read as signed -- that would route it to macOS and fail.
const signed = rows.filter((row) => row?.spec?.delivery === 'ipa').length
const project = rows.length - signed

console.error(`[peek] ${rows.length} queued iOS build(s): ${project} project, ${signed} signed`)
emit(project > 0, signed > 0)
