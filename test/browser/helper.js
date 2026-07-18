/*
 * Shared harness for the browser test suites.
 *
 * Serves the repo over a throwaway local HTTP server (fresh origin per run,
 * so service-worker registrations never leak between suites), launches a
 * headless browser via Playwright, and provides the common page helpers.
 *
 * Engine selection: $BROWSER names the Playwright engine (chromium
 * default, webkit, firefox). Package resolution: the full `playwright`
 * package if installed (CI), otherwise `playwright-core` with the
 * executable named by $CHROMIUM_PATH (chromium only).
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

const ENGINE = process.env.BROWSER || 'chromium';

function browserType() {
  let pw;
  try { pw = require('playwright'); }
  catch (e) { pw = require('playwright-core'); }
  if (!pw[ENGINE]) throw new Error('unknown BROWSER engine: ' + ENGINE);
  return pw[ENGINE];
}

function serve() {
  return http.createServer(function (req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    // Minimal same-origin page WITHOUT the app: tests park here to mutate
    // localStorage (the app itself saves on pagehide, which would clobber
    // in-place mutations before a reload could observe them).
    if (p === '/blank') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      // The icon link stops the browser requesting /favicon.ico (a 404
      // there would trip the suites' no-console-errors check).
      res.end('<!doctype html><title>blank</title>' +
              '<link rel="icon" href="icons/icon-192.png">');
      return;
    }
    // Resolve and confine to the repo root: decoded ../ segments must not
    // let the harness serve files outside the project.
    const file = path.resolve(ROOT, '.' + p);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, function (err, data) {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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
    await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    const browser = await browserType().launch(
      ENGINE === 'chromium' && process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH } : {});
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
      // Click a radio pill in the New Game dialog (the input itself is
      // visually hidden; the label span is the tap target).
      pick: async function (name, value) {
        await page.click('input[name="' + name + '"][value="' + value + '"] + span');
      },
      // Rewrite the saved game from OUTSIDE the app, then boot it fresh.
      // The app persists its live state on pagehide, so mutating
      // localStorage and reloading in place would be clobbered by that
      // save; park on the blank page, mutate, then load the app.
      inject: async function (fn, arg) {
        await page.goto(url + 'blank');
        await page.evaluate(fn, arg);
        await page.goto(url);
        await page.waitForSelector('#board .square');
      },
      // Start a game through the New Game dialog; omitted options keep the
      // dialog's current values.
      newGame: async function (opts) {
        opts = opts || {};
        await page.click('#newGame');
        if (opts.mode) await t.pick('mode', opts.mode);
        if (opts.difficulty) await t.pick('difficulty', opts.difficulty);
        if (opts.timeControl) await t.pick('timeControl', opts.timeControl);
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
