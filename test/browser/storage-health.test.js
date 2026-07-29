/*
 * Storage health (#82): persistence is requested exactly once, AFTER the
 * first durable archive write (never repeatedly on every launch); granted,
 * denied, unavailable and API-error paths all leave Play/coaching working;
 * Progress shows the persistence state and approximate usage, tolerating
 * missing or partial estimates.
 */
'use strict';
require('./helper').run('storage-health', async function (t) {
  const page = t.page, check = t.check;
  const FLAG = 'chessy-persist-requested-v1';

  // ---- Pure presentation mapping first (no stubbing needed). ----
  const desc = await page.evaluate(function () {
    const D = ChessyStorageHealth.describe;
    return {
      unsupported: D({ supported: false, persisted: null, usage: null, quota: null }),
      unknown: D({ supported: true, persisted: null, usage: null, quota: null }),
      usageOnly: D({ supported: true, persisted: false, usage: 1234567, quota: null }),
      quotaOnly: D({ supported: true, persisted: true, usage: null, quota: 2147483648 }),
      tiny: D({ supported: true, persisted: true, usage: 1024, quota: 1073741824 }),
      zeroQuota: D({ supported: true, persisted: true, usage: 5, quota: 0 })
    };
  });
  check(desc.unsupported.state === 'Unavailable in this browser' && desc.unsupported.usage === '—',
    'no StorageManager → honest unavailable state and no usage claim');
  check(desc.unknown.state === 'Unknown (query failed)',
    'a failed persisted() query is reported as unknown, never as off');
  check(desc.usageOnly.usage === '1.2 MB',
    'a usage-only partial estimate shows usage alone (' + desc.usageOnly.usage + ')');
  check(desc.quotaOnly.usage === 'quota 2.0 GB',
    'a quota-only partial estimate is labelled as quota (' + desc.quotaOnly.usage + ')');
  check(desc.tiny.usage === '1.0 KB of 1.0 GB (<1%)',
    'a nonzero share below 1% shows as <1%, not a rounded 0% (' + desc.tiny.usage + ')');
  check(desc.zeroQuota.usage === '5 B',
    'a zero quota cannot divide — usage shows alone (' + desc.zeroQuota.usage + ')');

  // snapshot() sanitizes junk: rejecting persisted(), out-of-range estimate
  // values, or a missing estimate() all become nulls, never fake numbers.
  const snapJunk = await page.evaluate(function () {
    Object.defineProperty(navigator, 'storage', {
      value: {
        persisted: function () { return Promise.reject(new Error('x')); },
        estimate: function () { return Promise.resolve({ usage: -5, quota: NaN }); }
      },
      configurable: true
    });
    return ChessyStorageHealth.snapshot();
  });
  check(snapJunk.supported === true && snapJunk.persisted === null &&
    snapJunk.usage === null && snapJunk.quota === null,
    'a rejecting persisted() and junk estimate values sanitize to null');
  const snapBare = await page.evaluate(function () {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: function () { return Promise.resolve(true); } },
      configurable: true
    });
    return ChessyStorageHealth.snapshot();
  });
  check(snapBare.supported === true && snapBare.persisted === true &&
    snapBare.usage === null && snapBare.quota === null,
    'a StorageManager without estimate() still answers the persistence state');

  // ---- Full-app scenarios: stub navigator.storage BEFORE app scripts. ----
  // ONE init script installed once, switching on a mode value the scenarios
  // store in localStorage: repeated addInitScript calls would accumulate
  // stubs whose relative execution order across navigations is not
  // guaranteed, letting an old mode win a later scenario.
  const MODE_KEY = 'chessy-test-storage-mode';
  await page.addInitScript(function (keys) {
    let m = null;
    try { m = localStorage.getItem(keys.mode); } catch (e) { m = null; }
    if (!m) return; // before any scenario: leave the real navigator.storage
    window.__persistCalls = 0;
    function install(value) {
      try {
        Object.defineProperty(navigator, 'storage', { value: value, configurable: true });
      } catch (e) {
        Object.defineProperty(Navigator.prototype, 'storage', {
          get: function () { return value; }, configurable: true
        });
      }
    }
    if (m === 'absent') { install(undefined); return; }
    if (m === 'blocked-marker') {
      // Block WRITES of the persistence marker only — the read-ok/write-fail
      // shape of a full quota — leaving every other key (game saves, fences)
      // working normally.
      const realSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k) {
        if (k === keys.flag) throw new Error('QuotaExceededError (test)');
        return realSet.apply(this, arguments);
      };
    }
    let granted = m === 'already';
    install({
      persisted: function () { return Promise.resolve(granted); },
      persist: function () {
        window.__persistCalls++;
        if (m === 'error') return Promise.reject(new Error('persist api error'));
        if (m === 'granted') { granted = true; return Promise.resolve(true); }
        return Promise.resolve(false); // denied / blocked-marker
      },
      estimate: function () {
        return Promise.resolve({ usage: 512 * 1024 * 1024, quota: 2 * 1024 * 1024 * 1024 });
      }
    });
  }, { mode: MODE_KEY, flag: FLAG });

  // Fresh app state per scenario (the persist flag, saved game, archive).
  // The mode key is written AFTER the clear so the app navigation — and any
  // mid-scenario reload — boots with exactly this scenario's stub.
  async function resetState(mode) {
    await page.goto(t.url + 'blank');
    await page.evaluate(function (arg) {
      localStorage.clear();
      localStorage.setItem(arg.key, arg.mode);
      return new Promise(function (resolve) {
        const req = indexedDB.deleteDatabase('chessy-coach');
        req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
      });
    }, { key: MODE_KEY, mode: mode });
    await page.goto(t.url);
    await page.waitForSelector('#board .square');
  }

  async function playFinishedGame() {
    await t.newGame({ mode: 'pvp' });
    await t.mv('f2', 'f3'); await t.mv('e7', 'e5');
    await t.mv('g2', 'g4'); await t.mv('d8', 'h4');
    await page.waitForSelector('#gameOverDialog[open]');
    await page.click('#gameOverClose');
    await page.waitForFunction(function () {
      return !document.getElementById('gameOverDialog').open;
    });
  }
  function waitGameCount(n) {
    return page.waitForFunction(function (want) {
      return CoachStore.listGames().then(function (g) { return g.length === want; });
    }, n);
  }
  function persistCalls() {
    return page.evaluate(function () { return window.__persistCalls; });
  }
  function flagSet() {
    return page.evaluate(function (k) { return localStorage.getItem(k) !== null; }, FLAG);
  }
  async function storageStats() {
    await page.click('#tabProgress');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#storageStats dt').length > 0;
    });
    return page.evaluate(function () {
      const out = {};
      const dts = document.querySelectorAll('#storageStats dt');
      const dds = document.querySelectorAll('#storageStats dd');
      dts.forEach(function (dt, i) { out[dt.textContent] = dds[i].textContent; });
      out.note = !document.getElementById('storageNote').hidden;
      return out;
    });
  }

  // --- Granted: the FIRST durable archive write requests persistence once.
  await resetState('granted');
  check((await persistCalls()) === 0 && !(await flagSet()),
    'no persistence request before any durable write');
  await playFinishedGame();
  await page.waitForFunction(function (k) {
    return localStorage.getItem(k) !== null;
  }, FLAG);
  check((await persistCalls()) === 1, 'the first archived game triggers exactly one persist()');
  const grantedStats = await storageStats();
  check(grantedStats['Persistent storage'] === 'On (granted)',
    'Progress shows the granted persistence state');
  check(grantedStats['Storage used'] === '512.0 MB of 2.0 GB (25%)',
    'Progress shows approximate usage of quota (' + grantedStats['Storage used'] + ')');
  check(grantedStats.note === true, 'the no-guarantee explanation is visible');

  // A later launch with more durable writes must NOT re-request.
  await page.goto(t.url);
  await page.waitForSelector('#board .square');
  await playFinishedGame();
  await waitGameCount(2);
  check((await persistCalls()) === 0 && (await flagSet()),
    'a granted request is never repeated on later launches');

  // --- Denied: the answer is recorded and respected — no nagging.
  await resetState('denied');
  await playFinishedGame();
  await page.waitForFunction(function (k) {
    return localStorage.getItem(k) !== null;
  }, FLAG);
  check((await persistCalls()) === 1, 'the denied path still asked exactly once');
  const deniedStats = await storageStats();
  check(deniedStats['Persistent storage'] === 'Off (not granted)',
    'Progress reports a denied request honestly');
  await page.goto(t.url);
  await page.waitForSelector('#board .square');
  await playFinishedGame();
  await waitGameCount(2);
  check((await persistCalls()) === 0,
    'a denial is a settled answer: later launches never nag');

  // --- API error: archiving is unaffected; the request may retry in a
  // LATER session (the pre-armed flag is cleared on rejection) but never
  // twice in one load.
  await resetState('error');
  await playFinishedGame();
  await page.waitForFunction(function () { return window.__persistCalls === 1; });
  await waitGameCount(1);
  await playFinishedGame();
  await waitGameCount(2);
  // The flag is pre-armed before the request and cleared when it rejects —
  // wait for the stable end state rather than sampling mid-transition.
  await page.waitForFunction(function (k) {
    return window.__persistCalls === 1 && localStorage.getItem(k) === null;
  }, FLAG);
  check(true,
    'a rejecting persist() is attempted once per load and clears the pre-armed flag');
  await page.goto(t.url);
  await page.waitForSelector('#board .square');
  await playFinishedGame();
  await page.waitForFunction(function (k) {
    return window.__persistCalls === 1 && localStorage.getItem(k) === null;
  }, FLAG);
  check(true,
    'a later session may retry after a transient API failure');

  // --- Marker write-blocked (read-ok/write-fail quota): never ask at all.
  // A settled denial could not be recorded, so asking would nag on every
  // later launch — the request is suppressed until the marker can land.
  await resetState('blocked-marker');
  await playFinishedGame();
  await waitGameCount(1);
  await page.waitForTimeout(150); // give a wrongful request time to surface
  check((await persistCalls()) === 0 && !(await flagSet()),
    'an unrecordable marker suppresses the persistence request entirely');

  // --- Already persistent (installed PWA): recorded without a request.
  await resetState('already');
  await playFinishedGame();
  await page.waitForFunction(function (k) {
    return localStorage.getItem(k) !== null;
  }, FLAG);
  check((await persistCalls()) === 0,
    'already-persistent storage is recorded without calling persist()');
  const alreadyStats = await storageStats();
  check(alreadyStats['Persistent storage'] === 'On (granted)',
    'Progress shows the pre-granted state');

  // --- No StorageManager at all: everything still works, honestly labelled.
  await resetState('absent');
  await playFinishedGame();
  await waitGameCount(1);
  check(!(await flagSet()), 'no StorageManager → no request, no flag');
  const absentStats = await storageStats();
  check(absentStats['Persistent storage'] === 'Unavailable in this browser' &&
    absentStats['Storage used'] === '—',
    'Progress degrades to unavailable/— without an estimate API');
});
