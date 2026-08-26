# servbiz-actions

Build host for Servbiz Android app shells. Wraps a published Servbiz site in a
native WebView shell and produces a signed `.apk`.

This repository does not serve traffic and has no frontend. It contains one
workflow and the Android template that workflow builds. The customer-facing
product lives in the private `servbiz-main` repository.

## Why this is a separate, public repository

GitHub bills no Actions minutes for standard runners on public repositories,
while a private repository on the Free plan gets 2,000 minutes a month. At the
observed cost of roughly one billed minute per build, plus a scheduled sweep,
that ceiling would have forced a per-customer build quota. Splitting the build
host out and making it public removes the ceiling instead of rationing it.

Nothing else moved. The API, the dashboard, the database schema and every
credential remain private.

## What being public does and does not mean

**Secrets are safe.** Repository visibility does not expose Actions secrets.
They are encrypted, forks never receive them, and the only triggers here are
`workflow_dispatch` and `schedule` — neither of which a fork can fire.

> Do not add a `pull_request` trigger to the workflow. That is the single change
> that would let an outsider's code run alongside these secrets.

**Logs are not private.** Anyone signed in to GitHub can read the output of runs
in a public repository. The worker and preflight are written accordingly and
print no customer-identifying detail:

| Not logged | Where to read it instead |
| --- | --- |
| package id, app name | `mobile_apps` |
| object key | `mobile_app_builds.artifact_key` |
| failure text | `mobile_app_builds.error` |
| signing fingerprint | `mobile_apps.cert_fingerprint_sha256` |
| customer count | `mobile_apps` |

Runs log an opaque build UUID, which is enough to find the corresponding row.
**If you add logging, assume a competitor is reading it.**

**Build volume is visible and cannot be hidden.** The number and timing of runs
appears in the Actions tab regardless of what the logs contain. This was accepted
as the price of free minutes.

## How a build is triggered

1. A customer creates an app or requests a rebuild in the dashboard.
2. `server/buildDispatch.js` in `servbiz-main` fires a `workflow_dispatch` here.
3. The worker claims the queued row, builds, signs, uploads to R2, and marks it
   done.

A scheduled sweep also runs on a cron as a safety net, in case a dispatch is ever
lost. It costs nothing here, so it can run as often as is useful.

## Required configuration

An **environment** named `android-build` with these secrets:

```
SUPABASE_URL                 SUPABASE_SERVICE_ROLE_KEY
SERVBIZ_MASTER_KEY           R2_ACCOUNT_ID
R2_BUCKET_NAME               R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

Set them without trailing newlines. Pasting into the web UI readily leaves one,
and for an S3 credential the result is
`Invalid character in header content ["authorization"]`, which names neither the
variable nor the cause. The code trims defensively and the preflight warns, but
entering them cleanly is better. `servbiz-main` has `sync-build-secrets.sh` for
this.

`servbiz-main` must point at this repository via `GITHUB_BUILD_REPO`, and its
`GITHUB_BUILD_TOKEN` must be scoped to **this** repo with Actions: read and write.

## Local use

```sh
cd android-template
npm install
node tools/check-connectivity.mjs   # read-only preflight
node tools/worker.mjs --once        # claim and build one queued job
node tools/test-spec-validation.mjs
node tools/test-worker.mjs          # needs ANDROID_HOME and a JDK
```

Requires JDK 17 and an Android SDK with build-tools 35.0.0.
