/*
 * Shared harness for the browser test suites.
 *
 * Serves the repo over a throwaway local HTTP server (fresh origin per run,
 * so service-worker registrations never leak between suites), launches
 * headless Chromium via Playwright, and provides the common page helpers.
 *
 * Browser resolution: the full `playwright` package if installed (CI),
 * otherwise `playwright-core` with the executable named by $CHROMIUM_PATH.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png'
};

function chromium() {
  try { return require('playwright').chromium; }
  catch (e) { return require('playwright-core').chromium; }
}

function serve() {
  return http.createServer(function (req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    fs.readFile(path.join(ROOT, p), function (err, data) {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

// Board index of a square name ("e4" -> 36; index 0 = a8).
function idx(name) {
  return 'abcdefgh'.indexOf(name[0]) + (8 - Number(name[1])) * 8;
}

function run(name, suite) {
  (async function () {
    const server = serve();
    await new Promise(function (r) { server.listen(0, r); });
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    const browser = await chromium().launch(
      process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const page = await browser.newPage();

    const errors = [];
    page.on('pageerror', function (e) { errors.push(String(e)); });
    page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });

    let failed = 0;
    const t = {
      page: page,
      url: url,
      idx: idx,
      check: function (cond, label) {
        console.log((cond ? '  ok  ' : 'FAIL  ') + label);
        if (!cond) failed++;
      },
      sq: function (name) { return '#board .square[data-index="' + idx(name) + '"]'; },
      mv: async function (from, to) {
        await page.click(t.sq(from));
        await page.click(t.sq(to));
      },
      // Start a game through the New Game dialog; omitted options keep the
      // dialog's current values.
      newGame: async function (opts) {
        opts = opts || {};
        await page.click('#newGame');
        if (opts.mode) await page.selectOption('#mode', opts.mode);
        if (opts.difficulty) await page.selectOption('#difficulty', opts.difficulty);
        if (opts.timeControl) await page.selectOption('#timeControl', opts.timeControl);
        await page.click('#newGameStart');
      }
    };

    await page.goto(url);
    await page.waitForSelector('#board .square');
    await suite(t);

    t.check(errors.length === 0,
      'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

    await browser.close();
    server.close();
    console.log(name + ': ' + (failed ? failed + ' FAILED' : 'all checks passed'));
    process.exit(failed ? 1 : 0);
  })().catch(function (e) { console.error(e); process.exit(1); });
}

module.exports = { run: run };
