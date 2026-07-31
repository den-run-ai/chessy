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
 * on the fly: install release rA, flip the server to rB behind a long-open
 * active game, request New game, and assert B takes over before the old
 * runtime can replace the save. Every loaded executable asset must carry
 * the DOCUMENT's own release token — online and offline.
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
const displayedToken = (htmlSrc.match(/id="appVersion"[^>]*>Version ([^<]+)</) || [])[1];
const refTokens = Array.from(htmlSrc.matchAll(/\?r=([\w-]+)/g)).map(function (m) { return m[1]; });
const versionedRefs = Array.from(htmlSrc.matchAll(/(?:src|href)="([^"]+\?r=[\w-]+)"/g))
  .map(function (m) { return m[1]; });

check(!!swToken, 'sw.js declares a RELEASE token (' + swToken + ')');
check(/^r\d+$/.test(swToken || ''),
  'the token is rN (numeric): sw.js orders tokens to refuse stale-release refills');
check(inlineToken === swToken, 'index.html CHESSY_RELEASE matches sw.js RELEASE');
check(displayedToken === swToken, 'the visible Version badge matches sw.js RELEASE');
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
  const RA = 'r9000', FAILED = 'r9001', RB = 'r9002';
  const phase = { release: RA, failWorker: false, holdProgress: false };
  let releaseHeldProgress = null;
  let resolveProgressHeld = null;
  const server = http.createServer(function (req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(ROOT, '.' + p);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (file.endsWith(path.sep + 'sw.js') && phase.failWorker) {
      res.writeHead(503, { 'Cache-Control': 'no-store' });
      res.end('worker deliberately unavailable');
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
      function send() {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        });
        res.end(body);
      }
      // A dedicated regression pauses the LAST external script after the
      // early controller snapshot but before the bottom-of-body gate is
      // created. Another page can then install/claim B deterministically.
      if (file.endsWith(path.join('assets', 'progress.js')) && phase.holdProgress) {
        phase.holdProgress = false;
        releaseHeldProgress = send;
        if (resolveProgressHeld) resolveProgressHeld();
        return;
      }
      send();
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
  // Counts full document boots in this tab. The rA load is 1; publishing rB
  // behind the open page triggers one controllerchange reload, reaching 2.
  await page.addInitScript(function () {
    const key = 'chessy-update-test-boots';
    sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1));
  });

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
        engine: typeof Chess !== 'undefined' &&
          typeof ChessyAiTelemetry !== 'undefined',
        ready: document.getElementById('installNote').textContent.indexOf('Ready offline') !== -1,
        version: document.getElementById('appVersion').textContent.trim(),
        update: document.getElementById('updateNote').hidden
          ? '' : document.getElementById('updateNote').textContent.trim(),
        updateSession: sessionStorage.getItem('chessy-update-note-v1') || '',
        boots: Number(sessionStorage.getItem('chessy-update-test-boots') || 0),
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
  check(a.version === 'Version ' + RA, 'the persistent header shows release A');
  check(a.update === '' && a.updateSession === '',
    'a first install does not claim that an update happened');
  for (const tab of ['#tabReview', '#tabTrain', '#tabProgress', '#tabPlay']) {
    await page.click(tab);
    check(await page.locator('#appVersion').isVisible(),
      'the version remains visible in ' + (await page.textContent(tab)).trim());
  }

  // Representative durable user data: the release transition is cache-only
  // and must leave both the saved game area and the coaching database intact.
  await page.evaluate(function () {
    localStorage.setItem('chessy-update-test-game', 'saved');
    return CoachStore.putGame({
      id: 'chessy-update-test-game', sans: [], result: '*',
      reason: 'test', createdAt: 1
    }).then(function () {
      return CoachStore.addCard({
        gameId: 'chessy-update-test-game', ply: 0, due: 1,
        lesson: 'saved training card'
      });
    });
  });
  // Model an r9001 install that opened its cache but failed before precaching
  // index.html. The r9002 activation must report the last COMPLETE release
  // (r9000), never this empty cache name.
  await page.evaluate(function (failed) { return caches.open('chessy-' + failed); }, FAILED);

  // Leave a real active game in the long-open A tab. New game checks A's
  // worker before replacing the save; with no update yet it starts normally.
  await page.click('#newGame');
  await page.click('input[name="mode"][value="pvp"] + span');
  await page.click('#newGameStart');
  await page.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  await page.click('#board .square[data-index="52"]'); // e2
  await page.click('#board .square[data-index="36"]'); // e4
  const activeA = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { id: saved.gameId, plies: saved.history.length };
  });
  check(activeA.plies === 1, 'release A has a synchronously persisted active game');

  // Phase B publishes while that foreground tab remains open: there is no
  // navigation or visibilitychange to discover it. Clicking Start game is
  // the safe-boundary check. The stale callback must NOT replace the active
  // save; B's skipWaiting/claim triggers a reload, and B restores that game.
  phase.release = RB;
  await page.click('#newGame');
  await page.click('#newGameStart');
  const b = await stable(function (s) { return s.token === RB && s.ready && s.controlled; },
    'phase B ready under the new worker');
  const restoredB = await page.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return {
      id: saved.gameId,
      plies: saved.history.length,
      rendered: document.querySelectorAll('#moveList .ply').length
    };
  });
  check(restoredB.id === activeA.id && restoredB.plies === 1 && restoredB.rendered === 1,
    'new release takes control before New game and restores the active A game');
  check(b.mixed.length === 0 && b.engine,
    'update in flight: the B document executes only B asset URLs (' + b.total + ' checked)');
  check(b.build === RB,
    'update in flight: the executed bytes are release B’s, not cached A contents');

  // "controlled" above can still mean the A worker (it controls the page
  // while B installs). Before testing B's OWN cache offline, wait for
  // proof the B worker activated: its activate handler deletes the A
  // cache, so B's cache present + A's gone = takeover complete.
  await stable(function (s) {
    return s.caches.indexOf('chessy-' + RB) !== -1 &&
      s.caches.indexOf('chessy-' + RA) === -1 &&
      s.caches.indexOf('chessy-' + FAILED) === -1;
  }, 'B worker takeover (old caches cleaned)');
  check(true, 'the B worker activates and cleans up complete and failed old caches');
  const expectedUpdate = 'Chessy updated from ' + RA + ' to ' + RB +
    '. Your saved games and training data are unchanged.';
  const noticed = await stable(function (s) {
    return s.version === 'Version ' + RB && s.update === expectedUpdate &&
      s.updateSession.indexOf(RA) !== -1 && s.updateSession.indexOf(RB) !== -1 &&
      s.boots >= 2;
  }, 'post-update version and note');
  check(noticed.version === 'Version ' + RB,
    'the persistent badge advances to the new release');
  check(noticed.update === expectedUpdate,
    'after the automatic reload, the real upgrade reports the last complete release');
  const preserved = await page.evaluate(function () {
    return Promise.all([CoachStore.listGames(), CoachStore.listCards()]).then(function (rows) {
      return {
        game: localStorage.getItem('chessy-update-test-game'),
        archived: rows[0].some(function (g) { return g.id === 'chessy-update-test-game'; }),
        card: rows[1].some(function (c) { return c.lesson === 'saved training card'; })
      };
    });
  });
  check(preserved.game === 'saved' && preserved.archived && preserved.card,
    'the upgrade preserves saved games and training data');

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
    const key = './assets/ai-telemetry.js?r=' + rb;
    return caches.open('chessy-' + rb).then(function (c) {
      return c.delete(key)
        .then(function () { return fetch('assets/ai-telemetry.js?r=' + rb); })
        .then(function (r) {
          // Restore via the UNVERSIONED path (SWR branch hits the network)
          // — cache.add on the versioned URL would just receive the 503.
          return fetch('assets/ai-telemetry.js').then(function (fresh) {
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
    const off = await stable(function (s) {
      return s.token === RB && s.engine && s.update === expectedUpdate && s.boots >= 3;
    }, 'offline reload');
    check(off.mixed.length === 0 && off.build === RB,
      'offline: cached shell, cached assets and executed bytes are all one release');
    check(off.version === 'Version ' + RB && off.update === expectedUpdate,
      'offline reload keeps the new version and the session-scoped update note');
    check(await page.locator('#board .square').count() === 64, 'offline app is functional');
    await context.setOffline(false);
  } else {
    console.log('  --  offline phase skipped (Playwright WebKit cannot emulate SW-served offline navigations)');
  }

  // A new top-level browsing session shares the installed worker/cache but
  // not this tab's sessionStorage. Because the cache marker was consumed,
  // the old update notice must not leak into that fresh session.
  const fresh = await context.newPage();
  await fresh.goto(url);
  await fresh.waitForFunction(function () {
    return document.getElementById('installNote').textContent.indexOf('Ready offline') !== -1;
  });
  const freshState = await fresh.evaluate(inspect);
  check(freshState.version === 'Version ' + RB && freshState.update === '' &&
    freshState.updateSession === '',
    'a fresh browsing session shows the version without replaying the old update note');
  await fresh.close();

  check(errors.length === 0,
    'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await context.close();

  // Registration retry: A loads while its initial worker fetch fails, so the
  // page remains uncontrolled. A later New-game boundary must itself retry
  // registration after B is published. B then becomes this old document's
  // FIRST controller, and its release handshake must fence that same Start
  // request and preserve A's save.
  phase.release = RA;
  phase.failWorker = true;
  const raceContext = await browser.newContext();
  const race = await raceContext.newPage();
  const raceErrors = [];
  race.on('pageerror', function (e) { raceErrors.push(String(e)); });
  await race.addInitScript(function () {
    const key = 'chessy-retry-test-boots';
    sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1));
    window.__chessyListenerCounts = { visibility: 0, updatefound: 0 };
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type) {
      if (type === 'visibilitychange' && this === document) {
        window.__chessyListenerCounts.visibility++;
      } else if (type === 'updatefound' && this && this.constructor &&
          this.constructor.name === 'ServiceWorkerRegistration') {
        window.__chessyListenerCounts.updatefound++;
      }
      return add.apply(this, arguments);
    };
  });
  await race.goto(url);
  await race.waitForFunction(function () {
    return document.getElementById('installNote').textContent
      .indexOf('Offline setup failed') !== -1;
  });
  check(!await race.evaluate(function () {
    return !!navigator.serviceWorker.controller;
  }), 'release A remains uncontrolled after its worker install fails');

  // Recover without changing releases. The boundary-owned retry must run the
  // same UI/listener success path as boot registration, yet accepting A's
  // same-release first claim must not reload this document.
  phase.failWorker = false;
  await race.click('#newGame');
  await race.click('input[name="mode"][value="pvp"] + span');
  await race.click('#newGameStart');
  await race.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open &&
      document.getElementById('installNote').textContent.indexOf('Ready offline') !== -1 &&
      !!navigator.serviceWorker.controller;
  });
  const retryUi = await race.evaluate(function () {
    return {
      token: window.CHESSY_RELEASE,
      note: document.getElementById('installNote').textContent,
      boots: Number(sessionStorage.getItem('chessy-retry-test-boots') || 0),
      listeners: window.__chessyListenerCounts
    };
  });
  check(retryUi.token === RA && retryUi.boots === 1 &&
      retryUi.note.indexOf('Ready offline') !== -1,
    'same-release retry clears the failure note without reloading');
  check(retryUi.listeners.visibility === 2 && retryUi.listeners.updatefound === 1,
    'retry success wires one lifecycle listener set (plus the app visibility listener)');

  // Re-registering at the next boundary returns the same Registration object.
  // Its lifecycle listeners must not multiply.
  await race.click('#newGame');
  await race.click('#newGameStart');
  await race.waitForFunction(function () {
    return !document.getElementById('newGameDialog').open;
  });
  const repeatUi = await race.evaluate(function () {
    return {
      boots: Number(sessionStorage.getItem('chessy-retry-test-boots') || 0),
      listeners: window.__chessyListenerCounts
    };
  });
  check(repeatUi.boots === 1 &&
      repeatUi.listeners.visibility === 2 && repeatUi.listeners.updatefound === 1,
    'repeated successful boundary registration does not duplicate listeners');

  await race.click('#board .square[data-index="52"]'); // e2
  await race.click('#board .square[data-index="36"]'); // e4
  const raceA = await race.evaluate(function () {
    const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { id: saved.gameId, plies: saved.history.length };
  });
  await race.click('#newGame');

  phase.release = RB;
  phase.failWorker = false;
  await race.evaluate(function () {
    sessionStorage.setItem('chessy-registration-retry-start', 'attempted');
  });
  await race.click('#newGameStart');
  const raceB = await (async function () {
    const t0 = Date.now();
    for (;;) {
      let state = null;
      try {
        state = await race.evaluate(function () {
          const saved = JSON.parse(localStorage.getItem('chessy-game-v1'));
          return {
            token: window.CHESSY_RELEASE,
            controlled: !!navigator.serviceWorker.controller,
            ready: document.getElementById('installNote').textContent
              .indexOf('Ready offline') !== -1,
            attempted: sessionStorage.getItem('chessy-registration-retry-start'),
            id: saved && saved.gameId,
            plies: saved && saved.history.length,
            rendered: document.querySelectorAll('#moveList .ply').length
          };
        });
      } catch (e) { /* mid-navigation */ }
      if (state && state.token === RB && state.controlled && state.ready) return state;
      if (Date.now() - t0 > 30000) {
        throw new Error('timeout: first-controller race — last state ' +
          JSON.stringify(state));
      }
      await new Promise(function (r) { setTimeout(r, 200); });
    }
  })();
  check(raceB.attempted === 'attempted',
    'the later Start boundary retries registration without test-side registration');
  check(raceB.id === raceA.id && raceB.plies === 1 && raceB.rendered === 1,
    'the newer first claimant reloads A and preserves its active save');
  check(raceErrors.length === 0,
    'the first-controller race has no page errors' +
      (raceErrors.length ? ': ' + raceErrors.join(' | ') : ''));
  await raceContext.close();

  // Late-initial-controller race: A's head snapshot sees no controller, then
  // parsing pauses at its final external script. A second page installs B,
  // whose clients.claim() makes B visible before A creates its runtime gate.
  // Gate initialization must handshake that ambiguous controller and reload A
  // even though no controllerchange listener existed when the claim happened.
  phase.release = RA;
  phase.failWorker = false;
  phase.holdProgress = true;
  const progressHeld = new Promise(function (resolve) {
    resolveProgressHeld = resolve;
  });
  const initContext = await browser.newContext();
  const initRace = await initContext.newPage();
  const initErrors = [];
  initRace.on('pageerror', function (e) { initErrors.push(String(e)); });
  await initRace.addInitScript(function () {
    const key = 'chessy-init-race-boots';
    sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1));
  });
  const initNavigation = initRace.goto(url).catch(function () {
    // The expected runtime reload may abort the original navigation.
  });
  await progressHeld;
  check(await initRace.evaluate(function () {
    return window.CHESSY_BOOT_CONTROLLER === null &&
      !navigator.serviceWorker.controller;
  }), 'release A records an uncontrolled early snapshot before gate initialization');

  phase.release = RB;
  const publisher = await initContext.newPage();
  await publisher.goto(url);
  await publisher.waitForFunction(function () {
    return !!navigator.serviceWorker.controller &&
      document.getElementById('installNote').textContent.indexOf('Ready offline') !== -1;
  });
  await initRace.waitForFunction(function () {
    return !!navigator.serviceWorker.controller;
  });
  check(await initRace.evaluate(function () {
    return window.CHESSY_BOOT_CONTROLLER === null &&
      !!navigator.serviceWorker.controller;
  }), 'B claims the parsing A page after its snapshot but before gate creation');
  releaseHeldProgress();
  await initNavigation;

  const initializedB = await (async function () {
    const t0 = Date.now();
    for (;;) {
      let state = null;
      try {
        state = await initRace.evaluate(function () {
          return {
            token: window.CHESSY_RELEASE,
            build: window.CHESSY_BUILD,
            controlled: !!navigator.serviceWorker.controller,
            ready: document.getElementById('installNote').textContent
              .indexOf('Ready offline') !== -1,
            boots: Number(sessionStorage.getItem('chessy-init-race-boots') || 0)
          };
        });
      } catch (e) { /* mid-navigation */ }
      if (state && state.token === RB && state.build === RB &&
          state.controlled && state.ready && state.boots >= 2) return state;
      if (Date.now() - t0 > 30000) {
        throw new Error('timeout: late-initial-controller race — last state ' +
          JSON.stringify(state));
      }
      await new Promise(function (r) { setTimeout(r, 200); });
    }
  })();
  check(initializedB.boots >= 2,
    'gate initialization verifies the late controller and reloads into coherent B');
  check(initErrors.length === 0,
    'the late-initial-controller race has no page errors' +
      (initErrors.length ? ': ' + initErrors.join(' | ') : ''));
  await publisher.close();
  await initContext.close();

  await browser.close();
  server.close();
  console.log('sw-update: ' + (failed ? failed + ' FAILED' : 'all checks passed'));
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
