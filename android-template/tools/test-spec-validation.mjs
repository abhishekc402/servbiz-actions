#!/usr/bin/env node
/**
 * Regression suite for build-app.mjs spec validation.
 *
 * Runs in seconds and needs no Android SDK, because it drives build-app.mjs in
 * --dry-run mode. This is the guard on the input boundary: every value in a spec
 * arrives from a customer-facing form, and it ends up in a build script, a
 * generated XML resource and a manifest.
 *
 * Usage: node tools/test-spec-validation.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER = join(HERE, 'build-app.mjs');
const BASE = JSON.parse(readFileSync(join(HERE, 'example-spec.json'), 'utf8'));

const ACCEPT = 'accept';
const REJECT = 'reject';

const cases = [
  // --- appName: reaches a generated <string> resource ---------------------
  [REJECT, 'shell metacharacters',        (s) => { s.appName = 'Acme; rm -rf /'; }],
  [REJECT, 'backticks',                   (s) => { s.appName = 'Acme `whoami`'; }],
  [REJECT, 'closing the XML element',     (s) => { s.appName = 'Acme</string><x>'; }],
  [REJECT, 'newline injection',           (s) => { s.appName = 'Acme\nmalicious=1'; }],
  [REJECT, 'double quote',                (s) => { s.appName = 'Acme "Ltd"'; }],
  [REJECT, 'backslash',                   (s) => { s.appName = 'Acme\\Ltd'; }],
  [REJECT, 'percent (format string)',     (s) => { s.appName = '100% Acme'; }],
  [REJECT, 'resource reference',          (s) => { s.appName = '@string/evil'; }],
  [REJECT, 'empty after trim',            (s) => { s.appName = '   '; }],
  [REJECT, 'over 50 chars',               (s) => { s.appName = 'A'.repeat(51); }],
  // aapt2 rejects a bare apostrophe and AGP does not escape one, so these two
  // only pass because build-app.mjs emits \' -- and it must NOT touch the
  // ampersand, which AGP escapes itself.
  [ACCEPT, 'apostrophe',                  (s) => { s.appName = "Bob's Cafe"; }],
  [ACCEPT, 'ampersand',                   (s) => { s.appName = 'Tea & Cake'; }],
  [ACCEPT, 'curly apostrophe',            (s) => { s.appName = 'Bob\u2019s Cafe'; }],
  // Indic vowel signs are \p{M}, not \p{L}. A letters-only allow-list rejects
  // every Hindi/Tamil/Bengali/Arabic/Thai business name, which for this market
  // is not an edge case.
  [ACCEPT, 'devanagari',                  (s) => { s.appName = 'चाय और केक'; }],
  [ACCEPT, 'tamil',                       (s) => { s.appName = 'அமுதம் உணவகம்'; }],
  [ACCEPT, 'arabic',                      (s) => { s.appName = 'مقهى بوب'; }],
  [REJECT, 'bidi override (spoofable)',   (s) => { s.appName = 'Acme\u202Eevil'; }],
  [REJECT, 'emoji',                       (s) => { s.appName = 'Acme 🚀'; }],

  // --- applicationId: permanent, and must satisfy AGP ---------------------
  [REJECT, 'uppercase',                   (s) => { s.applicationId = 'com.Servbiz.App'; }],
  [REJECT, 'single segment',              (s) => { s.applicationId = 'servbiz'; }],
  [REJECT, 'java keyword segment',        (s) => { s.applicationId = 'com.servbiz.class'; }],
  [REJECT, 'hyphen',                      (s) => { s.applicationId = 'com.serv-biz.app'; }],
  [REJECT, 'segment starts with digit',   (s) => { s.applicationId = 'com.9lives.app'; }],
  [REJECT, 'trailing dot',                (s) => { s.applicationId = 'com.servbiz.app.'; }],
  [ACCEPT, 'underscores',                 (s) => { s.applicationId = 'com.servbiz.app.acme_x1'; }],

  // --- startUrl / hosts: the navigation trust boundary --------------------
  [REJECT, 'http without opt-in',         (s) => { s.startUrl = 'http://acme.example.com/'; }],
  [REJECT, 'javascript scheme',           (s) => { s.startUrl = 'javascript:alert(1)'; }],
  [REJECT, 'file scheme',                 (s) => { s.startUrl = 'file:///etc/passwd'; }],
  [REJECT, 'wildcard host',               (s) => { s.allowedHosts = ['*.example.com']; }],
  [REJECT, 'host with path',              (s) => { s.allowedHosts = ['example.com/admin']; }],
  [REJECT, 'host with port',              (s) => { s.allowedHosts = ['example.com:8080']; }],
  [ACCEPT, 'http WITH explicit opt-in',   (s) => {
    s.startUrl = 'http://acme.example.com/';
    s.allowedHosts = ['acme.example.com'];
    s.allowCleartextTraffic = true;
  }],

  // --- colours: land in generated resource values -------------------------
  [REJECT, 'named colour',                (s) => { s.display.themeColor = 'red'; }],
  [REJECT, 'attribute break-out',         (s) => { s.display.themeColor = '#FFF"/><x'; }],
  [REJECT, '3-digit hex',                 (s) => { s.display.themeColor = '#FFF'; }],

  // --- versioning: monotonic updates depend on this ----------------------
  [REJECT, 'negative versionCode',        (s) => { s.versionCode = -1; }],
  [REJECT, 'zero versionCode',            (s) => { s.versionCode = 0; }],
  [REJECT, 'float versionCode',           (s) => { s.versionCode = 1.5; }],
  [REJECT, 'versionCode over 2.1e9',      (s) => { s.versionCode = 2_100_000_001; }],
  [REJECT, 'bad versionName',             (s) => { s.versionName = 'v1 final'; }],

  // --- remote config: cosmetic-only channel ------------------------------
  [REJECT, 'http config endpoint',        (s) => { s.remoteConfig = { enabled: true, url: 'http://x.example.com/c' }; }],
  [REJECT, 'enabled with no url',         (s) => { s.remoteConfig = { enabled: true }; }],

  // --- signing ------------------------------------------------------------
  [REJECT, 'missing keystore file',       (s) => {
    s.signing = { storeFile: '/nope/x.jks', storePassword: 'a', keyPassword: 'a', keyAlias: 'k' };
  }],
  [REJECT, 'keyAlias with a space',       (s) => {
    s.signing = { storeFile: '/nope/x.jks', storePassword: 'a', keyPassword: 'a', keyAlias: 'my key' };
  }],
];

function run() {
  const dir = mkdtempSync(join(tmpdir(), 'servbiz-specval-'));
  let pass = 0;

  try {
    cases.forEach(([expect, name, mutate], i) => {
      const spec = structuredClone(BASE);
      mutate(spec);
      const specPath = join(dir, `${i}.json`);
      writeFileSync(specPath, JSON.stringify(spec));

      let rejected = false;
      let output = '';
      try {
        output = execFileSync(
          process.execPath,
          [BUILDER, '--spec', specPath, '--out', dir, '--dry-run'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );
      } catch (e) {
        rejected = true;
        output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }

      const ok = expect === REJECT ? rejected : !rejected;
      if (ok) pass++;

      const detail = expect === REJECT
        ? (output.match(/Invalid spec: .*/)?.[0] ?? '(rejected without a spec error)').slice(0, 84)
        : (rejected ? (output.match(/Invalid spec: .*/)?.[0] ?? 'unexpected failure').slice(0, 84) : '');

      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${expect}  ${name.padEnd(30)} ${detail}`
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass}/${cases.length} validation cases behaved correctly`);
  return pass === cases.length ? 0 : 1;
}

process.exit(run());
