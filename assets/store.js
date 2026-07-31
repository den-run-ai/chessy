/*
 * Chessy coaching store — the IndexedDB archive behind the coaching
 * features (roadmap #23). Object stores:
 *
 *   games: { id (the game's UUID from app.js), source ('play'), tags,
 *            sans, playerColor, clocks, ai, startedRelease, result, reason,
 *            mode, difficulty, timeControl, plies, createdAt }
 *   cards: { id (auto), gameId, ply, ... } — lesson cards
 *   analyses: { key, gameId, ply, ... } — one bounded engine analysis per
 *            (game, ply, position fingerprint, engine, config); the caller
 *            builds `key` via analysisKey() so the SAME FEN reached with a
 *            different repetition history is a DISTINCT entry. This store is
 *            a RECOMPUTABLE cache with a deterministic growth bound (#82) —
 *            see "Bounded analyses cache" below.
 *   analysisJobs: { gameId, state, cursorPly, moments, ... } — one
 *            reload-safe, resumable two-pass scan per game (Phase 5).
 *
 * The games keyPath is the app's own per-game UUID: a re-shown or revised
 * ending of the same game instance (reload, undo → replay, reopened
 * game-over dialog) overwrites its single record via archiveGame(), while
 * New game/Rematch mint a new UUID and therefore a new record. The store
 * assumes ONE ACTIVE TAB, like the rest of the app (the localStorage save
 * is last-writer-wins); cross-tab semantics are deferred to #44.
 *
 * Everything is promise-based; the DB opens lazily on first use so
 * browsers without IndexedDB (or private modes that block it) fail
 * per-call instead of at load.
 *
 * Note: all *.github.io project sites share one web origin per user, so
 * this archive is reachable by sibling GitHub Pages apps. Fine for a
 * casual training log; a dedicated domain is the fix before anything
 * sensitive is stored (tracked in the coaching roadmap).
 */
(function (global) {
  'use strict';

  const DB_NAME = 'chessy-coach';
  // v5 was the FIRST released schema (v1–v4 only ever existed on pre-release
  // preview branches). v6 adds the analyses + analysisJobs stores.
  //
  // MIGRATIONS ARE NON-DESTRUCTIVE from v5 on. The old code unconditionally
  // deleted EVERY object store in onupgradeneeded and recreated them — safe
  // only because v1–v4 were throwaway previews with no data worth keeping.
  // Applying that to a v5→v6 bump would ERASE every shipped game and lesson
  // card. So we now create only the stores that don't exist yet (fresh
  // install, or a wiped preview) and leave existing v5 data untouched. The
  // preview wipe is scoped to genuinely pre-release versions (oldVersion in
  // 1..4) — never to released data.
  const DB_VERSION = 6;

  let dbPromise = null;
  let opLock = false;

  function setOpLock(on) {
    opLock = !!on;
  }

  function openForWrite() {
    if (opLock) return Promise.reject(new Error('a data operation is in progress'));
    return open().then(function (db) {
      // Recheck after a potentially slow database open. A write requested
      // before the lock must not create its transaction behind the clear.
      if (opLock) throw new Error('a data operation is in progress');
      return db;
    });
  }

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function (e) {
          const db = req.result;
          // A pre-release preview (v1–v4) may hold an incompatible layout
          // and NO data worth migrating — wipe it. A fresh install
          // (oldVersion 0) and any released version (>= 5) are never wiped.
          if (e.oldVersion >= 1 && e.oldVersion < 5) {
            for (const name of Array.from(db.objectStoreNames)) {
              db.deleteObjectStore(name);
            }
          }
          // Create-if-absent: existing v5 stores (and their data) survive.
          if (!db.objectStoreNames.contains('games')) {
            db.createObjectStore('games', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('cards')) {
            const cards = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
            cards.createIndex('due', 'due');
            cards.createIndex('gameId', 'gameId');
          }
          // v6 stores. keyPath 'key' on analyses (caller-built composite);
          // gameId/ply indexed so a game revision can prune stale analyses
          // exactly like cards. One job per game (keyPath 'gameId').
          if (!db.objectStoreNames.contains('analyses')) {
            const analyses = db.createObjectStore('analyses', { keyPath: 'key' });
            analyses.createIndex('gameId', 'gameId');
            analyses.createIndex('gamePly', ['gameId', 'ply']);
          }
          if (!db.objectStoreNames.contains('analysisJobs')) {
            const jobs = db.createObjectStore('analysisJobs', { keyPath: 'gameId' });
            jobs.createIndex('state', 'state');
          }
        };
        req.onsuccess = function () {
          const db = req.result;
          // Yield to future schema upgrades: without this handler an open
          // connection blocks another context's upgrade indefinitely.
          // Closing drops this connection; the next call reopens lazily at
          // the new version.
          db.onversionchange = function () {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
        req.onerror = function () { dbPromise = null; reject(req.error); };
        // A pre-release (v1–v4) context without our onversionchange
        // handler can BLOCK the upgrade indefinitely; without this the
        // promise never settles, every archive call hangs, and no failure
        // note ever appears. Reject so callers surface it; a later call
        // retries once the blocking context is gone.
        req.onblocked = function () {
          dbPromise = null;
          reject(new Error('database upgrade blocked by another open tab'));
        };
      });
    }
    return dbPromise;
  }

  // Run `fn(objectStore)` in a transaction; resolves with the result of the
  // request `fn` returns (or undefined) once the transaction commits.
  function tx(storeName, mode, fn) {
    return (mode === 'readwrite' ? openForWrite() : open()).then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        // Prefer the REQUEST's error: transaction.error can still be null
        // in the bubbled error/abort events, and callers need the real
        // failure to report it.
        t.onerror = function () { reject((req && req.error) || t.error); };
        t.onabort = function () {
          reject((req && req.error) || t.error || new Error('transaction aborted'));
        };
      });
    });
  }

  function putGame(game) {
    return tx('games', 'readwrite', function (s) { return s.put(game); });
  }

  // The same ENDING re-offered (reopened dialog, reload → replayed finish,
  // boot reconcile) — as opposed to a REVISED completion of the instance
  // (close dialog → undo → different finish).
  function sameEnding(a, b) {
    return a.sans.length === b.sans.length &&
      a.sans.every(function (san, i) { return san === b.sans[i]; }) &&
      a.result === b.result && a.reason === b.reason;
  }

  // Archive a finished game or an explicit incomplete checkpoint; resolves
  // with the stored id. The get and put run in ONE readwrite transaction, so
  // a re-offer racing a write cannot interleave.
  //   - no existing record     → stored as-is
  //   - same ending re-offered → overwritten, keeping the EARLIEST known
  //     completion time (listGames sorts by createdAt — a re-shown or
  //     late-reconciled game must not jump the chronology)
  //   - different ending       → overwritten: the instance was revised
  //     (undo → different finish); one instance, one record.
  // SINGLE-TAB model by design: the archive assumes one active tab, like
  // the rest of the app (last-writer-wins localStorage save). Divergent
  // cloned-tab completions are out of scope — tracked in #44.
  function archiveGame(game) {
    return openForWrite().then(function (db) {
      return new Promise(function (resolve, reject) {
        // Includes 'cards'/'analyses'/'analysisJobs': revising an ending in
        // place must ATOMICALLY remove the derived data (lesson cards,
        // engine analyses, scan progress) flagged on the abandoned
        // continuation, in the same transaction that rewrites the game.
        const t = db.transaction(['games', 'cards', 'analyses', 'analysisJobs'], 'readwrite');
        const s = t.objectStore('games');
        const getReq = s.get(game.id);
        let putReq = null;
        // A revised ending replaces the old one under the same id. Anything
        // derived from plies BEYOND the moves the two endings share now
        // references positions this game no longer contains; prune from the
        // FIRST DIVERGENT ply, leaving the shared prefix intact.
        function pruneFromDivergence(id, oldSans, newSans) {
          let p = 0;
          while (p < oldSans.length && p < newSans.length && oldSans[p] === newSans[p]) p++;
          // Cards flagged past the divergence.
          const cc = t.objectStore('cards').index('gameId').openCursor(IDBKeyRange.only(id));
          cc.onsuccess = function () {
            const c = cc.result;
            if (!c) return;
            if (c.value.ply >= p) c.delete();
            c.continue();
          };
          // Engine analyses of positions past the divergence are stale.
          const ac = t.objectStore('analyses').index('gameId').openCursor(IDBKeyRange.only(id));
          ac.onsuccess = function () {
            const a = ac.result;
            if (!a) return;
            if (a.value.ply >= p) a.delete();
            a.continue();
          };
          // The resumable scan: every ply-bearing collection may contain work
          // derived from the abandoned continuation. Keep only entries from
          // the shared prefix, rewind pass 1 to the divergence, and discard all
          // transient pass-2/retry ownership. This reset is unconditional for
          // a revised ending: even if the cursor had not reached `p`, a stale
          // source revision must never make old work render as current.
          //
          // Be deliberately defensive here. analysisJobs is recomputable
          // cache state and an older/partial release may have left a malformed
          // list in it. Archive correctness must not depend on being able to
          // call `.filter()` on that value: malformed lists are emptied rather
          // than aborting the transaction that stores the revised game.
          const jr = t.objectStore('analysisJobs').get(id);
          jr.onsuccess = function () {
            const job = jr.result;
            if (!job) return;
            function plyOf(item) {
              if (Number.isInteger(item)) return item;
              return item && typeof item === 'object' && Number.isInteger(item.ply)
                ? item.ply : null;
            }
            function pruneList(name) {
              if (job[name] === undefined) return;
              if (!Array.isArray(job[name])) { job[name] = []; return; }
              job[name] = job[name].filter(function (item) {
                const ply = plyOf(item);
                return ply !== null && ply >= 0 && ply < p;
              });
            }
            ['candidates', 'shortlist', 'moments', 'unresolved'].forEach(pruneList);

            job.cursorPly = Number.isInteger(job.cursorPly) && job.cursorPly >= 0
              ? Math.min(job.cursorPly, p) : p;
            job.state = 'paused';
            job.pass = 1;
            job.verifyIndex = 0;
            if (Object.prototype.hasOwnProperty.call(job, 'checked')) {
              job.checked = Number.isInteger(job.checked) && job.checked >= 0
                ? Math.min(job.checked, p) : 0;
            }

            // The next controller run must bind itself to the revised game
            // before doing or displaying work. Both revisions are cache
            // metadata, never user data.
            job.sourceRev = null;
            if (Object.prototype.hasOwnProperty.call(job, 'analysisRev')) job.analysisRev = null;
            delete job.retry;
            delete job.error;
            job.updatedAt = Date.now();
            t.objectStore('analysisJobs').put(job);
          };
        }
        getReq.onsuccess = function () {
          const existing = getReq.result;
          const record = Object.assign({}, game);
          if (existing) {
            if (sameEnding(existing, record)) {
              record.createdAt = Math.min(existing.createdAt, record.createdAt);
            } else {
              pruneFromDivergence(game.id, existing.sans, record.sans); // revised ending
            }
          }
          putReq = s.put(record);
        };
        t.oncomplete = function () { resolve(game.id); };
        t.onerror = function () { reject((putReq && putReq.error) || getReq.error || t.error); };
        t.onabort = function () {
          reject((putReq && putReq.error) || getReq.error || t.error ||
            new Error('transaction aborted'));
        };
      });
    });
  }
  function getGame(id) { return tx('games', 'readonly', function (s) { return s.get(id); }); }

  // Import a validated PGN record (see ChessyPGN.toRecord). DEDUPED by its id
  // (external id or content hash): the lookup and the write share ONE
  // transaction, so a record already present is left as-is and a repeated
  // import yields a single game. Resolves 'imported' or 'duplicate'. The
  // record must already be fully validated — this only persists it (commit
  // once, atomically).
  function importGame(record) {
    return openForWrite().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction('games', 'readwrite');
        const s = t.objectStore('games');
        const getReq = s.get(record.id);
        let outcome = 'imported';
        getReq.onsuccess = function () {
          if (getReq.result) { outcome = 'duplicate'; return; } // already have it
          s.add(record);
        };
        t.oncomplete = function () { resolve(outcome); };
        t.onerror = function () { reject(getReq.error || t.error); };
        t.onabort = function () { reject(getReq.error || t.error || new Error('transaction aborted')); };
      });
    });
  }

  function listGames() {
    return tx('games', 'readonly', function (s) { return s.getAll(); })
      .then(function (games) {
        return games.sort(function (a, b) {
          // A damaged timestamp must not throw (BigInt) or poison the
          // comparator (NaN) before Review gets a chance to quarantine the
          // row. Keep valid records newest-first and place suspect rows last.
          var at = a && Number.isFinite(a.createdAt) ? a.createdAt : -Infinity;
          var bt = b && Number.isFinite(b.createdAt) ? b.createdAt : -Infinity;
          return bt - at;
        });
      });
  }

  // Replay the exact archived source to a card ply with the repetition table
  // intact. A FEN alone is insufficient provenance: the same board and clocks
  // reached through a different history can have a different threefold
  // evaluation and therefore a different accepted-move set.
  function replayGameToPly(game, ply) {
    try {
      if (!game || !Array.isArray(game.sans) ||
          !Number.isInteger(ply) || ply < 0 || ply > game.sans.length) {
        return null;
      }
      var state = game.setupFen ?
        Chess.parseFen(game.setupFen) : Chess.newGameState();
      if (!state.positions) {
        state.positions = {};
        state.positions[Chess.positionKey(state)] = 1;
      }
      if (!Array.isArray(state.history)) state.history = [];
      for (var i = 0; i < ply; i++) {
        // An archive cannot supply provenance beyond a terminal position.
        // This includes repetition draws that are invisible in FEN alone.
        if (Chess.gameStatus(state).over) return null;
        var legal = Chess.legalMoves(state);
        var move = legal.find(function (candidate) {
          return Chess.toSan(state, candidate, legal) === game.sans[i];
        });
        if (!move) return null;
        state = Chess.playMove(state, move);
      }
      if (Chess.gameStatus(state).over) return null;
      return { state: state, fen: Chess.toFen(state) };
    } catch (e) {
      return null;
    }
  }

  function addCard(card) {
    return tx('cards', 'readwrite', function (s) { return s.add(card); });
  }
  function updateCard(card) {
    return tx('cards', 'readwrite', function (s) { return s.put(card); });
  }
  function listCards() { return tx('cards', 'readonly', function (s) { return s.getAll(); }); }

  function dueCards(now) {
    return tx('cards', 'readonly', function (s) {
      return s.index('due').getAll(IDBKeyRange.upperBound(now));
    }).then(function (cards) {
      return cards.sort(function (a, b) {
        var ad = a && Number.isFinite(a.due) ? a.due : Infinity;
        var bd = b && Number.isFinite(b.due) ? b.due : Infinity;
        return ad - bd;
      });
    });
  }

  // Atomic read-modify-write for grading: `mutate` runs on the FRESH
  // stored record inside one transaction. `expect` pins the grade to the
  // card revision the player was actually shown — {due, attempts: count}
  // at presentation time. IndexedDB serializes the transactions, so
  // without this check the LOSER of a concurrent grade (another window
  // showing the same due card) would run its mutate on the freshly
  // updated card and append a second attempt / climb a second rung; with
  // it, the stale grade is rejected inside the same transaction.
  // Resolves with the updated record, 'stale' when the expected revision
  // was already consumed, or null when the card is gone.
  function gradeCard(id, expect, mutate) {
    return openForWrite().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction('cards', 'readwrite');
        const s = t.objectStore('cards');
        let outcome = null;
        const getReq = s.get(id);
        getReq.onsuccess = function () {
          const card = getReq.result;
          if (!card) return; // deleted meanwhile — nothing to grade
          if (expect && (card.due !== expect.due ||
              (card.attempts || []).length !== expect.attempts)) {
            outcome = 'stale';
            return;
          }
          outcome = mutate(card) || card;
          s.put(outcome);
        };
        t.oncomplete = function () { resolve(outcome); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  // A reflection verdict is derived from one exact replay source. When the
  // caller supplies that source, check it in the SAME transaction as the card
  // write: a separate getGame() would leave a TOCTOU window in which a revised
  // ending could replace the same id before the stale card lands.
  function sameCardSource(game, expected) {
    if (!game || !expected || game.id !== expected.id) return false;
    const gameSans = Array.isArray(game.sans) ? game.sans : [];
    const expectedSans = Array.isArray(expected.sans) ? expected.sans : [];
    return (game.setupFen || null) === (expected.setupFen || null) &&
      (game.playerColor || null) === (expected.playerColor || null) &&
      gameSans.length === expectedSans.length &&
      gameSans.every(function (san, i) { return san === expectedSans[i]; });
  }

  // ONE card per moment (gameId + ply), enforced atomically: the index
  // lookup and the write share a single readwrite transaction, so two
  // saves racing on the same moment (double-fire, second tab) cannot mint
  // two cards — the loser of the race updates the winner's card instead.
  // With expectedGame, the transaction also proves the archived source is
  // still exact. Resolves 'stale' without writing on a source mismatch,
  // 'updated' when a card for the moment existed, else 'saved'.
  function upsertCardByMoment(fields, freshDefaults, expectedGame) {
    return openForWrite().then(function (db) {
      return new Promise(function (resolve, reject) {
        const guarded = !!expectedGame;
        const t = db.transaction(guarded ? ['games', 'cards'] : 'cards', 'readwrite');
        const s = t.objectStore('cards');
        let cur = null;
        let guardReq = null;
        let outcome = guarded ? 'stale' : 'saved';

        function beginUpsert() {
          outcome = 'saved';
          cur = s.index('gameId').openCursor(IDBKeyRange.only(fields.gameId));
          cur.onsuccess = function () {
            const c = cur.result;
            if (c) {
              if (c.value.ply !== fields.ply) { c.continue(); return; }
              outcome = 'updated';
              const merged = Object.assign({}, c.value, fields);
              // Attempt history is only meaningful against the exact exercise
              // it graded: position/repetition context, canonical move and
              // persisted card evidence. Keeping it across a source revision
              // can make legal/SAN fields describe another board, or make
              // card-evidence provenance point at an accepted set the card no
              // longer carries. Start that history over on any such change.
              const oldBest = c.value.bestMove || null;
              const newBest = fields.bestMove || null;
              const sameBest = (!oldBest && !newBest) || (!!oldBest && !!newBest &&
                oldBest.from === newBest.from && oldBest.to === newBest.to &&
                (oldBest.promotion || null) === (newBest.promotion || null));
              const sameFen =
                (c.value.fenBefore || null) === (merged.fenBefore || null);
              let sameEvidence = false;
              try {
                sameEvidence =
                  JSON.stringify(c.value.equivalence || null) ===
                  JSON.stringify(merged.equivalence || null);
              } catch (e) { /* non-JSON evidence is never the same exercise */ }
              if (!sameBest || !sameFen || !sameEvidence) merged.attempts = [];
              s.put(merged);
            } else {
              s.add(Object.assign({}, freshDefaults, fields));
            }
          };
        }

        if (guarded) {
          guardReq = t.objectStore('games').get(fields.gameId);
          guardReq.onsuccess = function () {
            if (sameCardSource(guardReq.result, expectedGame)) beginUpsert();
          };
        } else {
          beginUpsert();
        }
        t.oncomplete = function () { resolve(outcome); };
        t.onerror = function () {
          reject((cur && cur.error) || (guardReq && guardReq.error) || t.error);
        };
        t.onabort = function () {
          reject((cur && cur.error) || (guardReq && guardReq.error) || t.error ||
            new Error('transaction aborted'));
        };
      });
    });
  }

  // ---- analyses (Phase 1/5) --------------------------------------------
  // One stored analysis per (game, ply, position fingerprint, engine,
  // config). The key MUST fold in everything that can change the result:
  // notably the position fingerprint carries the repetition context, so the
  // SAME FEN reached with a different history — which can score differently
  // (a move that completes a threefold is a draw) — is a distinct entry.
  function analysisKey(gameId, ply, positionFingerprint, engineId, configHash) {
    return [gameId, ply, positionFingerprint, engineId, configHash].join('|');
  }
  function putAnalysis(rec) {
    return tx('analyses', 'readwrite', function (s) { return s.put(rec); });
  }
  function getAnalysis(key) {
    return tx('analyses', 'readonly', function (s) { return s.get(key); });
  }
  // Evict a single cached analysis by key. The reflection layer applies rules
  // the store/service cannot (per-line legality + SAN); when it rejects a
  // served result as unusable it evicts the entry so a retry re-runs the worker
  // instead of serving the same bad cache forever.
  function deleteAnalysis(key) {
    return tx('analyses', 'readwrite', function (s) { return s.delete(key); });
  }
  function listAnalysesForGame(gameId) {
    return tx('analyses', 'readonly', function (s) {
      return s.index('gameId').getAll(IDBKeyRange.only(gameId));
    });
  }

  // ---- Bounded analyses cache (#82) ------------------------------------
  // The analyses store is a recomputable engine cache, so it gets a
  // deterministic growth policy where the durable stores get none:
  //
  //   - COUNT-BOUNDED: above ANALYSES_CACHE_MAX entries, maintenance prunes
  //     the least-recently-used entries down to ANALYSES_CACHE_TRIM_TO. The
  //     hysteresis gap keeps steady-state writes from re-scanning the store
  //     on every put. Count bounds SIZE too: each record is capped by the
  //     analysis-result contract (bounded MultiPV lines and PV lengths over
  //     a bounded legal-root set — a few KB of JSON), so the cache tops out
  //     around single-digit megabytes, far under any realistic quota.
  //   - RECENCY: usedAt (stamped on write, refreshed on validated reuse via
  //     touchAnalysis), falling back to createdAt for records written before
  //     usedAt existed, then 0 — so unstampable legacy rows prune first.
  //     Ties order by key, ascending, so the prune set is deterministic.
  //   - SCOPE: one readwrite transaction over the analyses store ONLY.
  //     Games, cards, review scheduling, and resumable scan state
  //     (analysisJobs) are structurally out of reach of a prune.
  //   - INDEPENDENCE: maintenance runs in its OWN transaction, after — and
  //     never inside — the transaction persisting a fresh analysis, so a
  //     pruning failure cannot abort or discard the result being produced.
  //     `protectKey` additionally pins that fresh record even if a skewed
  //     clock stamped it older than the survivors.
  //
  // No schema bump: usedAt is an optional field and pruning walks the store
  // cursor instead of requiring a new index.
  var ANALYSES_CACHE_MAX = 512;
  var ANALYSES_CACHE_TRIM_TO = 384;

  function analysesCachePolicy() {
    return { max: ANALYSES_CACHE_MAX, trimTo: ANALYSES_CACHE_TRIM_TO };
  }

  function analysisRecency(rec) {
    if (rec && Number.isFinite(rec.usedAt)) return rec.usedAt;
    if (rec && Number.isFinite(rec.createdAt)) return rec.createdAt;
    return 0;
  }

  // Refresh one cached analysis' recency after a validated reuse. Resolves
  // true when the entry existed and was re-stamped; a missing key is a
  // no-op (never creates an entry). Get and put share one transaction so a
  // concurrent eviction cannot resurrect a deleted record.
  function touchAnalysis(key) {
    return openForWrite().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction('analyses', 'readwrite');
        const s = t.objectStore('analyses');
        const getReq = s.get(key);
        let touched = false;
        getReq.onsuccess = function () {
          const rec = getReq.result;
          if (!rec) return;
          rec.usedAt = Date.now();
          s.put(rec);
          touched = true;
        };
        t.oncomplete = function () { resolve(touched); };
        t.onerror = function () { reject(getReq.error || t.error); };
        t.onabort = function () {
          reject(getReq.error || t.error || new Error('transaction aborted'));
        };
      });
    });
  }

  // One bounded maintenance pass over the analyses cache: when the store
  // holds more than ANALYSES_CACHE_MAX entries, delete the least-recently
  // used ones down to ANALYSES_CACHE_TRIM_TO (never touching
  // opts.protectKey). Count check, scan, and deletes share ONE readwrite
  // transaction over analyses only, so the pass is atomic — it either
  // commits whole or leaves the cache exactly as it was — and an under-cap
  // store commits with zero writes. Resolves { count, pruned } where count
  // is the entry count BEFORE pruning. Respects the destructive-operation
  // lock like every other write.
  function maintainAnalysesCache(opts) {
    const protectKey = opts && typeof opts.protectKey === 'string' ? opts.protectKey : null;
    return openForWrite().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction('analyses', 'readwrite');
        const s = t.objectStore('analyses');
        const out = { count: 0, pruned: 0 };
        const countReq = s.count();
        countReq.onsuccess = function () {
          const count = countReq.result;
          out.count = count;
          if (count <= ANALYSES_CACHE_MAX) return; // under cap — zero writes
          const entries = [];
          const cur = s.openCursor();
          cur.onsuccess = function () {
            const c = cur.result;
            if (c) {
              // Only (key, recency) is retained: the walk never materializes
              // the full result payloads outside the cursor step.
              entries.push({ key: c.primaryKey, at: analysisRecency(c.value) });
              c.continue();
              return;
            }
            entries.sort(function (a, b) {
              if (a.at !== b.at) return a.at - b.at;
              return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
            });
            let excess = count - ANALYSES_CACHE_TRIM_TO;
            for (let i = 0; i < entries.length && excess > 0; i++) {
              if (protectKey !== null && entries[i].key === protectKey) continue;
              s.delete(entries[i].key);
              excess--;
              out.pruned++;
            }
          };
        };
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(countReq.error || t.error); };
        t.onabort = function () {
          reject(countReq.error || t.error || new Error('transaction aborted'));
        };
      });
    });
  }

  // ---- analysisJobs (Phase 5) ------------------------------------------
  // One resumable, reload-safe two-pass scan per game, keyed on gameId:
  //   { schema, algorithm, gameId, sourceRev, analysisRev, scanColor,
  //     state, pass, cursorPly, checked, total, candidates, shortlist,
  //     verifyIndex, moments: [{ ply, playedSan }], unresolved, updatedAt }
  // archiveGame() prunes a job from the first divergent ply when its game is
  // revised, so a resume never trusts progress over positions that changed.
  function putJob(job) {
    return tx('analysisJobs', 'readwrite', function (s) { return s.put(job); });
  }
  // Atomically checkpoint a scan only while its archived source is still the
  // exact game the controller opened. A separate getGame() followed by
  // putJob() has a TOCTOU window: a same-id revised ending can commit between
  // them, after which the stale job write would land on the replacement.
  // Sharing one readwrite transaction with `games` gives IndexedDB a single
  // serialization point:
  //   checkpoint first  -> a later archive revision prunes/invalidates it
  //   archive first     -> the guard sees a mismatch and writes nothing
  function sameJobSource(game, expected) {
    if (!game || !expected || game.id !== expected.id) return false;
    function sameArray(a, b) {
      return JSON.stringify(Array.isArray(a) ? a : []) ===
        JSON.stringify(Array.isArray(b) ? b : []);
    }
    return (game.setupFen || null) === (expected.setupFen || null) &&
      (game.playerColor || null) === (expected.playerColor || null) &&
      (game.timeControl || null) === (expected.timeControl || null) &&
      sameArray(game.sans, expected.sans) &&
      sameArray(game.clocks, expected.clocks);
  }
  function putJobIfGame(job, expectedGame) {
    return openForWrite().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(['games', 'analysisJobs'], 'readwrite');
        const getReq = t.objectStore('games').get(job.gameId);
        let putReq = null;
        let wrote = false;
        getReq.onsuccess = function () {
          if (!sameJobSource(getReq.result, expectedGame)) return;
          putReq = t.objectStore('analysisJobs').put(job);
          wrote = true;
        };
        t.oncomplete = function () { resolve(wrote); };
        t.onerror = function () {
          reject((putReq && putReq.error) || getReq.error || t.error);
        };
        t.onabort = function () {
          reject((putReq && putReq.error) || getReq.error || t.error ||
            new Error('transaction aborted'));
        };
      });
    });
  }
  function getJob(gameId) {
    return tx('analysisJobs', 'readonly', function (s) { return s.get(gameId); });
  }
  function deleteJob(gameId) {
    return tx('analysisJobs', 'readwrite', function (s) { return s.delete(gameId); });
  }

  // ---- Backup (Phase 4b2) ----------------------------------------------
  // A versioned JSON snapshot of the DURABLE stores only. games and cards
  // carry everything the user cannot recompute — archived games with clocked
  // moves, and lesson cards with their reflections, attempt history and
  // spaced-review scheduling. `analyses`/`analysisJobs` are engine caches and
  // resumable scan progress: recomputable from the games, so they are OMITTED
  // to keep backups small and portable. `version` is the backup-format
  // version; `dbVersion` is the schema the backup was taken from, so a restore
  // can refuse a backup from a FUTURE schema it cannot understand. `release`
  // identifies the app release that assembled the envelope; game-start and
  // per-AI-move release identifiers remain on the records themselves.
  var BACKUP_FORMAT = 'chessy-coach-backup';
  var BACKUP_VERSION = 1;
  var DURABLE_STORES = ['games', 'cards'];
  // A restore CLEARS the recomputable caches too (they belong to games being
  // removed) but only re-adds the durable rows — so it opens a transaction over
  // all four stores while iterating DURABLE_STORES for the re-add.
  var RESTORE_STORES = ['games', 'cards', 'analyses', 'analysisJobs'];

  function exportAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(DURABLE_STORES, 'readonly');
        var out = { format: BACKUP_FORMAT, version: BACKUP_VERSION, dbVersion: DB_VERSION,
          release: validRelease(global.CHESSY_RELEASE) ? global.CHESSY_RELEASE : null,
          exportedAt: Date.now(), stores: {} };
        DURABLE_STORES.forEach(function (name) {
          var req = t.objectStore(name).getAll();
          req.onsuccess = function () { out.stores[name] = req.result; };
        });
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  // ---- Restore (Phase 4b3) ---------------------------------------------
  // A value usable as an IndexedDB key: string, finite number, valid Date, or
  // an array of those. A record whose keyPath value is anything else would make
  // store.add() throw SYNCHRONOUSLY (DataError) — caught in-transaction below,
  // but rejecting it here means a known-bad backup never opens a transaction.
  function validIdbKey(v) {
    var tp = typeof v;
    if (tp === 'string') return true;
    if (tp === 'number') return isFinite(v);
    if (v instanceof Date) return !isNaN(v.getTime());
    if (Array.isArray(v)) return v.length > 0 && v.every(validIdbKey);
    return false;
  }

  // Strict structural FEN check (Chess.parseFen is deliberately lenient, so it
  // would accept "bad" and yield a broken position that Train's
  // Chess.parseFen(card.fenBefore) then chokes on). Mirrors the six-field
  // validation in pgn.js: 8 ranks each summing to 8 valid squares, exactly one
  // king per side, a legal side to move, and numeric counters. Self-contained
  // so store.js keeps no dependency on the later-loading pgn.js.
  function validFen(fen) {
    if (typeof fen !== 'string') return false;
    var parts = fen.trim().split(/\s+/);
    if (parts.length !== 6) return false;
    var rows = parts[0].split('/');
    if (rows.length !== 8) return false;
    var wk = 0, bk = 0;
    for (var ri = 0; ri < rows.length; ri++) {
      var count = 0;
      for (var ci = 0; ci < rows[ri].length; ci++) {
        var ch = rows[ri][ci];
        if (/[1-8]/.test(ch)) count += Number(ch);
        else if (/[prnbqkPRNBQK]/.test(ch)) { count += 1; if (ch === 'K') wk++; if (ch === 'k') bk++; }
        else return false;
      }
      if (count !== 8) return false;
    }
    if (wk !== 1 || bk !== 1) return false;
    if (parts[1] !== 'w' && parts[1] !== 'b') return false;
    if (!/^(-|K?Q?k?q?)$/.test(parts[2]) || parts[2] === '') return false;
    if (!/^(-|[a-h][36])$/.test(parts[3])) return false;
    if (!/^\d+$/.test(parts[4])) return false;      // halfmove clock
    if (!/^[1-9]\d*$/.test(parts[5])) return false; // fullmove number (>= 1)
    return true;
  }

  function validRelease(value) {
    return typeof value === 'string' && value.length <= 32 &&
      value.trim() === value && /^r\d+$/.test(value);
  }

  function validOptionalAi(ai, plies) {
    if (ai === undefined) return true; // every pre-telemetry backup
    if (!Array.isArray(ai) || ai.length !== plies) return false;
    var reasons = {
      'max-depth': true, 'time-limit': true, 'node-limit': true,
      mate: true, 'game-over': true, unknown: true
    };
    var sources = { worker: true, sync: true, 'sync-fallback': true, unknown: true };
    var fallbacks = { 'worker-error': true, watchdog: true };
    var engines = { js: true, wasm: true };
    var engineFallbacks = { 'wasm-load-error': true, 'wasm-search-error': true };
    function optInt(v) {
      return v === undefined || v === null || (Number.isInteger(v) && v >= 0);
    }
    function optFinite(v) {
      return v === undefined || v === null || (Number.isFinite(v) && v >= 0);
    }
    return ai.every(function (v) {
      if (v === null) return true; // human move
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
      // Legacy debug entries used only depth/quiesce/ms; every added field is
      // optional so those backups remain restorable.
      if (!Number.isInteger(v.depth) || v.depth < 0 ||
          typeof v.quiesce !== 'boolean' ||
          !Number.isFinite(v.ms) || v.ms < 0 ||
          !optInt(v.attemptedDepth) ||
          !optInt(v.maxDepth) || !optInt(v.timeMs) || !optInt(v.nodeLimit) ||
          !optInt(v.nodes) || !optInt(v.qnodes) || !optInt(v.cutoffs) ||
          !optInt(v.researches) || !optFinite(v.elapsedMs) ||
          !optFinite(v.searchMs)) return false;
      if (v.release !== undefined && v.release !== null &&
          !validRelease(v.release)) return false;
      if (v.seed !== undefined && v.seed !== null &&
          (!Number.isInteger(v.seed) || (v.seed | 0) !== v.seed)) return false;
      if (v.randomize !== undefined && v.randomize !== null &&
          typeof v.randomize !== 'boolean') return false;
      if (v.score !== undefined && v.score !== null && !Number.isFinite(v.score)) return false;
      if (v.scorePov !== undefined && v.scorePov !== null && v.scorePov !== 'white') return false;
      if (v.stopReason !== undefined && !reasons[v.stopReason]) return false;
      if (v.source !== undefined && !sources[v.source]) return false;
      if (v.fallbackReason !== undefined && v.fallbackReason !== null &&
          !fallbacks[v.fallbackReason]) return false;
      // A missing engine is pre-WASM telemetry (JavaScript by construction).
      // Retired JavaScript/fallback values remain valid archive evidence, but
      // current runtime writes are WASM/worker only. A non-null engine fallback
      // therefore pairs only with the historical JavaScript engine.
      if (v.engine !== undefined && v.engine !== null &&
          !engines[v.engine]) return false;
      if (v.engineFallback !== undefined && v.engineFallback !== null &&
          (!engineFallbacks[v.engineFallback] || v.engine !== 'js')) {
        return false;
      }
      if (v.pvSource !== undefined && v.pvSource !== null &&
          v.pvSource !== 'final-tt-best-effort') return false;
      if (v.pvUci !== undefined &&
          (!Array.isArray(v.pvUci) || v.pvUci.length > 64 ||
           !v.pvUci.every(function (u) {
             return typeof u === 'string' &&
               /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u);
           }))) return false;
      if (Object.prototype.hasOwnProperty.call(v, 'rootOrderUci')) {
        if (!Array.isArray(v.rootOrderUci) || v.rootOrderUci.length > 256) return false;
        var seenRoot = Object.create(null);
        if (!v.rootOrderUci.every(function (u) {
          if (typeof u !== 'string' ||
              !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u) || seenRoot[u]) return false;
          seenRoot[u] = true;
          return true;
        })) return false;
      }
      return true;
    });
  }

  // A captured root order is reproducible only when it is the COMPLETE legal
  // root permutation for the position before that recorded move. Syntax and
  // uniqueness alone are insufficient: replayRootMoves() deliberately falls
  // back to a fresh shuffle when the list is incomplete or from another
  // position, which would make restored "provenance" silently non-replayable.
  //
  // A MISSING list remains valid for legacy telemetry that predates root
  // capture. Once the property is present it must be complete; accepting an
  // explicit [] would make evidence erasure indistinguishable from legacy
  // data. Lists are checked while replaying the canonical SAN prefix,
  // including custom SetUp/FEN games.
  function validAiRootOrders(record) {
    if (!Array.isArray(record.ai) ||
        !record.ai.some(function (entry) {
          return entry && Object.prototype.hasOwnProperty.call(
            entry, 'rootOrderUci');
        })) {
      return true;
    }
    if (typeof Chess === 'undefined' ||
        typeof Chess.legalMoves !== 'function' ||
        typeof Chess.toSan !== 'function' ||
        typeof Chess.applyMove !== 'function') {
      return false;
    }

    var state;
    try {
      state = record.setupFen
        ? Chess.parseFen(record.setupFen) : Chess.newGameState();
    } catch (e) {
      return false;
    }

    function uci(move) {
      return Chess.sqName(move.from) + Chess.sqName(move.to) +
        (move.promotion ? move.promotion.toLowerCase() : '');
    }

    for (var i = 0; i < record.sans.length; i++) {
      var legal;
      try {
        legal = Chess.legalMoves(state);
      } catch (e) {
        return false;
      }
      var entry = record.ai[i];
      if (entry && Object.prototype.hasOwnProperty.call(
        entry, 'rootOrderUci')) {
        var order = entry.rootOrderUci;
        if (!Array.isArray(order)) return false;
        if (order.length !== legal.length) return false;
        var expected = Object.create(null);
        for (var li = 0; li < legal.length; li++) expected[uci(legal[li])] = true;
        for (var oi = 0; oi < order.length; oi++) {
          if (!expected[order[oi]]) return false;
          delete expected[order[oi]];
        }
        if (Object.keys(expected).length !== 0) return false;
      }

      var move = legal.find(function (candidate) {
        return Chess.toSan(state, candidate, legal) === record.sans[i];
      });
      if (!move) return false;
      state = Chess.applyMove(state, move);
    }
    return true;
  }

  // Review/clean-export trust boundary. It validates only the durable game
  // score and the fields Review dereferences; optional forensic engine
  // telemetry is checked separately so damage there cannot hide an otherwise
  // recoverable board score or clean PGN.
  function validateGameReplayRecord(r, prefix) {
    prefix = prefix || 'game record';
    if (!r || typeof r !== 'object' || Array.isArray(r) ||
        typeof r.id !== 'string' || !Array.isArray(r.sans)) {
      return prefix + ' is missing required fields';
    }
    if (!r.sans.every(function (san) {
      return typeof san === 'string' && san.length > 0;
    })) {
      return prefix + ' has an invalid move list';
    }
    // Review renders result / plies / createdAt directly; missing values show
    // as "undefined", "NaN moves", "Invalid Date".
    if (typeof r.result !== 'string' || !r.result) {
      return prefix + ' is missing a result';
    }
    if (!Number.isInteger(r.plies) || r.plies !== r.sans.length) {
      return prefix + ' has an invalid plies count';
    }
    if (!Number.isFinite(r.createdAt)) {
      return prefix + ' has a non-numeric createdAt';
    }
    if (r.setupFen && !validFen(r.setupFen)) {
      return prefix + ' has an invalid setupFen';
    }
    return null;
  }

  // Full shared game-record trust boundary used by backup restore, raw
  // pending-archive export and debug-PGN export. A recovery export must never
  // emit a row that this same release would refuse to restore.
  function validateGameRecord(r, prefix) {
    prefix = prefix || 'game record';
    var replayError = validateGameReplayRecord(r, prefix);
    if (replayError) return replayError;
    if (r.startedRelease !== undefined && r.startedRelease !== null &&
        !validRelease(r.startedRelease)) {
      return prefix + ' has an invalid startedRelease';
    }
    if (!validOptionalAi(r.ai, r.plies)) {
      return prefix + ' has invalid AI telemetry';
    }
    if (!validAiRootOrders(r)) {
      return prefix + ' has AI telemetry with a root order that does not match its position';
    }
    return null;
  }

  // Optional versioned equivalence evidence on a card (Train v2 E2, #76):
  // the accepted-move set Train grades alternative answers against, with
  // criterion/provider provenance and coverage. ABSENT (or null) is the
  // legacy shape and always valid; once present it must be internally
  // coherent AND agree with the card and position it grades — a forged or
  // damaged accepted set would otherwise auto-accept arbitrary moves.
  function validateCardEquivalence(eq, state, legal, cardBestUci, prefix) {
    function bad(what) { return prefix + ' has equivalence evidence with ' + what; }
    if (!eq || typeof eq !== 'object' || Array.isArray(eq)) {
      return prefix + ' has non-object equivalence evidence';
    }
    // Present evidence is consumed as a positive grading trust boundary.
    // Legacy cards without it remain valid, but a release missing either
    // validator must fail closed instead of accepting a set it cannot check.
    if (typeof global.ChessyAnalysisResult === 'undefined' ||
        typeof global.ChessyAnalysisResult.validEval !== 'function' ||
        typeof global.ChessyEquivalence === 'undefined' ||
        typeof global.ChessyEquivalence.comparePersisted !== 'function') {
      return bad('unavailable validation support');
    }
    var c = eq.criterion;
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id ||
        !Number.isInteger(c.version) || c.version < 1 ||
        typeof c.basis !== 'string' || !c.basis ||
        !c.params || typeof c.params !== 'object' || Array.isArray(c.params)) {
      return bad('an invalid criterion');
    }
    var p = eq.provider;
    if (!p || typeof p !== 'object' ||
        typeof p.engineId !== 'string' || !p.engineId ||
        typeof p.version !== 'string' || !p.version ||
        typeof p.configHash !== 'string' || !p.configHash) {
      return bad('an invalid provider');
    }
    if (typeof eq.positionFingerprint !== 'string' || !eq.positionFingerprint) {
      return bad('an invalid position fingerprint');
    }
    if (eq.turn !== state.turn) return bad('a turn that contradicts fenBefore');
    if (!Number.isInteger(eq.depth) || eq.depth < 1) return bad('an invalid depth');
    // Evidence may only come from a COMPLETE analysis (the criterion refuses
    // partial results), so a stored partial marker is malformed by definition.
    if (eq.complete !== true) return bad('a non-complete evidence marker');
    if (eq.coverage !== 'all-roots' && eq.coverage !== 'candidates') {
      return bad('an unknown coverage');
    }
    if (eq.legalRootCount !== legal.length) {
      return bad('a legal-root count that contradicts fenBefore');
    }
    if (!Number.isInteger(eq.candidateLineCount) || eq.candidateLineCount < 1 ||
        eq.candidateLineCount > legal.length) {
      return bad('an invalid candidate-line count');
    }
    if (eq.coverage === 'all-roots' && eq.candidateLineCount !== legal.length) {
      return bad('all-roots coverage without all roots');
    }
    if (eq.coverage === 'candidates' && eq.candidateLineCount >= legal.length) {
      return bad('candidate coverage that contains all roots');
    }
    if (!Number.isInteger(eq.coveredRootCount) ||
        eq.coveredRootCount < eq.candidateLineCount ||
        eq.coveredRootCount > legal.length ||
        eq.coveredRootCount > eq.candidateLineCount + 1) {
      return bad('an invalid covered-root count');
    }
    if (eq.stability !== null && eq.stability !== undefined) {
      var st = eq.stability;
      if (!st || typeof st !== 'object' || Array.isArray(st) ||
          !Array.isArray(st.depths) ||
          st.depths.length !== 2 ||
          st.depths[0] !== eq.depth - 1 || st.depths[1] !== eq.depth ||
          typeof st.bestMoveStable !== 'boolean') {
        return bad('invalid stability evidence');
      }
    }
    var legalUci = Object.create(null);
    legal.forEach(function (m) {
      var uci = Chess.sqName(m.from) + Chess.sqName(m.to) +
        (m.promotion ? m.promotion.toLowerCase() : '');
      legalUci[uci] = {
        move: m,
        san: Chess.toSan(state, m, legal)
      };
    });
    function entryError(e) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return 'a non-object move entry';
      if (typeof e.uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(e.uci) ||
          !legalUci[e.uci]) {
        return 'a move entry that is not legal in fenBefore';
      }
      if (e.san !== legalUci[e.uci].san) {
        return 'a move entry with non-canonical SAN';
      }
      if (!global.ChessyAnalysisResult.validEval(e, state.turn)) {
        return 'a move entry with an invalid evaluation';
      }
      return null;
    }
    var bestErr = entryError(eq.best);
    if (bestErr) return bad(bestErr + ' (best)');
    var criterionCheck = global.ChessyEquivalence.comparePersisted(
      c, eq.best, eq.best, state.turn);
    if (!criterionCheck.ok) return bad('an unsupported criterion');
    // The evidence must grade THIS card: a best move disagreeing with the
    // card's saved bestMove would let Train accept moves against a different
    // verdict than the one the player approved.
    if (eq.best.uci !== cardBestUci) {
      return bad('a best move that contradicts the card');
    }
    if (!Array.isArray(eq.accepted) || eq.accepted.length < 1 ||
        eq.accepted.length > eq.coveredRootCount) {
      return bad('an invalid accepted set');
    }
    var seen = Object.create(null);
    for (var ai = 0; ai < eq.accepted.length; ai++) {
      var accErr = entryError(eq.accepted[ai]);
      if (accErr) return bad(accErr + ' (accepted ' + ai + ')');
      if (seen[eq.accepted[ai].uci]) return bad('a duplicate accepted move');
      var comparison = global.ChessyEquivalence.comparePersisted(
        c, eq.best, eq.accepted[ai], state.turn);
      if (!comparison.ok || !comparison.acceptable) {
        return bad('an accepted move that contradicts the criterion');
      }
      if (!comparison.bestNotWorse) {
        return bad('an accepted move that outranks the claimed best');
      }
      if (eq.accepted[ai].uci === eq.best.uci &&
          !comparison.sameEvaluation) {
        return bad('an accepted best move with a contradictory evaluation');
      }
      seen[eq.accepted[ai].uci] = true;
    }
    if (!seen[eq.best.uci]) return bad('an accepted set omitting the best move');
    return null;
  }

  // Shared card-record trust boundary. Restore uses this before replacing the
  // archive; Train also uses it after a raw IndexedDB read so one damaged row
  // cannot make otherwise valid due cards disappear. This is deliberately
  // validation only: callers quarantine bad rows in memory and never rewrite
  // or delete the stored source.
  function validateCardRecord(r, prefix, sourceGame) {
    prefix = prefix || 'card record';
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return prefix + ' is not an object';
    }
    if (typeof r.gameId !== 'string') {
      return prefix + ' is missing a gameId';
    }
    if (!Number.isInteger(r.ply) || r.ply < 0) {
      return prefix + ' has an invalid ply';
    }
    // Train dereferences fenBefore with Chess.parseFen. parseFen is lenient,
    // so use the strict six-field validator before the view touches it.
    if (!validFen(r.fenBefore)) {
      return prefix + ' has an invalid fenBefore';
    }
    // A due card must describe an exercise the board can actually present.
    // Quarantine terminal positions and stale/forged best moves before the
    // earliest bad card can block every valid card behind it.
    if (typeof Chess === 'undefined' ||
        typeof Chess.parseFen !== 'function' ||
        typeof Chess.gameStatus !== 'function' ||
        typeof Chess.legalMoves !== 'function' ||
        typeof Chess.toSan !== 'function' ||
        typeof Chess.sqName !== 'function') {
      return prefix + ' cannot be checked by this release';
    }
    var cardBestUci = null;
    var state = null;
    var legal = null;
    try {
      state = Chess.parseFen(r.fenBefore);
      if (Chess.gameStatus(state).over) {
        return prefix + ' has a terminal training position';
      }
      legal = Chess.legalMoves(state);
      var best = legal.find(function (move) {
        return r.bestMove && move.from === r.bestMove.from &&
          move.to === r.bestMove.to &&
          (move.promotion || null) === (r.bestMove.promotion || null);
      });
      if (!best) {
        return prefix + ' has an illegal bestMove';
      }
      if (typeof r.bestSan !== 'string' ||
          Chess.toSan(state, best, legal) !== r.bestSan) {
        return prefix + ' has an invalid bestSan';
      }
      cardBestUci = Chess.sqName(best.from) + Chess.sqName(best.to) +
        (best.promotion ? best.promotion.toLowerCase() : '');
      // Optional equivalence evidence (Train v2 E2): absent/null is the
      // legacy shape; present must cohere with this exact position and card.
      if (r.equivalence !== undefined && r.equivalence !== null) {
        var eqError = validateCardEquivalence(
          r.equivalence, state, legal, cardBestUci, prefix);
        if (eqError) return eqError;
        // Positive evidence is safe to consume only when its fingerprint
        // reproduces from the card's actual archived game and ply. Merely
        // persisting another repetition map beside the evidence would not
        // establish this link: a forged backup could transplant both.
        if (!sourceGame || sourceGame.id !== r.gameId ||
            !Array.isArray(sourceGame.sans) ||
            r.ply >= sourceGame.sans.length) {
          return prefix + ' has equivalence evidence without its source game and ply';
        }
        var source = replayGameToPly(sourceGame, r.ply);
        if (!source || source.fen !== r.fenBefore) {
          return prefix + ' has equivalence evidence from a different source position';
        }
        if (typeof global.ChessyAnalysisCore === 'undefined' ||
            typeof global.ChessyAnalysisCore.positionFingerprint !== 'function') {
          return prefix + ' cannot be checked by this release';
        }
        var expectedFingerprint =
          global.ChessyAnalysisCore.positionFingerprint(
            source.state, source.state.positions);
        if (r.equivalence.positionFingerprint !== expectedFingerprint) {
          return prefix + ' has equivalence evidence from a different repetition history';
        }
      }
      // Train v2 E3 (#76): new reflections carry a versioned, legal
      // Calculation record. Legacy reflection objects remain readable, but
      // once a schema marker is present the complete structure is a trust
      // boundary inherited by Train and backup restore.
      if (r.reflection !== undefined) {
        if (!r.reflection || typeof r.reflection !== 'object' ||
            Array.isArray(r.reflection)) {
          return prefix + ' has a non-object reflection';
        }
        if (Object.prototype.hasOwnProperty.call(r.reflection, 'schema')) {
          if (typeof global.ChessyCalculation === 'undefined' ||
              typeof global.ChessyCalculation.validate !== 'function') {
            return prefix + ' cannot validate its structured reflection';
          }
          if (!sourceGame || sourceGame.id !== r.gameId ||
              !Array.isArray(sourceGame.sans) ||
              r.ply >= sourceGame.sans.length) {
            return prefix + ' has a structured reflection without its source game and ply';
          }
          if (typeof r.playedSan !== 'string' ||
              r.playedSan !== sourceGame.sans[r.ply]) {
            return prefix + ' has a structured reflection for a different played move';
          }
          var reflectionSource = replayGameToPly(sourceGame, r.ply);
          if (!reflectionSource || reflectionSource.fen !== r.fenBefore) {
            return prefix + ' has a structured reflection from a different source position';
          }
          var sourceLegal = Chess.legalMoves(reflectionSource.state);
          var sourcePlayed = sourceLegal.some(function (move) {
            return Chess.toSan(reflectionSource.state, move, sourceLegal) ===
              r.playedSan;
          });
          if (!sourcePlayed) {
            return prefix + ' has an illegal structured-reflection source move';
          }
          var reflectionError = global.ChessyCalculation.validate(
            r.reflection, reflectionSource.state);
          if (reflectionError) {
            return prefix + ' has ' + reflectionError;
          }
        }
      }
    } catch (e) {
      return prefix + ' has an unusable training position';
    }
    if (!Number.isFinite(r.due)) {
      return prefix + ' has a non-numeric due';
    }
    // Progress iterates attempts and Train appends to it. Missing is the
    // legacy empty value; present-but-not-an-array cannot be used safely.
    if (r.attempts !== undefined && !Array.isArray(r.attempts)) {
      return prefix + ' has a non-array attempts';
    }
    if (Array.isArray(r.attempts) && !r.attempts.every(function (a) {
      var GRADES = ['good', 'hard', 'again'];
      if (!a || typeof a !== 'object' || Array.isArray(a) ||
          !Number.isFinite(a.at) || GRADES.indexOf(a.grade) < 0 ||
          typeof a.correct !== 'boolean') {
        return false;
      }
      // Legacy attempts are exactly the shipped {at, grade, correct} shape.
      // Once ANY E2 field is present, require the complete enriched record:
      // optional-at-the-schema-level must not mean a half-written provenance
      // object can survive restore.
      var fields = [
        'attemptedUci', 'attemptedSan', 'verdict', 'verdictReason',
        'equivalent', 'gapCp', 'evidenceSource', 'criterion', 'provider',
        'recommendedGrade', 'presentedDue', 'priorStep'
      ];
      var enriched = fields.some(function (name) {
        return Object.prototype.hasOwnProperty.call(a, name);
      });
      if (!enriched) return true;
      if (!fields.every(function (name) {
        return Object.prototype.hasOwnProperty.call(a, name);
      })) return false;

      if (typeof a.attemptedUci !== 'string' ||
          !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(a.attemptedUci) ||
          typeof a.attemptedSan !== 'string' || !a.attemptedSan ||
          !Number.isFinite(a.presentedDue) ||
          !Number.isInteger(a.priorStep) || a.priorStep < -1 || a.priorStep > 5) {
        return false;
      }
      var attemptedMove = legal.find(function (move) {
        return Chess.sqName(move.from) + Chess.sqName(move.to) +
          (move.promotion ? move.promotion.toLowerCase() : '') === a.attemptedUci;
      });
      if (!attemptedMove ||
          Chess.toSan(state, attemptedMove, legal) !== a.attemptedSan ||
          a.correct !== (a.attemptedUci === cardBestUci)) {
        return false;
      }

      var verdictOk = a.verdict === null || a.verdict === 'best' ||
        a.verdict === 'equivalent' || a.verdict === 'not-equivalent' ||
        a.verdict === 'unknown';
      var reasonOk = a.verdictReason === null ||
        (typeof a.verdictReason === 'string' && !!a.verdictReason);
      var sourceOk = a.evidenceSource === null ||
        a.evidenceSource === 'card-evidence' ||
        a.evidenceSource === 'live-analysis';
      var maxGap = global.ChessyAnalysisResult &&
        global.ChessyAnalysisResult.MAX_CP_ABS * 2;
      var gapOk = a.gapCp === null ||
        (Number.isSafeInteger(a.gapCp) && a.gapCp >= 0 &&
         Number.isSafeInteger(maxGap) && a.gapCp <= maxGap);
      var recommendedOk = a.recommendedGrade === null ||
        GRADES.indexOf(a.recommendedGrade) >= 0;
      if (!verdictOk || !reasonOk || !sourceOk || !gapOk || !recommendedOk) {
        return false;
      }

      var expectedEquivalent =
        a.verdict === 'best' || a.verdict === 'equivalent' ? true
          : a.verdict === 'not-equivalent' ? false : null;
      if (a.equivalent !== expectedEquivalent) return false;
      if (a.verdict === null && a.verdictReason !== null) return false;
      if (a.verdict !== null && !a.verdictReason) return false;

      function validCriterion(value) {
        var current = global.ChessyEquivalence &&
          global.ChessyEquivalence.CRITERION;
        return !!value && typeof value === 'object' && !Array.isArray(value) &&
          !!current && value.id === current.id &&
          value.version === current.version;
      }
      function validProvider(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value) &&
          typeof value.engineId === 'string' && !!value.engineId &&
          typeof value.version === 'string' && !!value.version &&
          typeof value.configHash === 'string' && !!value.configHash;
      }
      function sameProvider(left, right) {
        return validProvider(left) && validProvider(right) &&
          left.engineId === right.engineId &&
          left.version === right.version &&
          left.configHash === right.configHash;
      }
      function oneOf(value, values) {
        return values.indexOf(value) >= 0;
      }
      if (a.evidenceSource === null) {
        if (a.criterion !== null || a.provider !== null || a.gapCp !== null ||
            (a.verdict !== null && a.verdict !== 'unknown')) {
          return false;
        }
        if ((a.verdict === null && a.verdictReason !== null) ||
            (a.verdict === 'unknown' &&
             (a.correct || a.verdictReason !== 'not-covered'))) {
          return false;
        }
      } else if (!validCriterion(a.criterion) || !validProvider(a.provider) ||
                 a.verdict === null) {
        return false;
      }
      if (a.evidenceSource === 'card-evidence') {
        var cardEq = r.equivalence;
        if (!cardEq || !cardEq.criterion ||
            a.criterion.id !== cardEq.criterion.id ||
            a.criterion.version !== cardEq.criterion.version ||
            !sameProvider(a.provider, cardEq.provider)) {
          return false;
        }
        if (a.verdict === 'best') {
          if (!a.correct || a.verdictReason !== 'saved-best' ||
              a.attemptedUci !== cardEq.best.uci ||
              a.gapCp !== (cardEq.best.mate ? null : 0)) {
            return false;
          }
        } else if (a.verdict === 'equivalent') {
          var accepted = cardEq.accepted.find(function (entry) {
            return entry.uci === a.attemptedUci;
          });
          if (a.correct || !accepted || accepted.uci === cardEq.best.uci ||
              a.verdictReason !== 'accepted-set') {
            return false;
          }
          var acceptedGap =
            !accepted.mate && !cardEq.best.mate &&
            Number.isFinite(accepted.scoreCpPlayer) &&
            Number.isFinite(cardEq.best.scoreCpPlayer)
              ? cardEq.best.scoreCpPlayer - accepted.scoreCpPlayer : null;
          if (a.gapCp !== acceptedGap) return false;
        } else {
          return false;
        }
      }
      if (a.evidenceSource === 'live-analysis') {
        if (a.correct) return false;
        var liveReasonOk =
          (a.verdict === 'best' && a.verdictReason === 'engine-best') ||
          (a.verdict === 'equivalent' && oneOf(a.verdictReason, [
            'forced-mate-either-way', 'attempt-not-worse',
            'equal-resistance', 'within-tolerance'
          ])) ||
          (a.verdict === 'not-equivalent' && oneOf(a.verdictReason, [
            'faster-mate-against', 'walks-into-mate',
            'missed-forced-mate', 'cp-gap'
          ])) ||
          (a.verdict === 'unknown' && oneOf(a.verdictReason, [
            'not-covered', 'unstable-best'
          ]));
        if (!liveReasonOk) return false;
      }

      var expectedRecommendation =
        a.verdict === 'best' || a.verdict === 'equivalent' ? 'good'
          : a.verdict === 'not-equivalent' ? 'again' : null;
      // An exact saved move without equivalence evidence is still a narrow
      // historic `correct` answer and receives Good despite verdict=null.
      if (a.verdict === null && a.correct && a.evidenceSource === null) {
        expectedRecommendation = 'good';
      }
      if (a.recommendedGrade !== expectedRecommendation) return false;
      if (a.verdict === 'best' && a.gapCp !== null && a.gapCp !== 0) {
        return false;
      }
      if (a.evidenceSource === 'live-analysis' &&
          a.verdict === 'equivalent' &&
          a.verdictReason === 'within-tolerance' &&
          (!Number.isFinite(a.gapCp) ||
           a.gapCp > global.ChessyEquivalence.CRITERION.params.cpTolerance)) {
        return false;
      }
      if (a.evidenceSource === 'live-analysis' &&
          a.verdict === 'equivalent' &&
          a.verdictReason !== 'within-tolerance' && a.gapCp !== null) {
        return false;
      }
      if (a.evidenceSource === 'live-analysis' &&
          a.verdict === 'not-equivalent' &&
          a.verdictReason === 'cp-gap' &&
          (!Number.isFinite(a.gapCp) ||
           a.gapCp <= global.ChessyEquivalence.CRITERION.params.cpTolerance)) {
        return false;
      }
      if (a.evidenceSource === 'live-analysis' &&
          a.verdict === 'not-equivalent' &&
          a.verdictReason !== 'cp-gap' && a.gapCp !== null) {
        return false;
      }
      if (a.evidenceSource === 'live-analysis' &&
          a.verdict === 'unknown' &&
          a.verdictReason === 'not-covered' && a.gapCp !== null) {
        return false;
      }
      return true;
    })) {
      return prefix + ' has an invalid attempt';
    }
    // -1 is immediate learning; 0..5 are the fixed
    // 1/3/7/14/30/90-day ladder.
    if (!Number.isInteger(r.step) || r.step < -1 || r.step > 5) {
      return prefix + ' has an invalid step';
    }
    return null;
  }

  // Validate a parsed backup WITHOUT touching the database: format, a version
  // no NEWER than this build understands, and every durable record's key and
  // minimal schema. Returns an error string, or null when it is safe to
  // restore. Rejecting here keeps the restore atomic — a malformed backup never
  // gets a partial write.
  function validateBackup(data) {
    if (!data || typeof data !== 'object') return 'not a backup object';
    if (data.format !== BACKUP_FORMAT) return 'unrecognised backup format';
    // Every backup this app writes carries integer version fields. REQUIRE them
    // (not merely "reject if newer"): a truncated file retaining only the
    // format tag and empty stores must not be treated as a compatible v-nothing
    // backup and allowed to erase the archive.
    if (!Number.isInteger(data.version) || data.version < 1) {
      return 'backup has no valid version';
    }
    if (data.version > BACKUP_VERSION) return 'backup is from a newer app version';
    if (data.release !== undefined && data.release !== null &&
        !validRelease(data.release)) {
      return 'backup has an invalid release';
    }
    if (!Number.isInteger(data.dbVersion) || data.dbVersion < 1) {
      return 'backup has no valid database version';
    }
    if (data.dbVersion > DB_VERSION) return 'backup is from a newer database schema';
    // Must be a plain object: an ARRAY passes `typeof === 'object'` but then
    // every named store reads as absent, so a `stores: []` backup would clear
    // the archive while "restoring" zero records.
    if (!data.stores || typeof data.stores !== 'object' || Array.isArray(data.stores)) {
      return 'backup has no stores';
    }
    if (!Array.isArray(data.stores.games) || !Array.isArray(data.stores.cards)) {
      return 'backup is missing the games or cards array';
    }
    // Cross-store validation needs the complete restored game set. Use a
    // prototype-free lookup so a string id such as "__proto__" remains
    // ordinary data rather than mutating the lookup.
    var gamesById = Object.create(null);
    for (var i = 0; i < DURABLE_STORES.length; i++) {
      var name = DURABLE_STORES[i];
      var rows = data.stores[name];
      if (rows === undefined) continue; // a store may legitimately be absent/empty
      if (!Array.isArray(rows)) return 'store "' + name + '" is not an array';
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j];
        if (!r || typeof r !== 'object') return 'store "' + name + '" has a non-object record';
        if (!validIdbKey(r.id)) return 'store "' + name + '" record ' + j + ' has an invalid "id" key';
        // Required schema so a restored record is USABLE, not merely addable:
        // a game must replay AND render in Review; a card must attach to a game
        // AND be trainable. Otherwise the destructive restore swaps in records
        // that later blow up the view or the training load.
        if (name === 'games') {
          const gameError = validateGameRecord(r, 'store "games" record ' + j);
          if (gameError) return gameError;
          gamesById[r.id] = r;
        }
        if (name === 'cards') {
          var game = gamesById[r.gameId];
          if (!game) {
            return 'store "cards" record ' + j + ' references a missing game';
          }
          if (!Number.isInteger(r.ply) || r.ply < 0 || r.ply >= game.sans.length) {
            return 'store "cards" record ' + j + ' references a missing ply';
          }
          const cardError = validateCardRecord(
            r, 'store "cards" record ' + j, game);
          if (cardError) return cardError;
        }
      }
    }
    return null;
  }

  // Replace the DURABLE archive with a validated backup, ATOMICALLY: one
  // read-write transaction clears games+cards and re-adds the backup's rows.
  // Validated in memory first (invalid → rejected, zero writes). Crucially, a
  // SYNCHRONOUS enqueue failure (an invalid key that slipped validation) must
  // NOT let the preceding clear() auto-commit and destroy the archive: the loop
  // is wrapped so any throw explicitly aborts the whole transaction, rolling
  // the clear back. Any async request error aborts the transaction too (IDB
  // atomicity), so a restore either fully lands or leaves the archive exactly
  // as it was. Resolves with per-store counts.
  function restoreAll(data) {
    var err = validateBackup(data);
    if (err) return Promise.reject(new Error('invalid backup: ' + err));
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        // The backup deliberately omits the recomputable engine caches, but the
        // replacement must still CLEAR them in the SAME atomic transaction:
        // analyses and analysisJobs keyed to games the restore removes are no
        // longer reachable yet keep consuming quota, which can later fail game
        // or card writes. Clear all four, re-add only the durable backup rows.
        var t = db.transaction(RESTORE_STORES, 'readwrite');
        var counts = {};
        var failed = null;
        t.oncomplete = function () { resolve(counts); };
        t.onerror = function () { reject(failed || t.error || new Error('restore failed')); };
        t.onabort = function () { reject(failed || t.error || new Error('restore aborted')); };
        try {
          RESTORE_STORES.forEach(function (name) { t.objectStore(name).clear(); });
          DURABLE_STORES.forEach(function (name) {
            var store = t.objectStore(name);
            var rows = (data.stores[name] || []);
            counts[name] = rows.length;
            rows.forEach(function (r) { store.add(r); }); // may throw synchronously on a bad key
          });
        } catch (e) {
          // Explicit abort so the clear() cannot commit: without this the
          // transaction would still flush the queued clear and wipe the archive
          // even though the restore "failed".
          failed = e;
          try { t.abort(); } catch (e2) { /* already aborting */ }
        }
      });
    });
  }

  // ---- Delete all (Phase 4b4) ------------------------------------------
  // Clear EVERY store — durable and recomputable alike — in one transaction.
  // The fenced UI (dialog + explicit confirm) plus the recovery fence the
  // caller applies ONLY on success (cancel analysis, suspend live writes, fence
  // the cleared endings by signature, drop the durability queue) guarantee
  // cleared games do not reappear, including after a reload.
  function deleteAllData() {
    var all = RESTORE_STORES; // games, cards, analyses, analysisJobs
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(all, 'readwrite');
        all.forEach(function (name) { t.objectStore(name).clear(); });
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('delete aborted')); };
      });
    });
  }

  global.CoachStore = {
    putGame: putGame,
    archiveGame: archiveGame,
    importGame: importGame,
    getGame: getGame,
    listGames: listGames,
    addCard: addCard,
    updateCard: updateCard,
    upsertCardByMoment: upsertCardByMoment,
    listCards: listCards,
    dueCards: dueCards,
    gradeCard: gradeCard,
    analysisKey: analysisKey,
    putAnalysis: putAnalysis,
    getAnalysis: getAnalysis,
    deleteAnalysis: deleteAnalysis,
    listAnalysesForGame: listAnalysesForGame,
    touchAnalysis: touchAnalysis,
    maintainAnalysesCache: maintainAnalysesCache,
    analysesCachePolicy: analysesCachePolicy,
    putJob: putJob,
    putJobIfGame: putJobIfGame,
    getJob: getJob,
    deleteJob: deleteJob,
    exportAll: exportAll,
    validateGameReplayRecord: validateGameReplayRecord,
    validateGameRecord: validateGameRecord,
    validateCardRecord: validateCardRecord,
    validateBackup: validateBackup,
    restoreAll: restoreAll,
    deleteAllData: deleteAllData,
    setOpLock: setOpLock
  };
})(typeof window !== 'undefined' ? window : globalThis);
