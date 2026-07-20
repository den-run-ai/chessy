/*
 * Chessy coaching store — the versioned IndexedDB archive behind the
 * Review/Train/Progress views. Three object stores (schema v3 — v2 added
 * the unique games.sig index; v3 added an atomic delete commit marker):
 *
 *   games: { id (auto), source ('play'|'import'), tags, sans, result,
 *            reason, mode, difficulty, timeControl, plies, createdAt }
 *   cards: { id (auto), gameId, ply, fenBefore, playedSan, bestSan,
 *            bestMove {from,to,promotion}, bestScore, playedScore, lossCp,
 *            cause, lesson, reflection, createdAt, due, step,
 *            attempts: [{ at, grade, correct }] }
 *   meta:  { key, ... } (internal coordination state, not user content)
 *
 * `due` is a timestamp (ms); `step` indexes the fixed spaced-review ladder
 * (see Coach). Everything is promise-based; the DB opens lazily on first
 * use so browsers without IndexedDB (or private modes that block it) fail
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
  // v2 adds a UNIQUE index on games.sig: each tab's in-memory dedupe is
  // only a snapshot, so two tabs reconciling the same finished game could
  // both pass their local check — the database itself must refuse the
  // second insert. Records without a sig (imports, pre-v2 rows) are not
  // indexed and carry no constraint.
  const DB_VERSION = 3;
  // Cards start at -1 (the immediate learning step), then advance through
  // the six fixed 1/3/7/14/30/90-day rungs owned by Coach.
  const MIN_CARD_STEP = -1;
  const MAX_CARD_STEP = 5;

  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          const db = req.result;
          const games = db.objectStoreNames.contains('games')
            ? req.transaction.objectStore('games')
            : db.createObjectStore('games', { keyPath: 'id', autoIncrement: true });
          if (!games.indexNames.contains('sig')) {
            games.createIndex('sig', 'sig', { unique: true });
          }
          if (!db.objectStoreNames.contains('cards')) {
            const cards = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
            cards.createIndex('due', 'due');
            cards.createIndex('gameId', 'gameId');
          }
          if (!db.objectStoreNames.contains('meta')) {
            db.createObjectStore('meta', { keyPath: 'key' });
          }
        };
        req.onsuccess = function () {
          const db = req.result;
          // Yield to FUTURE schema upgrades: without this handler an open
          // connection blocks another context's upgrade indefinitely.
          // Closing drops this connection; the next call reopens lazily at
          // the new version. (v1 itself never shipped outside this PR, so
          // no handler-less v1 clients exist in the wild.)
          db.onversionchange = function () {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
        req.onerror = function () { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }

  // Run `fn(objectStore)` in a transaction; resolves with the result of the
  // request `fn` returns (or undefined) once the transaction commits.
  function staleWriteError() {
    const e = new Error('training data changed while this write was pending');
    e.name = 'StaleCoachWriteError';
    return e;
  }

  function deleteToken(value) {
    return value && typeof value.token === 'string' ? value.token : '';
  }

  // A fenced write includes `meta` in the SAME transaction and checks the
  // delete epoch before touching content. Transaction serialization gives
  // two safe orders: the write commits first and a later clear removes it,
  // or the clear commits first and the mismatched writer becomes a no-op.
  function tx(storeName, mode, fn, fence) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const guarded = mode === 'readwrite' && typeof fence === 'string';
        const t = db.transaction(guarded ? [storeName, 'meta'] : storeName, mode);
        let req = null;
        let stale = false;
        if (guarded) {
          const gate = t.objectStore('meta').get('lastDelete');
          gate.onsuccess = function () {
            if (deleteToken(gate.result) !== fence) {
              stale = true;
              return;
            }
            req = fn(t.objectStore(storeName));
          };
        } else {
          req = fn(t.objectStore(storeName));
        }
        t.oncomplete = function () {
          if (stale) reject(staleWriteError());
          else resolve(req ? req.result : undefined);
        };
        // Prefer the REQUEST's error: when a request fails (e.g. a
        // ConstraintError from the unique sig index) transaction.error
        // can still be null in the bubbled error/abort events, and
        // callers need the real name to react to it.
        t.onerror = function () { reject((req && req.error) || t.error); };
        t.onabort = function () {
          reject((req && req.error) || t.error || new Error('transaction aborted'));
        };
      });
    });
  }

  function addGame(game, fence) {
    return tx('games', 'readwrite', function (s) { return s.add(game); }, fence);
  }
  function updateGame(game, fence) {
    return tx('games', 'readwrite', function (s) { return s.put(game); }, fence);
  }
  function getGame(id) { return tx('games', 'readonly', function (s) { return s.get(id); }); }

  function listGames() {
    return tx('games', 'readonly', function (s) { return s.getAll(); })
      .then(function (games) { return games.sort(function (a, b) { return b.createdAt - a.createdAt; }); });
  }

  function deleteGame(id) {
    // Cards belong to their game — remove them with it.
    return tx('cards', 'readwrite', function (s) {
      const idx = s.index('gameId').openCursor(IDBKeyRange.only(id));
      idx.onsuccess = function () {
        const c = idx.result;
        if (c) { c.delete(); c.continue(); }
      };
      return null;
    }).then(function () {
      return tx('games', 'readwrite', function (s) { return s.delete(id); });
    });
  }

  function addCard(card, fence) {
    return tx('cards', 'readwrite', function (s) { return s.add(card); }, fence);
  }
  function updateCard(card, fence) {
    return tx('cards', 'readwrite', function (s) { return s.put(card); }, fence);
  }

  // Atomic read-modify-write for grading: two tabs grading the same card
  // would otherwise each put() a copy built from the same original
  // attempts array, and the later write would erase the earlier attempt.
  // `mutate` runs on the FRESH stored record inside the transaction.
  // Resolves with the updated record, or null when the card is gone.
  function gradeCard(id, mutate, fence) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const guarded = typeof fence === 'string';
        const t = db.transaction(guarded ? ['cards', 'meta'] : 'cards', 'readwrite');
        const s = t.objectStore('cards');
        let updated = null;
        let stale = false;
        function readCard() {
          const getReq = s.get(id);
          getReq.onsuccess = function () {
            const card = getReq.result;
            if (!card) return; // deleted meanwhile — nothing to grade
            updated = mutate(card) || card;
            s.put(updated);
          };
        }
        if (guarded) {
          const gate = t.objectStore('meta').get('lastDelete');
          gate.onsuccess = function () {
            if (deleteToken(gate.result) !== fence) stale = true;
            else readCard();
          };
        } else {
          readCard();
        }
        t.oncomplete = function () {
          if (stale) reject(staleWriteError());
          else resolve(updated);
        };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }
  function deleteCard(id) { return tx('cards', 'readwrite', function (s) { return s.delete(id); }); }
  function listCards() { return tx('cards', 'readonly', function (s) { return s.getAll(); }); }

  function dueCards(now) {
    return tx('cards', 'readonly', function (s) {
      return s.index('due').getAll(IDBKeyRange.upperBound(now));
    }).then(function (cards) { return cards.sort(function (a, b) { return a.due - b.due; }); });
  }

  // Whole-archive JSON snapshot for backup. BOTH stores are read in ONE
  // readonly transaction: two independent reads could observe different
  // database moments when the export overlaps a delete or import, and a
  // backup with orphaned cards cannot remap its gameIds on restore.
  function exportAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(['games', 'cards'], 'readonly');
        const gReq = t.objectStore('games').getAll();
        const cReq = t.objectStore('cards').getAll();
        t.oncomplete = function () {
          resolve({
            format: 'chessy-coach', version: DB_VERSION, exportedAt: Date.now(),
            games: gReq.result.sort(function (a, b) { return b.createdAt - a.createdAt; }),
            cards: cReq.result
          });
        };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  // Restore a snapshot by APPENDING: records get fresh ids and card→game
  // links are remapped, so importing into a non-empty archive never
  // collides with (or overwrites) existing records. `isCancelled` (optional)
  // is consulted between records — a restore raced by "Delete all training
  // data" stops instead of writing deleted data back. The per-record
  // transactions cannot be atomic across the whole restore, so on ANY
  // failure (quota, bad record, cancellation) the committed prefix is
  // rolled back — a retry after fixing the cause must not duplicate it.
  function importAll(data, isCancelled, fence) {
    if (!data || data.format !== 'chessy-coach' ||
        !Array.isArray(data.games) || !Array.isArray(data.cards)) {
      return Promise.reject(new Error('not a chessy-coach backup'));
    }
    // Validate every record BEFORE the first write: a structurally broken
    // backup (a card without a position, a non-numeric due time) would
    // otherwise commit, report success, and then break Train/Review when
    // the record is used. Rejecting up front leaves the archive unchanged.
    // Games must REPLAY, not merely be arrays of strings: a record with
    // garbage SANs would restore "successfully" and then always fail in
    // openReview. (Engine checks are skipped only where the engine script
    // isn't loaded, e.g. unit shims.)
    function badScan(scan, plies) {
      if (!scan || typeof scan !== 'object' ||
          typeof scan.at !== 'number' || !isFinite(scan.at) ||
          !scan.settings || typeof scan.settings !== 'object' ||
          typeof scan.settings.maxDepth !== 'number' || !isFinite(scan.settings.maxDepth) ||
          typeof scan.settings.timeMs !== 'number' || !isFinite(scan.settings.timeMs) ||
          ['w', 'b', 'both'].indexOf(scan.playerColor) < 0 ||
          !Array.isArray(scan.evals) || scan.evals.length !== plies + 1 ||
          !scan.evals.every(function (v) { return typeof v === 'number' && isFinite(v); }) ||
          !Array.isArray(scan.bestSans) || scan.bestSans.length !== plies + 1 ||
          !scan.bestSans.every(function (v) { return v === null || typeof v === 'string'; }) ||
          !Array.isArray(scan.moments) || scan.moments.length > 2) {
        return true;
      }
      return !scan.moments.every(function (m) {
        return m && typeof m === 'object' && Number.isInteger(m.ply) &&
          m.ply >= 0 && m.ply < plies &&
          typeof m.loss === 'number' && isFinite(m.loss) && m.loss >= 0;
      });
    }
    function badGame(g) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.sans) ||
          !g.sans.every(function (s) { return typeof s === 'string'; }) ||
          typeof g.result !== 'string') return true;
      if (g.scan !== undefined && g.scan !== null && badScan(g.scan, g.sans.length)) return true;
      if (typeof Chess !== 'undefined') {
        try { Chess.replaySans(g.sans); } catch (e) { return true; }
      }
      return false;
    }
    // A card must be ANSWERABLE: the position parses, both kings exist,
    // and the saved best move is LEGAL there — otherwise Train renders a
    // card no answer can ever match.
    function badCard(c) {
      if (!c || typeof c !== 'object' ||
          typeof c.fenBefore !== 'string' || c.fenBefore === '' ||
          typeof c.due !== 'number' || !isFinite(c.due) ||
          !Number.isInteger(c.step) ||
          c.step < MIN_CARD_STEP || c.step > MAX_CARD_STEP ||
          !Array.isArray(c.attempts) ||
          !c.attempts.every(function (a) {
            return a && typeof a === 'object' &&
              typeof a.at === 'number' && isFinite(a.at) &&
              ['again', 'hard', 'good'].indexOf(a.grade) >= 0 &&
              typeof a.correct === 'boolean';
          }) ||
          !(typeof c.bestMove === 'object' && c.bestMove !== null &&
            typeof c.bestMove.from === 'number' && typeof c.bestMove.to === 'number')) {
        return true;
      }
      if (typeof Chess !== 'undefined') {
        try {
          const s = Chess.parseFen(c.fenBefore);
          if (s.board.indexOf('wK') < 0 || s.board.indexOf('bK') < 0) return true;
          const legal = Chess.legalMoves(s).some(function (m) {
            return m.from === c.bestMove.from && m.to === c.bestMove.to &&
              (m.promotion || null) === (c.bestMove.promotion || null);
          });
          if (!legal) return true;
        } catch (e) { return true; }
      }
      return false;
    }
    if (data.games.some(badGame) || data.cards.some(badCard)) {
      return Promise.reject(new Error('backup contains invalid records'));
    }
    function guard() {
      if (isCancelled && isCancelled()) throw new Error('restore cancelled');
    }
    const idMap = new Map();
    const addedGames = [], addedCards = [];
    let chain = Promise.resolve();
    data.games.forEach(function (g) {
      chain = chain.then(function () {
        guard();
        const copy = Object.assign({}, g);
        const oldId = copy.id;
        delete copy.id;
        // A restored copy is a NEW record, not the original play-game
        // instance: keeping the sig would trip the unique index (and
        // wrongly claim the dedupe identity).
        delete copy.sig;
        return addGame(copy, fence).then(function (newId) {
          idMap.set(oldId, newId);
          addedGames.push(newId);
        });
      });
    });
    data.cards.forEach(function (c) {
      chain = chain.then(function () {
        guard();
        const copy = Object.assign({}, c);
        delete copy.id;
        copy.gameId = idMap.get(copy.gameId) || null;
        return addCard(copy, fence).then(function (id) { addedCards.push(id); });
      });
    });
    // Cancellation can land during the FINAL record's transaction. Put the
    // last guard into the chain so its rejection enters the common rollback
    // handler below (throwing inside that handler's success arm would not).
    chain = chain.then(function () { guard(); });
    return chain.then(function () {
      return { games: data.games.length, cards: data.cards.length };
    }, function (e) {
      let undo = Promise.resolve();
      addedCards.forEach(function (id) {
        undo = undo.then(function () { return deleteCard(id); })
          .catch(function () { /* keep rolling back the rest */ });
      });
      addedGames.forEach(function (id) {
        undo = undo.then(function () {
          return tx('games', 'readwrite', function (s) { return s.delete(id); });
        }).catch(function () { /* keep rolling back the rest */ });
      });
      return undo.then(function () { throw e; });
    });
  }

  // BOTH content stores clear in ONE readwrite transaction: split clears
  // exposed an intermediate no-games-but-old-cards state to a concurrent
  // export. The commit id is written to `meta` in that SAME transaction,
  // so peers can distinguish a committed clear from a failed/abandoned one
  // even if the initiating window closes before broadcasting its result.
  function deleteAll(deleteId, tombstones) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(['games', 'cards', 'meta'], 'readwrite');
        let committed = null;
        t.objectStore('games').clear();
        t.objectStore('cards').clear();
        if (typeof deleteId === 'string' && deleteId) {
          const meta = t.objectStore('meta');
          const getReq = meta.get('lastDelete');
          getReq.onsuccess = function () {
            const previous = getReq.result || {};
            const ids = Array.isArray(previous.ids)
              ? previous.ids.filter(function (id) { return typeof id === 'string'; })
              : [];
            if (ids.indexOf(deleteId) < 0) ids.push(deleteId);
            const epoch = (Number(previous.epoch) || 0) + 1;
            committed = {
              key: 'lastDelete',
              attemptId: deleteId,
              epoch: epoch,
              token: String(epoch).padStart(16, '0') + '|' + deleteId,
              at: Math.max(Number(previous.at) || 0, Number(deleteId.slice(0, 13)) || 0),
              ids: ids.slice(-32),
              tombstones: Array.isArray(tombstones)
                ? tombstones.filter(function (s) { return typeof s === 'string'; }).slice(-100)
                : []
            };
            meta.put(committed);
          };
        }
        t.oncomplete = function () { resolve(committed); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  function getLastDelete() {
    return tx('meta', 'readonly', function (s) { return s.get('lastDelete'); })
      .then(function (value) { return value || null; });
  }

  global.CoachStore = {
    addGame: addGame,
    updateGame: updateGame,
    getGame: getGame,
    listGames: listGames,
    deleteGame: deleteGame,
    addCard: addCard,
    updateCard: updateCard,
    gradeCard: gradeCard,
    deleteCard: deleteCard,
    listCards: listCards,
    dueCards: dueCards,
    exportAll: exportAll,
    importAll: importAll,
    deleteAll: deleteAll,
    getLastDelete: getLastDelete
  };
})(typeof window !== 'undefined' ? window : globalThis);
