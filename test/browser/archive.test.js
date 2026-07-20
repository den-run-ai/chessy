/* Game archive foundation: finished games persist to IndexedDB, keyed on
 * the game's UUID — idempotent re-archive keeping the earliest completion
 * time, revisions (undo → different finish) replacing the record in
 * place — with failures surfaced both in the game-over dialog and, for
 * boot-time work, on the page. SINGLE-TAB model by design (#44 tracks
 * cross-tab semantics). */
'use strict';
require('./helper').run('archive', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  async function games() {
    return page.evaluate(function () { return CoachStore.listGames(); });
  }
  async function waitGameCount(n) {
    for (let i = 0; i < 50; i++) {
      if ((await games()).length === n) return;
      await page.waitForTimeout(100);
    }
    throw new Error('expected ' + n + ' archived games, got ' + (await games()).length);
  }

  // The archive modules load BEFORE the app: a restored game's clock or
  // AI can finish as soon as app.js boots, and by then archive support
  // must have definitively loaded or definitively failed — never be
  // still-fetching behind the app (a false "storage unavailable").
  check(await page.evaluate(function () {
    const srcs = Array.prototype.map.call(
      document.querySelectorAll('script[src]'),
      function (s) { return s.getAttribute('src'); });
    const at = function (name) {
      return srcs.findIndex(function (s) { return s.indexOf(name) !== -1; });
    };
    return at('store.js') !== -1 && at('archive.js') !== -1 &&
           at('store.js') < at('archive.js') && at('archive.js') < at('app.js');
  }), 'store.js and archive.js load before app.js');

  // A finished game is archived automatically.
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  check(await page.locator('#archiveNote').isHidden(), 'no archive-failure note on success');
  await waitGameCount(1);
  const first = (await games())[0];
  check(typeof first.id === 'string' && first.id.length > 0, 'record keyed on the game UUID');
  check(first.source === 'play' && first.plies === 4 && first.playerColor === 'both' &&
        first.result === '0-1' && first.reason === 'checkmate' &&
        Array.isArray(first.clocks) && first.clocks.length === 4 &&
        first.sans.join(' ') === 'f3 e5 g4 Qh4#',
    'record carries moves, result, player color and per-move clock evidence');

  // Rematch with the IDENTICAL moves is a new game instance → new record.
  await page.click('#gameOverRematch');
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await waitGameCount(2);
  const pair = await games();
  check(pair[0].id !== pair[1].id, 'identical rematch archives under a fresh UUID');

  // Reload → undo → reproduce the SAME ending: the UUID is persisted with
  // the saved game, so the re-archive is an idempotent overwrite — and it
  // keeps the EARLIEST completion time (listGames sorts by createdAt; a
  // re-shown game must not jump to the top of the chronology).
  const overwriteId = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
  });
  const createdAtBefore = (await games()).filter(function (g) {
    return g.id === overwriteId;
  })[0].createdAt;
  await page.waitForTimeout(50); // ensure a rewritten createdAt would differ
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#undo');
  await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await page.waitForTimeout(300); // let any (wrong) duplicate write land
  await waitGameCount(2);
  const overwritten = (await games()).filter(function (g) { return g.id === overwriteId; })[0];
  check(!!overwritten, 'a replayed ending after reload overwrites its record (still 2 games)');
  check(overwritten.createdAt === createdAtBefore,
    'the overwrite keeps the original createdAt');

  // Boot reconcile: if the archive write was lost (tab died before the
  // IndexedDB commit), the next boot re-offers the restored finished game.
  // deleteDatabase also exercises the store's onversionchange handler —
  // the open connection must yield, not block.
  await page.evaluate(function () {
    return new Promise(function (resolve) {
      const req = indexedDB.deleteDatabase('chessy-coach');
      req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
    });
  });
  const savedGame = await page.evaluate(function () {
    const s = JSON.parse(localStorage.getItem('chessy-game-v1'));
    return { gameId: s.gameId, endedAt: s.endedAt };
  });
  const savedId = savedGame.gameId;
  await page.reload();
  await page.waitForSelector('#board .square');
  await waitGameCount(1);
  check((await games())[0].id === savedId,
    'boot re-archives a finished game whose write was lost (same UUID)');
  check(Number.isFinite(savedGame.endedAt) && (await games())[0].createdAt === savedGame.endedAt,
    'the reconciled record keeps the persisted completion time, not the boot time');

  // Undoing a finished game voids its completion time: a DIFFERENT finish
  // reached after the undo must archive under its own time.
  await page.click('#undo');
  check((await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).endedAt;
  })) === null, 'undo clears the persisted completion time');

  // A game can be over before the first move (time forfeit on the initial
  // position) — it is archived, not skipped.
  const zeroPlyId = await page.evaluate(function () {
    return ChessyArchive.record(
      { history: [] },
      { mode: 'pvp', difficulty: '3', timeControl: '5+0' },
      { over: true, result: '0-1', reason: 'time forfeit' },
      'zero-ply-forfeit');
  });
  await waitGameCount(2);
  check(zeroPlyId === 'zero-ply-forfeit' && (await games()).some(function (g) {
    return g.id === 'zero-ply-forfeit' && g.plies === 0 && g.reason === 'time forfeit';
  }), 'a zero-ply time forfeit is archived');

  // A REVISED ending (undo → different finish) replaces the instance's
  // one record — one game instance, one record. And a same-ending
  // re-offer keeps the EARLIEST known completion time even when the
  // earlier evidence arrives later (a delayed slot drain).
  const revised = await page.evaluate(function () {
    const mk = function (sans) {
      return { history: sans.map(function (s) { return { san: s }; }) };
    };
    const cfg = { mode: 'pvp', difficulty: '3', timeControl: 'none' };
    const over = { over: true, result: '1-0', reason: 'checkmate' };
    return ChessyArchive.record(mk(['e4', 'e5']), cfg, over, 'rev-game', { endedAt: 1000 })
      .then(function () {
        return ChessyArchive.record(mk(['e4', 'c5']), cfg, over, 'rev-game', { endedAt: 2000 });
      })
      .then(function () { // earlier evidence of the SAME ending arrives late
        return ChessyArchive.record(mk(['e4', 'c5']), cfg, over, 'rev-game', { endedAt: 1500 });
      })
      .then(function () { return CoachStore.getGame('rev-game'); });
  });
  await waitGameCount(3);
  check(revised.sans.join(' ') === 'e4 c5' && revised.createdAt === 1500,
    'a revised ending replaces the record; same-ending re-offers keep the earliest time');

  // Durability queue: a record parked by a tab that died before its
  // IndexedDB commit is recovered on the next boot, then cleared.
  await page.evaluate(function () {
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify({
      'parked-game': {
        w: 'w-dead-1',
        rec: {
          id: 'parked-game', source: 'play', tags: {},
          sans: ['e4', 'e5'], playerColor: 'both', clocks: [null, null],
          result: '1-0', reason: 'resignation', mode: 'pvp', difficulty: '2',
          timeControl: 'none', plies: 2, createdAt: 7777
        }
      }
    }));
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await waitGameCount(4);
  check((await games()).some(function (g) { return g.id === 'parked-game' && g.createdAt === 7777; }),
    'a parked record from a dead tab is recovered on boot');
  check(await page.evaluate(function () {
    return localStorage.getItem('chessy-pending-archive-v1') === null;
  }), 'the recovered durability queue is cleared');

  // OVERLAPPING writes (undo → revised ending while the first write is
  // still in flight): the game's queue entry holds the LATEST unarchived
  // ending, and an earlier commit settling must not clear it — entries
  // clear by per-write token.
  const slotRace = await page.evaluate(function () {
    const real = CoachStore.archiveGame;
    let release;
    const gate = new Promise(function (r) { release = r; });
    let calls = 0;
    CoachStore.archiveGame = function (rec) {
      calls++;
      if (calls === 2) return gate.then(function () { return real(rec); });
      return real(rec);
    };
    const mk = function (sans) {
      return { history: sans.map(function (s) { return { san: s }; }) };
    };
    const cfg = { mode: 'pvp', difficulty: '3', timeControl: 'none' };
    const over = { over: true, result: '1-0', reason: 'checkmate' };
    const held = function () {
      const cur = JSON.parse(localStorage.getItem('chessy-pending-archive-v1') || 'null');
      const entry = cur && cur['slot-race'];
      return entry && entry.rec ? entry.rec.sans[0] : null;
    };
    const p1 = ChessyArchive.record(mk(['a3']), cfg, over, 'slot-race', { endedAt: 1 });
    const p2 = ChessyArchive.record(mk(['a4']), cfg, over, 'slot-race', { endedAt: 2 });
    return p1.then(function () {
      const afterFirst = held();
      release();
      return p2.then(function () {
        CoachStore.archiveGame = real;
        return { afterFirst: afterFirst, afterBoth: held() };
      });
    });
  });
  await waitGameCount(5);
  check(slotRace.afterFirst === 'a4' && slotRace.afterBoth === null,
    "an earlier commit does not clear a later revision's parked copy (token-matched entry)");

  // INDEPENDENT games queue independently: game A's FAILED write must stay
  // parked while a later game B parks and commits — a single shared slot
  // would let B overwrite A's only recoverable copy, then B's success
  // would clear the slot and no boot could ever retry A.
  const queued = await page.evaluate(function () {
    const real = CoachStore.archiveGame;
    CoachStore.archiveGame = function (rec) {
      if (rec.id === 'queue-lost') return Promise.reject(new Error('quota'));
      return real(rec);
    };
    const mk = function (sans) {
      return { history: sans.map(function (s) { return { san: s }; }) };
    };
    const cfg = { mode: 'pvp', difficulty: '3', timeControl: 'none' };
    const over = { over: true, result: '1-0', reason: 'checkmate' };
    return ChessyArchive.record(mk(['h3']), cfg, over, 'queue-lost', { endedAt: 1 })
      .catch(function () { /* the injected failure */ })
      .then(function () {
        return ChessyArchive.record(mk(['h4']), cfg, over, 'queue-kept', { endedAt: 2 });
      })
      .then(function () {
        CoachStore.archiveGame = real;
        const map = JSON.parse(localStorage.getItem('chessy-pending-archive-v1') || 'null');
        return {
          lostParked: !!(map && map['queue-lost'] && map['queue-lost'].rec.sans[0] === 'h3'),
          keptCleared: !(map && map['queue-kept'])
        };
      });
  });
  await waitGameCount(6);
  check(queued.lostParked && queued.keptCleared,
    "a later game's successful commit clears only its own entry — a failed game stays parked");
  // Drop the failed entry so it does not skew the later drain sections.
  await page.evaluate(function () {
    const map = JSON.parse(localStorage.getItem('chessy-pending-archive-v1'));
    delete map['queue-lost'];
    if (Object.keys(map).length === 0) localStorage.removeItem('chessy-pending-archive-v1');
    else localStorage.setItem('chessy-pending-archive-v1', JSON.stringify(map));
  });

  // A write that fails AFTER the dialog was closed reports to the
  // always-visible page note — a note inside a closed dialog is invisible.
  await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    CoachStore.archiveGame = function () {
      return new Promise(function (resolve, reject) {
        setTimeout(function () { reject(new Error('quota')); }, 400);
      });
    };
  });
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose'); // closed before the write settles
  await page.waitForSelector('#archiveBootNote:not([hidden])', { timeout: 5000 });
  check((await page.textContent('#archiveBootNote')).includes('could not be archived'),
    'a failure landing after the dialog closed surfaces on the page');
  await page.evaluate(function () {
    CoachStore.archiveGame = CoachStore.__realArchiveGame;
    document.getElementById('archiveBootNote').hidden = true;
  });

  // A FAILED archive write is surfaced in the game-over dialog.
  await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    CoachStore.archiveGame = function () { return Promise.reject(new Error('quota')); };
  });
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.waitForSelector('#archiveNote:not([hidden])');
  check((await page.textContent('#archiveNote')).includes('could not be archived'),
    'a failed archive write is reported in the game-over dialog');
  await page.evaluate(function () { CoachStore.archiveGame = CoachStore.__realArchiveGame; });
  await page.click('#gameOverClose');

  // A late failure from a SUPERSEDED attempt (undo → the ending replayed
  // and re-archived under the SAME game UUID) must not surface anywhere:
  // the newer attempt owns the outcome, and here it committed fine.
  await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    let first = true;
    CoachStore.archiveGame = function (rec) {
      if (first) {
        first = false;
        return new Promise(function (resolve, reject) {
          window.__failFirstArchive = function () { reject(new Error('quota')); };
        });
      }
      return CoachStore.__realArchiveGame(rec);
    };
  });
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4'); // attempt 1: write held open
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await page.click('#undo');
  await mv('d8', 'h4');                       // attempt 2: same game id, commits
  await page.waitForSelector('#gameOverDialog[open]');
  await waitGameCount(7);
  await page.evaluate(function () { window.__failFirstArchive(); });
  await page.waitForTimeout(300);             // let the stale rejection land
  check(await page.locator('#archiveNote').isHidden(),
    "a superseded attempt's late failure does not blame the current dialog");
  check(await page.locator('#archiveBootNote').isHidden(),
    "a superseded attempt's late failure is not reported as pending recovery");
  await page.evaluate(function () { CoachStore.archiveGame = CoachStore.__realArchiveGame; });
  await page.click('#gameOverClose');

  // A failure routed to the PAGE note (the dialog had closed) is OWNED by
  // its game: when a replacement attempt for the SAME game later
  // succeeds, the note clears — the page must not keep claiming a game
  // could not be archived when its record in fact exists.
  await page.evaluate(function () {
    CoachStore.__realArchiveGame = CoachStore.archiveGame;
    let first = true;
    CoachStore.archiveGame = function (rec) {
      if (first) {
        first = false;
        return new Promise(function (resolve, reject) {
          window.__failHeldArchive = function () { reject(new Error('quota')); };
        });
      }
      return CoachStore.__realArchiveGame(rec);
    };
  });
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4'); // attempt 1: write held open
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await page.evaluate(function () { window.__failHeldArchive(); });
  await page.waitForSelector('#archiveBootNote:not([hidden])');
  await page.click('#undo');                  // void the failed ending…
  await mv('d7', 'd6'); await mv('h2', 'h3');
  await mv('d8', 'h4');                       // …and complete a REVISED one
  await page.waitForSelector('#gameOverDialog[open]');
  await page.waitForSelector('#archiveBootNote[hidden]', { state: 'attached', timeout: 5000 });
  check(await page.locator('#archiveBootNote').isHidden(),
    "a successful replacement archive clears the same game's page failure note");
  await page.evaluate(function () { CoachStore.archiveGame = CoachStore.__realArchiveGame; });
  await page.click('#gameOverClose');

  // One failed queue entry must not cost ANOTHER game its reconcile: a
  // poisoned entry stays parked and is surfaced, while the restored
  // finished game — wiped from the store, no queue entry of its own — is
  // still archived by the same boot chain.
  const restoredId = await page.evaluate(function () {
    return JSON.parse(localStorage.getItem('chessy-game-v1')).gameId;
  });
  await page.evaluate(function () {
    return new Promise(function (resolve) {
      const req = indexedDB.deleteDatabase('chessy-coach');
      req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
    });
  });
  await page.addInitScript(function () {
    // Wrap CoachStore.archiveGame the moment store.js assigns it: the
    // poisoned entry must already be failing during BOOT (a post-load
    // patch would miss the drain).
    let store;
    Object.defineProperty(window, 'CoachStore', {
      configurable: true,
      get: function () { return store; },
      set: function (v) {
        const real = v.archiveGame;
        v.archiveGame = function (rec) {
          if (rec.id === 'poison-entry') return Promise.reject(new Error('quota'));
          return real.apply(this, arguments);
        };
        store = v;
      }
    });
  });
  await page.evaluate(function () {
    const map = JSON.parse(localStorage.getItem('chessy-pending-archive-v1') || '{}');
    map['poison-entry'] = {
      w: 'w-dead-2',
      rec: { id: 'poison-entry', source: 'play', tags: {}, sans: ['d4'],
             playerColor: 'both', clocks: [null], result: '1-0',
             reason: 'resignation', mode: 'pvp', difficulty: '2',
             timeControl: 'none', plies: 1, createdAt: 8888 }
    };
    localStorage.setItem('chessy-pending-archive-v1', JSON.stringify(map));
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForSelector('#archiveBootNote:not([hidden])', { timeout: 5000 });
  let restoredRec = null;
  for (let i = 0; i < 50 && !restoredRec; i++) {
    restoredRec = await page.evaluate(function (id) {
      return CoachStore.getGame(id);
    }, restoredId);
    if (!restoredRec) await page.waitForTimeout(100);
  }
  check(!!restoredRec && restoredRec.sans.length === 6,
    'a failed queue entry does not block the restored game\'s boot reconcile');
  check(await page.evaluate(function () {
    const map = JSON.parse(localStorage.getItem('chessy-pending-archive-v1') || 'null');
    return !!(map && map['poison-entry']);
  }), 'the poisoned entry stays parked for the next boot, and its failure is surfaced');

  // While a SLOW drain holds the boot chain, the user can undo the
  // restored finish and complete a REVISED ending. The live attempt owns
  // the record: the stale boot snapshot must not overwrite the newer
  // result when the drain finally settles.
  await page.addInitScript(function () {
    // Gate reconcilePending (only while the marker is set) the moment
    // archive.js assigns the module, exposing the release to the test.
    let mod;
    Object.defineProperty(window, 'ChessyArchive', {
      configurable: true,
      get: function () { return mod; },
      set: function (v) {
        const real = v.reconcilePending;
        v.reconcilePending = function () {
          if (localStorage.getItem('test-hold-drain') === null) {
            return real.apply(v, arguments);
          }
          return new Promise(function (resolve, reject) {
            window.__releaseDrain = function () {
              real.call(v).then(resolve, reject);
            };
          });
        };
        mod = v;
      }
    });
  });
  await page.evaluate(function () { localStorage.setItem('test-hold-drain', '1'); });
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.click('#undo');                  // boot chain is still gated…
  await mv('h7', 'h5'); await mv('g4', 'h5');
  await mv('d8', 'h4');                       // …revised ending completes live
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverClose');
  await page.evaluate(function () { window.__releaseDrain(); });
  await page.waitForTimeout(500);             // drain settles; snapshot window passes
  const afterDrain = await page.evaluate(function (id) {
    return CoachStore.getGame(id);
  }, restoredId);
  check(!!afterDrain && afterDrain.sans.join(' ') === 'f3 e5 g4 d6 h3 h5 gxh5 Qh4#',
    'a stale boot snapshot does not overwrite a newer revised ending');
  await page.evaluate(function () { localStorage.removeItem('test-hold-drain'); });

  // A MISSING archive module (partial cache eviction) is a failure to
  // surface, not silence — and it must show in the OPEN dialog (the
  // failure is synchronous, so the dialog opens first). Reset the note
  // left visible by the previous section so this assertion is genuine.
  await page.evaluate(function () {
    document.getElementById('archiveNote').hidden = true;
    window.__realChessyArchive = window.ChessyArchive;
    delete window.ChessyArchive;
  });
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.waitForSelector('#archiveNote:not([hidden])');
  check((await page.textContent('#archiveNote')).includes('could not be archived'),
    'a missing archive module is reported, not silently dropped');
  await page.evaluate(function () { window.ChessyArchive = window.__realChessyArchive; });
  await page.click('#gameOverClose');

  // A BOOT-TIME reconcile failure has no open dialog to report into: it
  // must surface in the always-visible page note. Break IndexedDB before
  // the scripts run, then boot the finished saved game (whose archive
  // write above was rejected, so the reconcile really does try to write).
  await page.addInitScript(function () {
    Object.defineProperty(window, 'indexedDB',
      { get: function () { return undefined; }, configurable: true });
  });
  await page.reload();
  await page.waitForSelector('#board .square');
  await page.waitForSelector('#archiveBootNote:not([hidden])', { timeout: 5000 });
  check((await page.textContent('#archiveBootNote')).includes('could not be archived'),
    'a boot-time reconcile failure is reported outside the closed dialog');
  // Failed work stays PARKED: the failed drain's entries keep their queue
  // slots and the failed boot re-offer parks its own — every recoverable
  // copy survives for the next boot. (The chain itself continues past the
  // drain failure — the poisoned-entry section above covers that.)
  check(await page.evaluate(function () {
    return localStorage.getItem('chessy-pending-archive-v1') !== null;
  }), 'a failed boot chain leaves the durability queue parked for the next boot');
});
