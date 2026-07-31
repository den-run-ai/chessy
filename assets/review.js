/*
 * Chessy Review — READ-ONLY browsing of the game archive (roadmap #23):
 * Play/Review tabs, the archived-game list, and a position-by-position
 * browser on the accessible mini board. Reflection, verification and
 * lesson cards build on this in the next slice.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof Chess === 'undefined' ||
      typeof ChessyMiniBoard === 'undefined') return;

  const $ = function (id) { return document.getElementById(id); };

  // ---- Views ----
  // Later slices register their own view (tab + section markup) via
  // CoachReview.registerView, so this file never grows with them.
  const VIEWS = [
    { name: 'play', onShow: null },
    { name: 'review', onShow: function () { renderGameList(); } }
  ];

  function showView(name) {
    document.body.dataset.view = name;
    for (const v of VIEWS) {
      $('view' + v.name[0].toUpperCase() + v.name.slice(1)).hidden = name !== v.name;
      const tab = $('tab' + v.name[0].toUpperCase() + v.name.slice(1));
      if (name === v.name) {
        tab.setAttribute('aria-current', 'page');
        if (v.onShow) v.onShow();
      } else {
        tab.removeAttribute('aria-current');
      }
    }
    // Play owns the live-game banner: leaving Play during a running timed
    // game must surface the still-ticking clocks (see app.js).
    document.dispatchEvent(new CustomEvent('chessy:viewchange'));
  }

  function bindTab(v) {
    $('tab' + v.name[0].toUpperCase() + v.name.slice(1))
      .addEventListener('click', function () { showView(v.name); });
  }
  VIEWS.forEach(bindTab);

  function registerView(name, onShow) {
    const v = { name: name, onShow: onShow || null };
    VIEWS.push(v);
    bindTab(v);
  }

  // ---- Game list ----
  function gameLabel(g) {
    return { pvp: 'Two players', 'ai-b': 'You vs computer', 'ai-w': 'Computer vs you' }[g.mode] || 'Game';
  }

  function showSkippedGames(count) {
    const notice = $('reviewSkipped');
    notice.hidden = !count;
    notice.textContent = count
      ? 'Skipped ' + count + ' malformed saved game' + (count === 1 ? '.' : 's.')
      : '';
  }

  // Raw IndexedDB rows are not trusted merely because they were once written.
  // Apply the store's score/FEN boundary, then the same legal replay Review
  // itself uses. Optional forensic telemetry is deliberately NOT part of this
  // gate: a damaged search log must not hide a recoverable board score or clean
  // PGN. Debug export applies the complete record boundary separately below.
  // The returned state lets the open path avoid dereferencing the row until
  // both score checks have passed.
  function reviewState(game) {
    if (typeof CoachStore.validateGameReplayRecord !== 'function') {
      return { error: 'validation unavailable' };
    }
    const recordError = CoachStore.validateGameReplayRecord(game);
    if (recordError) return { error: recordError };
    try { return { state: replayGame(game) }; }
    catch (e) { return { error: e && e.message ? e.message : 'replay failed' }; }
  }

  const DIFF_LABELS = Object.freeze(Object.assign(Object.create(null), {
    1: 'Easy', 2: 'Medium', 3: 'Hard', 5: 'Expert', master: 'Master'
  }));

  function pad2(n) { return String(n).padStart(2, '0'); }

  function dateTag(d) {
    if (!Number.isFinite(d.getTime())) return null;
    return d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate());
  }

  // Metadata absent from older Play archive rows is reconstructed the same
  // way as Play's clean PGN export. Imported tags stay intact; serializeRecord
  // later forces the archive's authoritative Result and SetUp/FEN over them.
  function exportTags(game) {
    const tags = {};
    const stored = game.tags && typeof game.tags === 'object' &&
      !Array.isArray(game.tags) ? game.tags : {};
    if (game.mode === 'ai-b' || game.mode === 'ai-w') {
      const level = DIFF_LABELS[game.difficulty];
      const ai = 'Chessy AI' + (level ? ' (' + level + ')' : '');
      tags.White = game.mode === 'ai-b' ? 'Human' : ai;
      tags.Black = game.mode === 'ai-b' ? ai : 'Human';
    } else if (game.mode === 'pvp') {
      tags.White = 'Human';
      tags.Black = 'Human';
    }

    if (typeof stored.Date !== 'string' || !stored.Date) {
      if (typeof stored.UTCDate === 'string' &&
          /^\d{4}\.\d{2}\.\d{2}$/.test(stored.UTCDate)) {
        tags.Date = stored.UTCDate;
      } else {
        // Import time is not play time: an undated imported game must keep an
        // unknown PGN Date instead of acquiring the day it entered Chessy.
        const at = Number.isFinite(game.playedAt) ? game.playedAt
          : (game.source === 'play' ? game.createdAt : null);
        const derived = Number.isFinite(at) ? dateTag(new Date(at)) : null;
        if (derived) tags.Date = derived;
      }
    }
    if ((typeof stored.TimeControl !== 'string' || !stored.TimeControl) &&
        typeof game.timeControl === 'string' && game.timeControl !== 'unknown') {
      tags.TimeControl = game.timeControl === 'none' ? '-' : game.timeControl;
    }
    if (typeof game.reason === 'string' &&
        game.reason.indexOf('time forfeit') === 0) {
      tags.Termination = 'time forfeit';
    } else if (game.result === '*' && game.reason === 'abandoned') {
      tags.Termination = 'abandoned';
    } else if (game.reason === 'resignation' ||
               game.reason === 'draw agreement') {
      // PGN uses the broad standard value "normal"; the archive reason and
      // ending comment preserve which ordinary chess ending occurred.
      tags.Termination = 'normal';
    }
    return tags;
  }

  function downloadReviewPgn(withLog) {
    // Export the exact in-memory snapshot being shown. A same-id archive
    // revision landing concurrently must not make the file differ from the
    // board the user chose to save.
    const opened = review;
    if (!opened || !opened.game) return;
    if (typeof ChessyPGN === 'undefined' ||
        typeof ChessyPGN.serializeRecord !== 'function') {
      $('reviewStatus').textContent =
        'PGN export is unavailable. Reload after the offline update finishes.';
      return;
    }
    // A clean game score is still recoverable if optional forensic evidence
    // was damaged in an old/raw IndexedDB row. Only the debug download needs
    // the complete archive trust boundary to pass.
    if (withLog) {
      if (typeof CoachStore.validateGameRecord !== 'function') {
        $('reviewStatus').textContent =
          'Search-log validation is unavailable. Save the clean PGN instead.';
        return;
      }
      const validationError = CoachStore.validateGameRecord(opened.game);
      if (validationError) {
        $('reviewStatus').textContent =
          'The saved search log is invalid. Save the clean PGN instead.';
        return;
      }
    }
    let pgn;
    try {
      pgn = ChessyPGN.serializeRecord(
        opened.game, exportTags(opened.game), withLog);
    } catch (e) {
      $('reviewStatus').textContent = withLog
        ? 'This archived search log could not be exported. Save the clean PGN instead.'
        : 'This archived game could not be exported.';
      return;
    }

    const at = Number.isFinite(opened.game.playedAt)
      ? opened.game.playedAt : opened.game.createdAt;
    let stamp = new Date(Number.isFinite(at) ? at : Date.now());
    if (!Number.isFinite(stamp.getTime())) stamp = new Date();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([pgn], {
      type: 'application/x-chess-pgn'
    }));
    a.download = 'chessy-' + stamp.getFullYear() +
      pad2(stamp.getMonth() + 1) + pad2(stamp.getDate()) + '-' +
      pad2(stamp.getHours()) + pad2(stamp.getMinutes()) +
      (withLog ? '-debug' : '') + '.pgn';
    // This transport-only link exists for one second; keep it out of keyboard
    // order and the accessibility tree while the visible button retains focus.
    a.tabIndex = -1;
    a.setAttribute('aria-hidden', 'true');
    document.body.appendChild(a);
    a.click();
    // Safari can cancel a just-started download if its object URL is revoked
    // synchronously; keep the same short grace period as Play and Backup.
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function renderGameList() {
    review = null; // leaving a game abandons its (unsaved) reflection state
    resetScanUi();
    $('reviewFlow').hidden = true;
    $('gameListWrap').hidden = false;
    // Announce the abandonment: the reflection flow cancels any in-flight
    // probe when it observes current() === null.
    document.dispatchEvent(new CustomEvent('chessy:reviewrender'));
    // Clear SYNCHRONOUSLY before the read: a revised game's old button
    // captured the obsolete record at the previous render, and must not
    // stay clickable while a slow listGames() is in flight.
    $('gameList').innerHTML = '';
    $('reviewEmpty').hidden = true;
    showSkippedGames(0);
    return CoachStore.listGames().then(function (storedGames) {
      // Filter in memory only. Keeping the original array order preserves the
      // store's newest-first ordering for every valid row.
      const games = [];
      let skipped = 0;
      for (const game of storedGames) {
        if (typeof ChessyArchive !== 'undefined' &&
            typeof ChessyArchive.suppressesEnding === 'function' &&
            ChessyArchive.suppressesEnding(
              game.id, game.sans, game.result, game.reason)) {
          continue;
        }
        if (reviewState(game).error) skipped++;
        else games.push(game);
      }
      showSkippedGames(skipped);
      const list = $('gameList');
      list.innerHTML = '';
      $('reviewEmpty').hidden = games.length > 0;
      $('reviewEmpty').textContent = skipped
        ? 'No reviewable saved games are available.'
        : 'No games saved yet — finish a game or start a new one after making moves.';
      for (const g of games) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'game-item';
        const when = new Date(g.createdAt);
        const outcome = g.result === '*'
          ? ('Incomplete' + (g.reason === 'abandoned' ? ' · Abandoned' : ''))
          : (g.result + (g.reason ? ' (' + g.reason + ')' : ''));
        btn.textContent = gameLabel(g) + ' · ' + outcome + ' · ' +
          Math.ceil(g.plies / 2) + ' moves · ' + when.toLocaleDateString();
        btn.addEventListener('click', function () { openReview(g); });
        li.appendChild(btn);
        list.appendChild(li);
      }
    }).catch(function () {
      $('reviewEmpty').hidden = false;
      $('reviewEmpty').textContent = 'Archive unavailable in this browser.';
    });
  }

  // ---- Position browser ----
  const reviewBoard = ChessyMiniBoard.make($('reviewBoard'), null);
  let review = null; // { game, gs, fens[], states[], ply }
  let historyRenderKey = null;

  // The game's OWN starting position — a custom SetUp/FEN (imported games) or
  // the standard start — as a fresh full game state each call.
  function initialState(game) {
    if (game.setupFen) {
      const s = Chess.parseFen(game.setupFen);
      if (!s.history) s.history = [];
      if (!s.positions) { s.positions = {}; s.positions[Chess.positionKey(s)] = 1; }
      return s;
    }
    return Chess.newGameState();
  }

  // Replay the archived SANs from that initial position (Chess.replaySans
  // always starts from the standard start, so it can't replay an imported
  // SetUp/FEN game). Throws on the first SAN that doesn't match a legal move.
  function replayGame(game) {
    let s = initialState(game);
    for (const san of game.sans) {
      if (Chess.gameStatus(s).over) {
        throw new Error('move played after the game ended');
      }
      const legal = Chess.legalMoves(s);
      const m = legal.find(function (mv) { return Chess.toSan(s, mv, legal) === san; });
      if (!m) throw new Error('illegal or unknown SAN "' + san + '"');
      s = Chess.playMove(s, m);
    }
    return s;
  }

  function openReview(game) {
    const checked = reviewState(game);
    if (checked.error) {
      showSkippedGames(1);
      $('reviewEmpty').hidden = false;
      $('reviewEmpty').textContent = 'This malformed saved game was skipped.';
      return false;
    }
    const gs = checked.state;
    const fens = gs.history.map(function (h) { return h.fen; });
    fens.push(Chess.toFen(gs));
    // Full game states per ply (WITH repetition tables): engine analysis
    // of "the position before move k" needs the repetition counts a bare
    // FEN cannot carry (assets/reflection.js). Starts from the game's OWN
    // initial position so SetUp/FEN imports browse correctly.
    let s = initialState(game);
    const states = [s];
    for (const h of gs.history) {
      s = Chess.playMove(s, h.move);
      states.push(s);
    }
    review = { game: game, gs: gs, fens: fens, states: states, ply: 0 };
    historyRenderKey = null;
    scanGameId = game.id;
    scanReview = review;
    scanAcceptEvents = false;
    // Stop ownership from whichever game/revision was previously open before
    // any asynchronous checkpoint lookup can expose the new review.
    if (typeof ChessyMomentScan !== 'undefined' && ChessyMomentScan.pause) {
      scanStopPromise = Promise.resolve(ChessyMomentScan.pause())
        .catch(function () { return null; });
    } else {
      scanStopPromise = Promise.resolve();
    }
    $('gameListWrap').hidden = true;
    $('reviewFlow').hidden = false;
    loadScanForReview(review);
    renderReview();
    // Opening hides the list (often holding focus on the clicked item):
    // move focus to the start of the region that replaced it — keyboard
    // and screen-reader users must never be left on a hidden element.
    $('reviewBack').focus();
    return true;
  }

  function renderReview() {
    const r = review;
    const state = Chess.parseFen(r.fens[r.ply]);
    const last = r.ply > 0 ? r.gs.history[r.ply - 1].move : null;
    // A checked king (checkmate's final position included) keeps the Play
    // board's highlight and "in check" announcement on the review board.
    const inCheck = Chess.inCheck(state, state.turn);
    const kingSq = inCheck ? state.board.indexOf(state.turn + 'K') : -1;
    reviewBoard.render(state, { lastMove: last, check: kingSq });
    const side = state.turn === 'w' ? 'White' : 'Black';
    const played = r.ply < r.gs.history.length ? r.gs.history[r.ply] : null;
    const savedEnd = r.game.result === '*'
      ? 'saved incomplete position' : 'end of game';
    $('reviewStatus').textContent = 'Position ' + r.ply + '/' + r.gs.history.length +
      ' · ' + side + ' to move' + (inCheck ? ' (in check)' : '') +
      (played ? ' · played here: ' + played.san : ' · ' + savedEnd);
    $('revStart').disabled = r.ply === 0;
    $('revPrev').disabled = r.ply === 0;
    $('revNext').disabled = r.ply >= r.gs.history.length;
    $('revEnd').disabled = r.ply >= r.gs.history.length;
    renderMoveHistory();
    // The reflection flow (assets/reflection.js) tracks the shown position.
    document.dispatchEvent(new CustomEvent('chessy:reviewrender'));
  }

  function stepReview(to) {
    review.ply = Math.max(0, Math.min(review.gs.history.length, to));
    renderReview();
  }

  // A narrow navigation seam for spoiler-free moment suggestions. Reject
  // malformed or stale locations instead of silently clamping them onto a
  // different position.
  function goToPly(ply) {
    if (!review || !Number.isInteger(ply) ||
        ply < 0 || ply > review.gs.history.length) return false;
    stepReview(ply);
    return true;
  }

  // ---- Full SAN history + Gate-0 score overlays -----------------------
  // The archived SAN ledger is always safe to show: it is the player's game,
  // not engine output. Scores and both source/generated annotations are added
  // only when the scan controller's sanitized public state releases that ply.
  const NAG_GLYPHS = Object.freeze({
    '$1': '!', '$2': '?', '$3': '!!',
    '$4': '??', '$5': '!?', '$6': '?!'
  });
  const NAG_WORDS = Object.freeze({
    '!': 'good move', '?': 'mistake', '!!': 'brilliant move',
    '??': 'blunder', '!?': 'interesting move', '?!': 'dubious move'
  });

  function reportByPly() {
    const out = Object.create(null);
    const report = scanState && Array.isArray(scanState.report)
      ? scanState.report : [];
    report.forEach(function (entry) {
      if (entry && Number.isInteger(entry.ply) &&
          entry.ply >= 0 && review &&
          entry.ply < review.gs.history.length &&
          entry.playedSan === review.gs.history[entry.ply].san) {
        out[entry.ply] = entry;
      }
    });
    return out;
  }

  function importedNags(game, ply) {
    const move = game && Array.isArray(game.moves) ? game.moves[ply] : null;
    if (!move || move.san !== game.sans[ply] || !Array.isArray(move.nags)) {
      return [];
    }
    const seen = Object.create(null);
    return move.nags.map(function (nag) {
      return Object.prototype.hasOwnProperty.call(NAG_GLYPHS, nag)
        ? NAG_GLYPHS[nag] : null;
    })
      .filter(function (glyph) {
        if (!glyph || seen[glyph]) return false;
        seen[glyph] = true;
        return true;
      });
  }

  function spokenScore(text) {
    if (!text) return '';
    return text.replace(/^−/, 'minus ').replace(/^-/, 'minus ')
      .replace(/^\+/, 'plus ')
      .replace('M', 'mate in ');
  }

  function addNag(button, glyph, source) {
    const mark = document.createElement('span');
    mark.className = 'review-nag ' + source;
    mark.textContent = (source === 'source' ? 'PGN ' : 'Chessy ') + glyph;
    mark.setAttribute('aria-label',
      (source === 'source' ? 'Imported PGN annotation: ' :
        'Chessy deep-verified annotation: ') +
      (NAG_WORDS[glyph] || glyph));
    button.appendChild(mark);
  }

  function historyPlyButton(ply, report, showImported) {
    const r = review;
    const state = r.states[ply];
    const entry = r.gs.history[ply];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'review-ply' + (r.ply === ply ? ' current' : '');
    button.dataset.ply = String(ply);
    if (r.ply === ply) button.setAttribute('aria-current', 'step');

    const san = document.createElement('span');
    san.className = 'review-san';
    san.textContent = entry.san;
    button.appendChild(san);

    let label = 'Move ' + state.fullmove + ', ' +
      (state.turn === 'w' ? 'White' : 'Black') + ', ' + entry.san +
      '. Review the position before this move';
    if (showImported) {
      importedNags(r.game, ply).forEach(function (glyph) {
        addNag(button, glyph, 'source');
        label += ', imported PGN annotation ' + (NAG_WORDS[glyph] || glyph);
      });
    }
    if (report && typeof ChessyAnalysisNotation !== 'undefined') {
      const text = ChessyAnalysisNotation.formatWhite(report);
      if (text) {
        const score = document.createElement('span');
        score.className = 'review-eval' + (report.estimate ? ' estimate' : '');
        score.textContent = (report.estimate ? '≈ ' : '') + text;
        score.title = report.estimate
          ? 'Quick scan estimate for the played move'
          : 'Deep analysis estimate for the played move';
        button.appendChild(score);
        label += ', ' + (report.estimate
          ? 'quick estimate ' : 'deep analysis estimate ') +
          spokenScore(text) + ' for White on the played line';
      }
      if (report.annotation) {
        addNag(button, report.annotation, 'chessy');
        label += ', Chessy annotation ' +
          (NAG_WORDS[report.annotation] || report.annotation);
      }
    }
    button.setAttribute('aria-label', label);
    button.addEventListener('click', function () { goToPly(ply); });
    return button;
  }

  function historyNote() {
    const visibleReport = scanState && Array.isArray(scanState.report)
      ? scanState.report : [];
    const hasVisibleSource = review && visibleReport.some(function (entry) {
      return entry && Number.isInteger(entry.ply) &&
        importedNags(review.game, entry.ply).length > 0;
    });
    const provenance = hasVisibleSource
      ? ' PGN marks are move-quality annotations from the imported game; ' +
        'Chessy marks are generated.'
      : '';
    if (!scanState || scanState.state === 'idle') {
      return 'Select a move to review the position before it. Start a scan, then ' +
        'reflect before scores or annotations appear.';
    }
    if (scanState.state !== 'done') {
      return 'Select a move to review the position before it. Scores remain hidden ' +
        'while the spoiler-free scan is incomplete.';
    }
    if (scanState.reportUnlocked) {
      let text = 'Each score is Chessy’s evaluation of the played line from ' +
        'White’s perspective. ' +
        '≈ marks a quick estimate; Chessy ?!, ? and ?? appear only on stable, ' +
        'deep-confirmed moments. Moves whose analysis was unresolved have no score.';
      return text + provenance;
    }
    const needed = Number(scanState.reflectionRequired) || 0;
    const done = Number(scanState.reflectionCompleted) || 0;
    if (!needed) {
      return 'No usable score history was produced. You can still review and ' +
        'flag any move manually.';
    }
    const revealed = Array.isArray(scanState.report)
      ? scanState.report.length : 0;
    if (revealed) {
      return 'Each reflected analyzed move reveals its score. Reflect on ' +
        (needed - done) + ' remaining suggested moment' +
        (needed - done === 1 ? '' : 's') +
        ' to unlock the complete score history.' + provenance;
    }
    return needed === 1 && (!scanState.moments || !scanState.moments.length)
      ? 'Reflect on any scanned move to unlock the score history.'
      : 'Reflect on the ' + needed + ' suggested moment' +
        (needed === 1 ? '' : 's') +
        ' before Chessy reveals scores or annotations.';
  }

  function renderMoveHistory() {
    const list = $('reviewMoveList');
    if (!list || !review) return;
    const stateKey = scanState ? {
      state: scanState.state,
      reflectionRequired: scanState.reflectionRequired,
      reflectionCompleted: scanState.reflectionCompleted,
      reportUnlocked: scanState.reportUnlocked,
      moments: Array.isArray(scanState.moments) ? scanState.moments.length : 0,
      report: Array.isArray(scanState.report) ? scanState.report : null
    } : null;
    const nextKey = review.ply + '|' + JSON.stringify(stateKey);
    if (historyRenderKey === nextKey) return;
    const active = document.activeElement;
    const focusedPly = active && list.contains(active) &&
      active.classList.contains('review-ply') ? active.dataset.ply : null;
    const previousScroll = list.scrollTop;
    const reports = reportByPly();
    const showAllImported = !!scanState && scanState.reportUnlocked === true;
    list.textContent = '';
    const rows = [];
    for (let ply = 0; ply < review.gs.history.length; ply++) {
      const state = review.states[ply];
      let row = rows.length ? rows[rows.length - 1] : null;
      if (!row || row.number !== state.fullmove) {
        row = { number: state.fullmove, white: null, black: null };
        rows.push(row);
      }
      row[state.turn === 'w' ? 'white' : 'black'] = ply;
    }
    rows.forEach(function (row) {
      const li = document.createElement('li');
      const number = document.createElement('span');
      number.className = 'review-move-number';
      number.textContent = row.number + (row.white === null ? '…' : '.');
      li.appendChild(number);
      ['white', 'black'].forEach(function (side) {
        const ply = row[side];
        if (ply === null) {
          const empty = document.createElement('span');
          empty.className = 'review-ply empty';
          empty.setAttribute('aria-hidden', 'true');
          li.appendChild(empty);
          return;
        }
        li.appendChild(historyPlyButton(
          ply, reports[ply] || null, showAllImported || !!reports[ply]));
      });
      list.appendChild(li);
    });
    const nextNote = historyNote();
    if ($('reviewHistoryNote').textContent !== nextNote) {
      $('reviewHistoryNote').textContent = nextNote;
    }
    historyRenderKey = nextKey;
    list.scrollTop = previousScroll;
    if (focusedPly !== null) {
      const replacement = list.querySelector(
        '.review-ply[data-ply="' + focusedPly + '"]');
      if (replacement) {
        try { replacement.focus({ preventScroll: true }); }
        catch (e) { replacement.focus(); }
        list.scrollTop = previousScroll;
      }
    }
  }

  // ---- Explicit critical-moment scan UI (Phase 5b) ---------------------
  // The controller's public state is deliberately spoiler-safe. This layer
  // renders only progress and up to two { ply, playedSan } links; it never
  // reads candidates, scores, categories or alternative moves from storage.
  let scanGameId = null;
  let scanState = null;
  let scanBusy = false;
  let scanSeq = 0;
  let scanSelectedColor = null;
  let scanNotice = null;
  let scanReview = null;
  let scanAcceptEvents = false;
  let scanLivePausing = false;
  let scanStopPromise = Promise.resolve();
  let scanNeedsReopen = false;
  let scanFocusFallback = false;

  function hasScanUi() {
    return !!$('momentScan') && typeof ChessyMomentScan !== 'undefined';
  }

  function liveTimedGameActive() {
    const note = $('liveGameNote');
    return !!note && note.dataset.active === 'true';
  }

  function importedUnknown(r) {
    const c = r && r.game && r.game.playerColor;
    return c !== 'w' && c !== 'b' && c !== 'both';
  }

  function selectedScanColor() {
    const picked = document.querySelector('input[name="scanColor"]:checked');
    return picked ? picked.value : null;
  }

  function rememberScanColor(color) {
    scanSelectedColor = color === 'w' || color === 'b' || color === 'both'
      ? color : null;
    const radios = document.querySelectorAll('input[name="scanColor"]');
    radios.forEach(function (radio) {
      radio.checked = radio.value === scanSelectedColor;
    });
  }

  function moveLabel(moment) {
    const state = review && review.states && review.states[moment.ply];
    if (!state || !Number.isInteger(state.fullmove) ||
        (state.turn !== 'w' && state.turn !== 'b')) return moment.playedSan;
    return state.fullmove + (state.turn === 'b' ? '… ' : '. ') + moment.playedSan;
  }

  function openSuggestion(moment) {
    if (!review || review.game.id !== scanGameId ||
        !moment || !Number.isInteger(moment.ply)) return;
    if (!goToPly(moment.ply)) return;
    const reflection = window.ChessyReflection || window.CoachReflection;
    if (reflection && reflection.beginCurrent) reflection.beginCurrent();
  }

  function renderMoments(state) {
    const wrap = $('scanSuggestions');
    const list = $('scanMomentList');
    if (!wrap || !list) return;
    list.textContent = '';
    const moments = state && Array.isArray(state.moments)
      ? state.moments.slice(0, 2) : [];
    wrap.hidden = moments.length === 0;
    moments.forEach(function (moment) {
      if (!moment || !Number.isInteger(moment.ply) ||
          typeof moment.playedSan !== 'string') return;
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn scan-moment';
      button.textContent = moveLabel(moment);
      button.addEventListener('click', function () { openSuggestion(moment); });
      li.appendChild(button);
      list.appendChild(li);
    });
    wrap.hidden = list.children.length === 0;
  }

  function progressText(state) {
    if (!state) return 'Not scanned yet.';
    if (state.state === 'running') {
      if (state.pass === 2) {
        return 'Confirming suggestions… ' + state.verifyIndex +
          ' of ' + state.verifyTotal + '.';
      }
      return 'Checking moves… ' + state.checked + ' of ' + state.total + '.';
    }
    if (state.state === 'paused') {
      return (state.error ? state.error + ' ' : 'Scan paused. ') +
        'Checked ' + state.checked + ' of ' + state.total + '.';
    }
    if (state.state === 'done') {
      const n = Array.isArray(state.moments) ? Math.min(state.moments.length, 2) : 0;
      let text = n
        ? 'Scan complete — ' + n + ' moment' + (n === 1 ? '' : 's') + ' suggested.'
        : 'Scan complete — no moments suggested. You can still flag any position yourself.';
      if (state.unresolvedCount) text += ' Some positions could not be checked.';
      return text;
    }
    return 'Not scanned yet.';
  }

  function renderProgressMeter(state) {
    const meter = $('scanMeter');
    if (!meter) return;
    meter.hidden = !state || state.state === 'idle';
    if (!state || state.state === 'idle') return;
    if (state.state === 'done') {
      meter.max = 1;
      meter.value = 1;
      return;
    }
    if (state.pass === 2) {
      meter.max = Math.max(1, Number(state.verifyTotal) || 0);
      meter.value = Math.min(meter.max, Math.max(0, Number(state.verifyIndex) || 0));
      return;
    }
    meter.max = Math.max(1, Number(state.total) || 0);
    meter.value = Math.min(meter.max, Math.max(0, Number(state.checked) || 0));
  }

  function renderScanUi() {
    if (!hasScanUi() || !review || review !== scanReview ||
        review.game.id !== scanGameId) return;
    const focusedControl = ['scanStart', 'scanResume', 'scanPause']
      .map(function (id) { return $(id); })
      .find(function (button) { return document.activeElement === button; }) || null;
    const unknown = importedUnknown(review);
    const live = liveTimedGameActive();
    const running = !!scanState && scanState.state === 'running';
    const paused = !!scanState && scanState.state === 'paused';
    const done = !!scanState && scanState.state === 'done';
    const hasChoice = !unknown || !!selectedScanColor();
    const reflecting = !$('reflectForm').hidden || !$('verifyBox').hidden;

    $('scanSideChoice').hidden = !unknown;
    document.querySelectorAll('input[name="scanColor"]').forEach(function (radio) {
      // A paused scan resumes its exact stored side; changing side is an
      // explicit fresh scan available before starting or after completion.
      radio.disabled = scanBusy || live || reflecting || running || paused ||
        scanNeedsReopen;
    });

    $('scanStart').hidden = running || paused;
    $('scanStart').textContent = done ? 'Scan again' : 'Start scan';
    $('scanStart').disabled = scanBusy || live || reflecting || !hasChoice ||
      scanNeedsReopen;
    $('scanResume').hidden = !paused;
    $('scanResume').disabled = scanBusy || live || reflecting;
    $('scanPause').hidden = !running;
    $('scanPause').disabled = scanBusy || reflecting;

    let text = progressText(scanState);
    if (live) {
      text = 'A timed game is still running. Return to Play or let it finish before scanning.';
    } else if (reflecting) {
      text = 'Finish or leave this reflection before scanning.';
    } else if (scanNotice) {
      text = scanNotice;
    } else if (unknown && !hasChoice && !scanState) {
      text = 'Choose White, Black or Both to start.';
    }
    $('scanProgress').textContent = text;
    renderProgressMeter(scanState);
    renderMoments(scanState);
    renderMoveHistory();
    document.querySelectorAll('#scanMomentList .scan-moment').forEach(function (button) {
      button.disabled = reflecting;
    });
    // Hiding OR disabling a focused control may drop Chromium's focus to
    // <body>. Keep a deliberate status fallback while work is gated, then
    // promote focus to the next usable action as soon as it appears.
    const next = [$('scanPause'), $('scanResume'), $('scanStart')]
      .find(function (button) { return !button.hidden && !button.disabled; });
    if (focusedControl && (focusedControl.hidden || focusedControl.disabled)) {
      (next || $('scanProgress')).focus();
      scanFocusFallback = !next;
    } else if (scanFocusFallback && document.activeElement === $('scanProgress')) {
      if (next) {
        next.focus();
        scanFocusFallback = false;
      }
    } else if (document.activeElement !== $('scanProgress')) {
      scanFocusFallback = false;
    }
  }

  function resetScanUi() {
    scanSeq++;
    scanGameId = null;
    scanReview = null;
    scanAcceptEvents = false;
    scanLivePausing = false;
    scanStopPromise = Promise.resolve();
    scanNeedsReopen = false;
    scanFocusFallback = false;
    scanState = null;
    scanBusy = false;
    scanNotice = null;
    historyRenderKey = null;
    rememberScanColor(null);
    if (!$('momentScan')) return;
    $('scanMomentList').textContent = '';
    $('scanSuggestions').hidden = true;
    $('scanMeter').hidden = true;
    $('scanProgress').textContent = 'Not scanned yet.';
  }

  function loadScanForReview(r) {
    if (!hasScanUi() || !r || !r.game) return;
    const token = ++scanSeq;
    scanAcceptEvents = false;
    scanNeedsReopen = false;
    scanFocusFallback = false;
    scanBusy = true;
    scanState = null;
    scanNotice = null;
    rememberScanColor(null);
    $('scanProgress').textContent = 'Loading saved scan…';
    renderScanUi();
    // Known-side games get a lightweight idle job before analysis starts. That
    // lets a valid manual reflection made before Start retain its Gate-0 receipt
    // without making the untouched game look resumable or dispatching work.
    scanStopPromise.then(function () {
      if (token !== scanSeq || review !== r) return null;
      return CoachStore.getJob(r.game.id);
    }).then(function (stored) {
      if (token !== scanSeq || review !== r) return null;
      const storedColor = stored &&
        (stored.scanColor === 'w' || stored.scanColor === 'b' ||
         stored.scanColor === 'both') ? stored.scanColor : null;
      rememberScanColor(storedColor);
      if (!stored && importedUnknown(r)) return null;
      return ChessyMomentScan.load(r);
    }).then(function (state) {
      if (token !== scanSeq || review !== r) return;
      scanBusy = false;
      scanState = state || null;
      scanAcceptEvents = true;
      renderScanUi();
    }).catch(function () {
      if (token !== scanSeq || review !== r) return;
      scanBusy = false;
      scanState = null;
      scanAcceptEvents = true;
      scanNotice = 'Saved scan progress could not be loaded. Start a fresh scan.';
      renderScanUi();
    });
  }

  function runScan(kind) {
    if (!hasScanUi() || !review || liveTimedGameActive()) {
      renderScanUi();
      return;
    }
    const color = importedUnknown(review) ? selectedScanColor() : undefined;
    if (importedUnknown(review) && !color) {
      renderScanUi();
      const first = document.querySelector('input[name="scanColor"]');
      if (first) first.focus();
      return;
    }
    const opened = review;
    const token = ++scanSeq;
    scanAcceptEvents = true;
    scanBusy = true;
    scanNeedsReopen = false;
    scanNotice = null;
    if (color) rememberScanColor(color);
    renderScanUi();
    const opts = color ? { scanColor: color } : {};
    let work;
    if (kind === 'resume') {
      work = ChessyMomentScan.resume(opened, opts);
    } else {
      opts.restart = !(scanState && scanState.state === 'idle');
      work = ChessyMomentScan.start(opened, opts);
    }
    Promise.resolve(work).then(function (state) {
      if (token !== scanSeq || review !== opened) return;
      scanBusy = false;
      if (state) {
        scanState = state;
      } else {
        // A same-id archive replacement can make the controller's atomic
        // source guard stop ownership without a scanchange emission. Never
        // leave the last public "running" snapshot painted indefinitely.
        scanState = null;
        scanNeedsReopen = true;
        scanNotice = 'This archived game changed while Chessy was scanning. ' +
          'Return to All games and reopen it before scanning again.';
      }
      renderScanUi();
    }).catch(function () {
      if (token !== scanSeq || review !== opened) return;
      scanBusy = false;
      scanNotice = 'Chessy could not continue this scan. Try again.';
      renderScanUi();
    });
  }

  $('scanStart').addEventListener('click', function () { runScan('start'); });
  $('scanResume').addEventListener('click', function () { runScan('resume'); });
  $('scanPause').addEventListener('click', function () {
    if (!hasScanUi()) return;
    const opened = review;
    const token = ++scanSeq; // supersede the still-pending start()/resume()
    scanBusy = true;
    scanNotice = null;
    renderScanUi();
    Promise.resolve(ChessyMomentScan.pause()).then(function (state) {
      if (token !== scanSeq || review !== opened) return;
      scanBusy = false;
      if (state) scanState = state;
      renderScanUi();
    }).catch(function () {
      if (token !== scanSeq || review !== opened) return;
      scanBusy = false;
      scanNotice = 'Chessy could not save the pause. Try again.';
      renderScanUi();
    });
  });
  document.querySelectorAll('input[name="scanColor"]').forEach(function (radio) {
    radio.addEventListener('change', function () {
      rememberScanColor(selectedScanColor());
      renderScanUi();
    });
  });
  document.addEventListener('chessy:scanchange', function (e) {
    const state = e.detail || null;
    if (!scanAcceptEvents || !review || review !== scanReview || !scanGameId) return;
    if (state && state.gameId !== scanGameId) return;
    scanState = state;
    scanNotice = null;
    if (state) scanNeedsReopen = false;
    // start()/resume() resolve only after the entire scan. Once the controller
    // announces running ownership, release the startup latch so Pause is a
    // real, immediately usable control.
    if (state && state.state === 'running') scanBusy = false;
    enforceLiveScanGate();
  });
  document.addEventListener('chessy:reflectionchange', renderScanUi);

  function enforceLiveScanGate() {
    if (!hasScanUi() || !review || review !== scanReview) return;
    if (!liveTimedGameActive() || !scanState ||
        scanState.state !== 'running' || scanLivePausing) {
      renderScanUi();
      return;
    }
    scanLivePausing = true;
    const opened = review;
    const token = ++scanSeq;
    scanBusy = true;
    renderScanUi();
    Promise.resolve(ChessyMomentScan.pause()).then(function (state) {
      if (token !== scanSeq || review !== opened) return;
      scanLivePausing = false;
      scanBusy = false;
      if (state) scanState = state;
      renderScanUi();
    }).catch(function () {
      if (token !== scanSeq || review !== opened) return;
      scanLivePausing = false;
      scanBusy = false;
      scanNotice = 'The live game interrupted this scan. Resume after it finishes.';
      renderScanUi();
    });
  }
  document.addEventListener('chessy:viewchange', enforceLiveScanGate);
  document.addEventListener('chessy:livegamechange', enforceLiveScanGate);

  // Back hides the flow (and the focused Back button itself): once the
  // list is rebuilt, move focus onto it. Only this path moves focus —
  // showView('review') from a tab click must leave focus on the tab.
  $('reviewBack').addEventListener('click', function () {
    renderGameList().then(function () {
      const firstItem = $('gameList').querySelector('button');
      (firstItem || $('tabReview')).focus();
    });
  });
  $('reviewExportPgn').addEventListener('click', function () {
    downloadReviewPgn(false);
  });
  $('reviewExportPgnLog').addEventListener('click', function () {
    downloadReviewPgn(true);
  });
  $('revStart').addEventListener('click', function () { stepReview(0); });
  $('revPrev').addEventListener('click', function () { stepReview(review.ply - 1); });
  $('revNext').addEventListener('click', function () { stepReview(review.ply + 1); });
  $('revEnd').addEventListener('click', function () { stepReview(review.gs.history.length); });

  // ---- Game-over handoff (app.js) ----
  // Opens the archived record BY ITS UUID — the same key the archive
  // writes, so there is no "latest game" bookkeeping to go stale. Focus
  // must be MOVED into the view that opens (the game-over dialog has
  // already closed): keyboard/screen-reader users would otherwise be left
  // on the stale Play board. Returns to the game list when the record is
  // missing (e.g. its archive write failed).
  function openArchivedGame(gameId) {
    showView('review');
    // No id at all (the archive write failed): the game list IS the
    // destination — never guess at some other record.
    if (!gameId) {
      $('tabReview').focus();
      return Promise.resolve();
    }
    return CoachStore.getGame(gameId).then(function (game) {
      if (game && typeof ChessyArchive !== 'undefined' &&
          typeof ChessyArchive.suppressesEnding === 'function' &&
          ChessyArchive.suppressesEnding(
            game.id, game.sans, game.result, game.reason)) {
        return renderGameList().then(function () { $('tabReview').focus(); });
      }
      if (game && openReview(game)) return; // openReview moves focus into the flow
      else $('tabReview').focus();
    }).catch(function () { $('tabReview').focus(); });
  }

  window.CoachReview = {
    showView: showView,
    registerView: registerView,
    openArchivedGame: openArchivedGame,
    goToPly: goToPly,
    // Re-read the archive into the game list (used after an import commits a
    // new game). Resolves when the list is rebuilt; a no-op while a game is
    // open (reviewFlow visible), so an import launched from the list view
    // never disturbs an in-progress reflection.
    refreshGames: function () {
      if ($('gameListWrap').hidden) return Promise.resolve();
      return renderGameList();
    },
    // The currently open game and shown ply (null on the game list) — the
    // reflection flow reads this instead of duplicating browser state.
    current: function () { return review; },
    // Force the panel back to a FRESHLY rendered game list, abandoning any open
    // review/reflection — used after a destructive replace/clear. Unlike
    // refreshGames() this is unconditional (renderGameList already no-ops the
    // open-game guard by clearing `review`), so a game left open on the stale
    // archive can't keep taking Verify/Save actions against a record the
    // restore/delete just removed.
    resetToList: function () { return renderGameList(); }
  };
})();
