/*
 * Release-unit asset coherence (#37).
 *
 * Static gate: the release token must agree everywhere it appears —
 * index.html's inline CHESSY_RELEASE, every ?r= asset reference, and
 * sw.js's RELEASE — and the service worker must precache exactly the
 * versioned URLs the HTML references.
 *
 * Dynamic gate: an old service worker receiving a NEW release must never
 * produce mixed execution (new HTML with old cached scripts or the
 * reverse). This suite serves the repo with the release token rewritten
 * on the fly: install release rA, flip the server to rB, reload under the
 * still-active rA worker, and assert every loaded executable asset always
 * carries the DOCUMENT's own release token — online during the update and
 * offline after it.
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

let passed = 0, failed = 0;
function check(cond, label) {
  console.log((cond ? '  ok  ' : 'FAIL  ') + label);
  if (!cond) failed++;
  else passed++;
}

// ---- Static coherence ----
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const swToken = (swSrc.match(/const RELEASE = '([^']+)'/) || [])[1];
const inlineToken = (htmlSrc.match(/window\.CHESSY_RELEASE = '([^']+)'/) || [])[1];
const refTokens = Array.from(htmlSrc.matchAll(/\?r=([\w-]+)/g)).map(function (m) { return m[1]; });
const versionedRefs = Array.from(htmlSrc.matchAll(/(?:src|href)="([^"]+\?r=[\w-]+)"/g))
  .map(function (m) { return m[1]; });

check(!!swToken, 'sw.js declares a RELEASE token (' + swToken + ')');
check(/^r\d+$/.test(swToken || ''),
  'the token is rN (numeric): sw.js orders tokens to refuse stale-release refills');
check(inlineToken === swToken, 'index.html CHESSY_RELEASE matches sw.js RELEASE');
check(refTokens.length > 0 && refTokens.every(function (t) { return t === swToken; }),
  'every ?r= reference in index.html carries the same token (' + refTokens.length + ' refs)');
check(versionedRefs.every(function (ref) { return swSrc.indexOf(ref.replace('?r=' + swToken, '')) !== -1; }),
  'every versioned index.html reference has a matching sw.js precache entry');
check(swSrc.indexOf("'./assets/ai-worker.js?r=' + RELEASE") !== -1,
  'the worker script is precached under the release token');

// ---- Dynamic old-worker → new-release transition ----
function browserType() {
  let pw;
  try { pw = require('playwright'); }
  catch (e) { pw = require('playwright-core'); }
  const engine = process.env.BROWSER || 'chromium';
  if (!pw[engine]) throw new Error('unknown BROWSER engine: ' + engine);
  return pw[engine];
}

(async function () {
  // Numeric tokens, like production: the worker ORDERS tokens to refuse
  // refilling a stale release's URL from the current deployment.
  const RA = 'r9001', RB = 'r9002';
  const phase = { release: RA };
  const server = http.createServer(function (req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(ROOT, '.' + p);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, function (err, data) {
      if (err) { res.writeHead(404); res.end(); return; }
      let body = data;
      // Only index.html and sw.js embed the token; rewrite it to the
      // current phase so the suite can publish two distinct releases of
      // the SAME working tree.
      if (file.endsWith('index.html') || file.endsWith('sw.js')) {
        body = Buffer.from(data.toString().split(swToken).join(phase.release));
      }
      // Give each release OBSERVABLY DIFFERENT executable bytes: URL
      // checks alone cannot tell whether a worker answered an rB request
      // with cached rA contents. The marker records which release's code
      // actually EXECUTED.
      if (file.endsWith(path.join('assets', 'app.js'))) {
        body = Buffer.concat([Buffer.from(body),
          Buffer.from("\n;window.CHESSY_BUILD = '" + phase.release + "';\n")]);
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    });
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const url = 'http://127.0.0.1:' + server.address().port + '/';

  const browser = await browserType().launch(
    (process.env.BROWSER || 'chromium') === 'chromium' && process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });

  // Reads the page's release plus every executable asset URL. Runs inside
  // whatever document is CURRENT — the auto-reload on service-worker
  // takeover may navigate underneath us, so callers poll via stable().
  const inspect = function () {
    const token = window.CHESSY_RELEASE || '';
    const urls = [];
    document.querySelectorAll('script[src], link[rel="stylesheet"]').forEach(function (el) {
      urls.push(el.src || el.href);
    });
    return caches.keys().then(function (keys) {
      return {
        token: token,
        build: window.CHESSY_BUILD || '',
        mixed: urls.filter(function (u) { return u.indexOf('?r=' + token) === -1; }),
        total: urls.length,
        engine: typeof Chess !== 'undefined' && typeof ChessAI !== 'undefined',
        ready: document.getElementById('installNote').textContent.indexOf('Ready offline') !== -1,
        controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
        caches: keys.filter(function (k) { return k.indexOf('chessy-') === 0; })
      };
    });
  };

  async function stable(pred, label, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      let s = null;
      try { s = await page.evaluate(inspect); } catch (e) { /* mid-navigation */ }
      if (s && pred(s)) return s;
      if (Date.now() - t0 > (timeoutMs || 30000)) {
        throw new Error('timeout: ' + label + ' — last state ' + JSON.stringify(s));
      }
      await new Promise(function (r) { setTimeout(r, 200); });
    }
  }

  // Phase A: first install.
  await page.goto(url);
  const a = await stable(function (s) { return s.ready && s.controlled; }, 'phase A ready');
  check(a.token === RA && a.total >= 4 && a.mixed.length === 0 && a.engine,
    'release A loads coherently (' + a.total + ' assets, 0 mixed)');
  check(a.build === RA, 'release A executes release A BYTES (build marker ' + a.build + ')');

  // Phase B publishes while the A worker still controls the page. The
  // reload's network-first navigation fetches the B shell; its ?r= assets
  // miss the A cache and come from the network — never from the old
  // release's cache. The new worker then installs and takes over.
  phase.release = RB;
  await page.reload();
  const b = await stable(function (s) { return s.token === RB && s.ready && s.controlled; },
    'phase B ready under the new worker');
  check(b.mixed.length === 0 && b.engine,
    'update in flight: the B document executes only B asset URLs (' + b.total + ' checked)');
  check(b.build === RB,
    'update in flight: the executed bytes are release B’s, not cached A contents');

  // "controlled" above can still mean the A worker (it controls the page
  // while B installs). Before testing B's OWN cache offline, wait for
  // proof the B worker activated: its activate handler deletes the A
  // cache, so B's cache present + A's gone = takeover complete.
  await stable(function (s) {
    return s.caches.indexOf('chessy-' + RB) !== -1 && s.caches.indexOf('chessy-' + RA) === -1;
  }, 'B worker takeover (A cache cleaned)');
  check(true, 'the B worker activates and cleans up the A cache');

  // A stale-release URL must NEVER be refilled from the current
  // deployment: the host ignores the token, so the bytes would be B's
  // under A's key — an old page alive across the deploy would execute
  // them. The worker refuses the miss instead.
  const stale = await page.evaluate(function (ra) {
    return fetch('assets/app.js?r=' + ra).then(function (r) {
      return caches.keys().then(function (keys) {
        return { status: r.status, caches: keys };
      });
    });
  }, RA);
  check(stale.status === 503 && stale.caches.indexOf('chessy-' + RA) === -1,
    'a stale release token is refused (503), never refilled from the current deployment');

  // An OWN-token miss (evicted entry) is refused too: this worker cannot
  // know whether a newer deployment is already live, and the host ignores
  // the token — the fetch could return newer bytes under this release's
  // URL. (The entry is restored afterwards: the offline phase needs it.)
  const ownMiss = await page.evaluate(function (rb) {
    const key = './assets/ai.js?r=' + rb;
    return caches.open('chessy-' + rb).then(function (c) {
      return c.delete(key)
        .then(function () { return fetch('assets/ai.js?r=' + rb); })
        .then(function (r) {
          // Restore via the UNVERSIONED path (SWR branch hits the network)
          // — cache.add on the versioned URL would just receive the 503.
          return fetch('assets/ai.js').then(function (fresh) {
            return c.put(key, fresh).then(function () { return r.status; });
          });
        });
    });
  }, RB);
  check(ownMiss === 503, 'an own-token miss is refused as well (evicted entry, deploy state unknown)');

  // Offline after the update: the cached rB shell must request the cached
  // rB assets — still zero cross-release loads. Chromium only: Playwright's
  // WebKit cannot emulate an offline navigation served by a service worker
  // (page.reload dies with an internal error), and the mechanism under test
  // is engine-independent — the coherence assertions above already ran.
  if ((process.env.BROWSER || 'chromium') === 'chromium') {
    await context.setOffline(true);
    await page.reload();
    const off = await stable(function (s) { return s.token === RB && s.engine; }, 'offline reload');
    check(off.mixed.length === 0 && off.build === RB,
      'offline: cached shell, cached assets and executed bytes are all one release');
    check(await page.locator('#board .square').count() === 64, 'offline app is functional');
    await context.setOffline(false);
  } else {
    console.log('  --  offline phase skipped (Playwright WebKit cannot emulate SW-served offline navigations)');
  }

  check(errors.length === 0,
    'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

  await browser.close();
  server.close();
  console.log('sw-update: ' + (failed ? failed + ' FAILED' : 'all checks passed'));
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
