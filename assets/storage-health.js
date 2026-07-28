/*
 * Chessy storage health (#82) — persistence request + usage visibility for
 * the coaching archive.
 *
 * The archive lives in best-effort IndexedDB, which the browser may evict
 * under storage pressure. This module:
 *
 *   - feature-detects navigator.storage.{persisted,persist,estimate} and
 *     degrades to honest "unavailable" answers when any piece is missing;
 *   - requests persistent storage ONCE, after the first successful durable
 *     archive write (a game archived, a PGN imported, or a backup
 *     restored) — never repeatedly on every launch. A settled request
 *     (granted OR denied) is never repeated: denied is a browser/user
 *     decision to respect, not to nag. Only a rejected call (transient API
 *     error) may be retried by a later session.
 *   - answers snapshot()/describe() for the Progress view: persistence
 *     state plus approximate usage/quota, tolerating missing or partial
 *     estimates.
 *
 * Persistence REDUCES eviction exposure; it is not a guarantee. The UI
 * copy says exactly that — JSON backups remain the real safety net. All
 * calls are best-effort and must never block or fail Play, archiving, or
 * coaching.
 */
(function () {
  'use strict';

  var REQUESTED_KEY = 'chessy-persist-requested-v1';
  var attemptedThisLoad = false;

  function manager() {
    try {
      return (typeof navigator !== 'undefined' && navigator.storage) || null;
    } catch (e) { return null; }
  }

  function requestedBefore() {
    // An unreadable flag reads as "already requested": with localStorage
    // blocked we could not record a request, so skipping is the only way to
    // honour "not repeatedly on every launch".
    try { return localStorage.getItem(REQUESTED_KEY) !== null; }
    catch (e) { return true; }
  }

  // Record the request marker and prove it landed. Read-ok/write-fail is the
  // classic full-quota state, so setItem alone is not evidence.
  function markRequested() {
    try {
      localStorage.setItem(REQUESTED_KEY, String(Date.now()));
      return localStorage.getItem(REQUESTED_KEY) !== null;
    } catch (e) { return false; }
  }

  function unmarkRequested() {
    // A failed removal leaves the marker set — the conservative outcome
    // (skip future requests), never a nag.
    try { localStorage.removeItem(REQUESTED_KEY); } catch (e) { /* stays marked */ }
  }

  // Called after a durable archive write commits. At most one persist()
  // attempt per page load, and at most one SETTLED attempt ever. The marker
  // is written BEFORE the request: if it cannot be recorded (storage full or
  // write-blocked), no request is made at all — otherwise a settled denial
  // would be un-recordable and every later launch would re-prompt. Only a
  // rejected/thrown persist() call (transient API error) clears the marker
  // so a later session may retry.
  function noteDurableWrite() {
    var storage = manager();
    if (!storage || typeof storage.persist !== 'function') return;
    if (attemptedThisLoad || requestedBefore()) return;
    attemptedThisLoad = true;
    var persisted;
    try {
      persisted = typeof storage.persisted === 'function'
        ? storage.persisted() : false;
    } catch (e) { persisted = false; }
    Promise.resolve(persisted).catch(function () { return false; })
      .then(function (already) {
        // Already persistent (an installed PWA, an earlier grant): record
        // that so later launches skip the query entirely. Best effort — if
        // the marker cannot land, nothing was asked, so nothing can nag.
        if (already) { markRequested(); return; }
        if (!markRequested()) return; // cannot record a settled answer → don't ask
        var req;
        try { req = storage.persist(); } catch (e) { unmarkRequested(); return; }
        return Promise.resolve(req).then(
          function () { /* settled (granted or denied) — the marker stays */ },
          function () { unmarkRequested(); });
      });
  }

  // { supported, persisted: true|false|null, usage: n|null, quota: n|null }
  // — null always means "could not be determined", never zero.
  function snapshot() {
    var storage = manager();
    var out = { supported: !!storage, persisted: null, usage: null, quota: null };
    if (!storage) return Promise.resolve(out);

    function safeCall(name) {
      try {
        if (typeof storage[name] !== 'function') return Promise.resolve(null);
        return Promise.resolve(storage[name]()).catch(function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    }
    function usable(n) { return typeof n === 'number' && isFinite(n) && n >= 0; }

    return Promise.all([safeCall('persisted'), safeCall('estimate')])
      .then(function (r) {
        if (typeof r[0] === 'boolean') out.persisted = r[0];
        var est = r[1];
        if (est && typeof est === 'object') {
          if (usable(est.usage)) out.usage = est.usage;
          if (usable(est.quota)) out.quota = est.quota;
        }
        return out;
      });
  }

  function fmtBytes(n) {
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + units[i];
  }

  // Pure presentation mapping for a snapshot(), so the view and its tests
  // share one truth. Every partial-estimate shape has an explicit answer.
  function describe(snap) {
    var state;
    if (!snap || !snap.supported) state = 'Unavailable in this browser';
    else if (snap.persisted === true) state = 'On (granted)';
    else if (snap.persisted === false) state = 'Off (not granted)';
    else state = 'Unknown (query failed)';

    var usage;
    if (snap && snap.usage !== null && snap.quota !== null && snap.quota > 0) {
      var pct = (snap.usage / snap.quota) * 100;
      var pctLabel = pct > 0 && pct < 1 ? '<1' : String(Math.round(pct));
      usage = fmtBytes(snap.usage) + ' of ' + fmtBytes(snap.quota) +
        ' (' + pctLabel + '%)';
    } else if (snap && snap.usage !== null) {
      usage = fmtBytes(snap.usage);
    } else if (snap && snap.quota !== null) {
      usage = 'quota ' + fmtBytes(snap.quota);
    } else {
      usage = '—';
    }
    return { state: state, usage: usage };
  }

  window.ChessyStorageHealth = {
    noteDurableWrite: noteDurableWrite,
    snapshot: snapshot,
    describe: describe
  };
})();
