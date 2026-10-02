# Servbiz iOS app shell

Template Xcode project that becomes a customer's app. Every build is a full
render — there is no fast-patch path, because everything tunable lives inside the
signed app bundle.

## Distribution is the whole story

There is no iOS equivalent of handing someone an `.apk`. Apple will not run an app
signed with anything but a certificate it issued, and an unsigned `.ipa` installs
nowhere at all. So a customer gets one of two things, and picks which:

| delivery | what they get | runner | Apple account |
|---|---|---|---|
| `xcode-project` | the configured project, zipped. They open it on a Mac and press Run. | `ubuntu-latest` | none |
| `ipa` | a signed binary for TestFlight / App Store | `macos-latest` | Developer Program |

`xcode-project` is the default, because it works for every customer. Rendering a
project is templating text and writing PNGs — no compiler runs — which is why it
does not need macOS.

## Layout

```
ios-template/
  template/
    project.pbxproj.tmpl         hand-written; see the note at its head
    scheme.xcscheme.tmpl         shared scheme, or xcodebuild finds nothing
    Sources/AppDelegate.swift    window + orientation lock
    Sources/WebViewController.swift   the app: one WKWebView and its policies
    Sources/Config.swift.tmpl    settings compiled in, not a bundled JSON
    Resources/Info.plist.tmpl    UILaunchScreen, conditional NS*UsageDescription
    README.md.tmpl               ships inside the customer's zip
  tools/
    lib/spec.mjs                 validation; mirrors server/iosApps.js in the app repo
    lib/render.mjs               spec -> a complete project on disk
    lib/icons.mjs                PNG decode/encode, alpha flattening, no deps
    worker.mjs                   drains the queue; --selftest, --dry-run, --drain
    peek-queue.mjs               what is queued, for the workflow's triage job
```

## No dependencies, on purpose

There is no `npm install` step in the workflow and there should not be one.
Supabase is reached over plain REST and R2 is signed by hand, so no package tree
sits in the path that renders and signs customers' apps. `android-template`
carries `@aws-sdk` and `@supabase/supabase-js`; this half needs neither.

The same reasoning covers images. Apple rejects an icon with an alpha channel, so
the uploaded PNG has to be flattened onto a colour — `tools/lib/icons.mjs` does
that with `node:zlib` rather than `sharp` or `canvas`, because a native module in
the signing path is a worse trade than 120 lines of PNG handling.

## Running it

```bash
npm run selftest     # no network, no Xcode. 49 checks.
npm run peek         # what is queued (needs SUPABASE_* )
npm run worker       # drain the queue
```

`selftest` renders a project from a fixed spec and inspects the result: the
`pbxproj` is well-formed and every file it references exists, `Info.plist` is
valid XML with permission keys only where enabled, Swift string literals are
escaped, and the icon comes out with no alpha channel. It runs on Linux and is
what both workflow jobs run before touching a real build.

It cannot verify that Xcode opens the project or that `xcodebuild archive`
succeeds — those need macOS. The first signed run is the real test of that.

## Secrets

Environment `ios-build`. Both jobs get `SUPABASE_*` and `R2_*`.

`CONNECTION_ENC_KEY` goes **only** to the `signed` job: it decrypts customers' App
Store Connect keys out of `mobile_app_apple_accounts`, and the Linux job has no
business being able to. Populate with `./sync-build-secrets.sh --env ios-build`
from the app repo.

## The thing most likely to bite

`xcodebuild -allowProvisioningUpdates` needs the App Store Connect key to have the
**App Manager** or **Admin** role. A Developer-role key authenticates fine — so
the app's own credential check reports it as working — but cannot create a signing
certificate, and the build fails much later complaining about provisioning
profiles. If signed builds fail for a customer whose credentials verify, check the
key's role first.
