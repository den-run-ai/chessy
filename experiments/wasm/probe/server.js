/*
 * Probe server: serves the repository root (the probe page needs
 * /assets/engine.js, /assets/ai.js and /experiments/wasm/*) and collects
 * probe reports POSTed to /probe-report.
 *
 * Reports are written to --out (default experiments/wasm/probe/reports):
 *   progress-<target>.log   — appended JSON lines
 *   final-<target>.json     — the final report (arrival ends --wait mode)
 *
 * Usage: node server.js [--port 8123] [--host 127.0.0.1] [--out DIR]
 *        [--wait TARGET] [--timeout SECONDS]
 * With --wait, the process exits 0 once final-<TARGET>.json arrives and is
 * ok:true, 2 if it arrives not-ok, or 3 on timeout — so CI scripts can just
 * run the server in the foreground after launching the browser.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const PORT = Number(opt('port', 8123));
const HOST = opt('host', '127.0.0.1');
const OUT = path.resolve(opt('out', path.join(__dirname, 'reports')));
const WAIT_TARGET = opt('wait', null);
const TIMEOUT_S = Number(opt('timeout', 1800));

fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json'
};

function safeName(s) {
  return String(s || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/probe-report') {
    let body = '';
    req.on('data', function (c) {
      body += c;
      if (body.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', function () {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { /* keep null */ }
      const target = safeName(parsed && parsed.target);
      if (parsed && parsed.kind === 'final') {
        fs.writeFileSync(path.join(OUT, 'final-' + target + '.json'),
          JSON.stringify(parsed.body, null, 2));
        console.log('[server] final report from ' + target + ' ok=' +
          !!(parsed.body && parsed.body.ok));
        if (WAIT_TARGET && target === safeName(WAIT_TARGET)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
          setTimeout(function () {
            process.exit(parsed.body && parsed.body.ok ? 0 : 2);
          }, 250);
          return;
        }
      } else {
        fs.appendFileSync(path.join(OUT, 'progress-' + target + '.log'),
          body + '\n');
        const phase = parsed && parsed.body && parsed.body.phase;
        if (phase) console.log('[server] ' + target + ' progress: ' + phase);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, function () {
  console.log('[server] listening on http://' + HOST + ':' + PORT +
    ' (root ' + ROOT + ', reports ' + OUT + ')');
});

if (WAIT_TARGET) {
  setTimeout(function () {
    console.error('[server] timeout waiting for final report from ' + WAIT_TARGET);
    process.exit(3);
  }, TIMEOUT_S * 1000).unref();
}
