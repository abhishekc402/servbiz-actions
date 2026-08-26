#!/usr/bin/env node
/**
 * Device/emulator test harness for the app shell.
 *
 * Serves a page that exercises the WebView paths that break in practice, and
 * collects results POSTed back from the page so assertions come from the real
 * device rather than from reading screenshots.
 *
 * Reachable from an emulator at http://10.0.2.2:8099 (10.0.2.2 is the host
 * loopback as seen from inside the emulator). Plain HTTP on purpose: a
 * self-signed cert would be correctly rejected by the shell, since
 * onReceivedSslError cancels rather than proceeding.
 *
 * Usage:
 *   node tools/test-harness/server.mjs                 # serve on :8099
 *   node tools/test-harness/server.mjs --results       # dump collected results
 *   node tools/test-harness/server.mjs --port 9000
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');
const RESULTS = join(STATE_DIR, 'results.json');
const REQUESTS = join(STATE_DIR, 'requests.json');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

if (process.argv.includes('--results')) {
  for (const f of [RESULTS, REQUESTS]) {
    console.log(`\n===== ${f.replace(HERE, 'tools/test-harness')} =====`);
    console.log(existsSync(f) ? readFileSync(f, 'utf8') : '(none)');
  }
  process.exit(0);
}

mkdirSync(STATE_DIR, { recursive: true });
const results = [];
const requests = [];

const persist = () => {
  writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  writeFileSync(REQUESTS, JSON.stringify(requests, null, 2));
};

const readBody = (req, limit = 12 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const PORT = Number(arg('--port', 8099));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const entry = {
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    ua: req.headers['user-agent'] ?? '',
    cookie: req.headers.cookie ?? '',
    referer: req.headers.referer ?? '',
  };
  requests.push(entry);

  const send = (status, type, body) => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      // The harness is same-origin for the app, so no CORS games needed.
    });
    res.end(body);
    persist();
  };

  if (url.pathname === '/report' && req.method === 'POST') {
    try {
      const parsed = JSON.parse((await readBody(req)).toString('utf8'));
      results.push({ at: entry.at, ...parsed });
      console.log(
        `[report] ${parsed.pass ? 'ok  ' : 'BAD '} ${parsed.name}: ${parsed.detail}`
      );
    } catch (e) {
      console.log(`[report] unparseable: ${e.message}`);
    }
    return send(204, 'text/plain', '');
  }

  if (url.pathname === '/layout' && req.method === 'POST') {
    try {
      const parsed = JSON.parse((await readBody(req)).toString('utf8'));
      // Stamped so the driver can tell a fresh measurement from a stale one and
      // avoid tapping coordinates from a previous page load.
      parsed.at = Date.now();
      writeFileSync(join(STATE_DIR, 'layout.json'), JSON.stringify(parsed, null, 2));
      console.log(
        `[layout] viewport ${parsed.innerWidth}x${parsed.innerHeight} dpr ${parsed.devicePixelRatio}, ` +
          `${Object.keys(parsed.elements).length} elements`
      );
    } catch (e) {
      console.log(`[layout] unparseable: ${e.message}`);
    }
    return send(204, 'text/plain', '');
  }

  if (url.pathname === '/upload' && req.method === 'POST') {
    const body = await readBody(req);
    // Crude multipart peek: enough to prove real bytes arrived and to recover
    // the filenames, without pulling in a parser dependency.
    const head = body.subarray(0, Math.min(body.length, 4096)).toString('latin1');
    const names = [...head.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]);
    const detail = `${body.length}B, files: ${names.join(', ') || 'none'}`;
    results.push({ at: entry.at, name: 'upload:bytesReceived', pass: body.length > 0, detail });
    console.log(`[upload] ${detail}`);
    return send(200, 'text/plain', 'ok');
  }

  if (url.pathname === '/second') {
    return send(
      200,
      'text/html; charset=utf-8',
      `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
       <body style="font:16px/1.5 system-ui;padding:24px">
       <h1 id=marker>SECOND_PAGE</h1>
       <p>Back should return to the harness, not exit the app.</p>
       <a href="/" style="display:inline-block;padding:12px 16px;background:#0f172a;color:#fff;border-radius:8px;text-decoration:none">home</a>
       <script>fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},
         body:JSON.stringify({name:'nav:secondPageReached',pass:true,detail:location.pathname})})</script>`
    );
  }

  if (url.pathname === '/fallback') {
    return send(
      200,
      'text/html; charset=utf-8',
      `<!doctype html><body style="font:16px system-ui;padding:24px">
       <h1 id=marker>INTENT_FALLBACK_REACHED</h1>
       <script>fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},
         body:JSON.stringify({name:'intent:browserFallbackUrl',pass:true,detail:'reached'})})</script>`
    );
  }

  if (url.pathname === '/boom') {
    // Main-frame 5xx: the shell should replace the page with its error screen.
    return send(500, 'text/html; charset=utf-8', '<h1>500 deliberate</h1>');
  }

  if (url.pathname === '/report.pdf') {
    // Minimal valid single-page PDF so DownloadManager has real content.
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
        '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
        'trailer<</Root 1 0 R>>\n%%EOF\n',
      'latin1'
    );
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="shell-test.pdf"',
      'Content-Length': pdf.length,
    });
    res.end(pdf);
    persist();
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(200, 'text/html; charset=utf-8', readFileSync(join(HERE, 'index.html')));
  }

  return send(404, 'text/plain', 'not found');
});

// Bound to all interfaces so the emulator's 10.0.2.2 alias can reach it.
// This is a local test harness with no auth; do not run it on an untrusted
// network and do not leave it running.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`harness on http://0.0.0.0:${PORT}  (emulator: http://10.0.2.2:${PORT})`);
});
