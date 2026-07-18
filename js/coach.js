/*
 * Chessy coach — the first vertical slice of the improvement loop:
 *
 *   archive (IndexedDB, js/store.js) → PGN import → position browser →
 *   HIDDEN self-reflection → engine verification → manual lesson card →
 *   fixed 1/3/7/14/30/90-day spaced review → honest progress counts.
 *
 * Design rules carried over from the coaching roadmap (#23):
 * - The engine's opinion is never shown before the player has answered the
 *   reflection questions (the form gates the verify step).
 * - The player owns the diagnosis: cause and lesson text are theirs; the
 *   engine contributes only moves and scores.
 * - Progress reports plain counts, not a headline "accuracy" number.
 *
 * The analysis engine is the playing engine (Master settings) run in its
 * OWN worker, so a live game's search is never disturbed. A watchdog
 * terminates an alive-but-silent worker and falls back to the synchronous
 * search, so verification can never hang the flow.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof Chess === 'undefined') return;

  const TXT = '︎';
  const GLYPHS = {
    wK: '♚' + TXT, wQ: '♛' + TXT, wR: '♜' + TXT,
    wB: '♝' + TXT, wN: '♞' + TXT, wP: '♟' + TXT,
    bK: '♚' + TXT, bQ: '♛' + TXT, bR: '♜' + TXT,
    bB: '♝' + TXT, bN: '♞' + TXT, bP: '♟' + TXT
  };
  const PIECE_NAMES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
  const CAUSE_LABELS = {
    'threat-scan': 'Missed a threat',
    candidates: 'Good move not among candidates',
    evaluation: 'Judged it wrong',
    calculation: 'Line went wrong on the reply',
    efficiency: 'Right idea, too much time',
    impulse: 'Moved too fast'
  };
  const DAY = 86400000;
  const LADDER_DAYS = [1, 3, 7, 14, 30, 90]; // fixed spaced-review ladder
  const AGAIN_DELAY = 10 * 60 * 1000;        // "Again" retries later today
  const MATE_ISH = 900000;                   // |score| above this reads as mate

  const $ = function (id) { return document.getElementById(id); };

  // ---- Views ----
  const VIEWS = ['play', 'review', 'train', 'progress'];

  function showView(name) {
    document.body.dataset.view = name;
    $('viewPlay').hidden = name !== 'play';
    $('viewReview').hidden = name !== 'review';
    $('viewTrain').hidden = name !== 'train';
    $('viewProgress').hidden = name !== 'progress';
    for (const v of VIEWS) {
      const tab = $('tab' + v[0].toUpperCase() + v.slice(1));
      if (name === v) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    if (name === 'review') renderGameList();
    if (name === 'train') loadTrain();
    if (name === 'progress') renderProgress();
  }

  for (const v of VIEWS) {
    $('tab' + v[0].toUpperCase() + v.slice(1))
      .addEventListener('click', function () { showView(v); });
  }

  // ---- Mini board (shared by Review and Train) ----
  // Same markup/classes as the play board so the CSS carries over; squares
  // are buttons only where the board is interactive (Train answers).
  function makeBoard(el, onClick) {
    el.innerHTML = '';
    const squares = [];
    for (let i = 0; i < 64; i++) {
      const cell = document.createElement(onClick ? 'button' : 'div');
      if (onClick) {
        cell.type = 'button';
        cell.addEventListener('click', onClick.bind(null, i));
      }
      cell.className = 'square ' + ((Math.floor(i / 8) + i) % 2 === 0 ? 'light' : 'dark');
      const glyph = document.createElement('span');
      glyph.className = 'piece';
      cell.appendChild(glyph);
      el.appendChild(cell);
      squares.push(cell);
    }
    return {
      render: function (state, opts) {
        opts = opts || {};
        for (let i = 0; i < 64; i++) {
          const cell = squares[i], p = state.board[i];
          cell.querySelector('.piece').textContent = p ? GLYPHS[p] : '';
          cell.classList.toggle('white-piece', !!p && p[0] === 'w');
          cell.classList.toggle('black-piece', !!p && p[0] === 'b');
          cell.classList.toggle('selected', i === opts.selected);
          cell.classList.toggle('last-move',
            !!opts.lastMove && (i === opts.lastMove.from || i === opts.lastMove.to));
          const target = opts.targets && opts.targets.find(function (m) { return m.to === i; });
          cell.classList.toggle('hint', !!target && !target.captured);
          cell.classList.toggle('hint-capture', !!target && !!target.captured);
          let label = Chess.sqName(i) +
            (p ? ', ' + (p[0] === 'w' ? 'white' : 'black') + ' ' + PIECE_NAMES[p[1]] : ', empty');
          cell.setAttribute('aria-label', label);
        }
      }
    };
  }

  // ---- Analysis (own worker + watchdog, sync fallback) ----
  let anWorker = null, anPending = null, anId = 0;
  const ANALYSIS = { maxDepth: 30, timeMs: 1200, quiesce: true };

  function analyse(fen) {
    return new Promise(function (resolve) {
      const id = ++anId;
      function fallback() {
        resolve(ChessAI.think(Chess.parseFen(fen), ANALYSIS));
      }
      if (typeof Worker === 'undefined') { setTimeout(fallback, 0); return; }
      if (!anWorker) {
        try { anWorker = new Worker('js/ai-worker.js'); } catch (e) { anWorker = null; }
        if (anWorker) {
          anWorker.onmessage = function (e) {
            if (anPending && e.data.id === anPending.id) {
              clearTimeout(anPending.watchdog);
              const p = anPending;
              anPending = null;
              p.resolve(e.data);
            }
          };
          anWorker.onerror = function () {
            const p = anPending;
            anPending = null;
            if (anWorker) { anWorker.terminate(); anWorker = null; }
            if (p) { clearTimeout(p.watchdog); p.fallback(); }
          };
        }
      }
      if (!anWorker) { setTimeout(fallback, 0); return; }
      // Watchdog: a worker that stays alive but never replies must not hang
      // the review flow — terminate it and answer synchronously.
      const watchdog = setTimeout(function () {
        const p = anPending;
        anPending = null;
        if (anWorker) { anWorker.terminate(); anWorker = null; }
        if (p) p.fallback();
      }, ANALYSIS.timeMs + 4000);
      anPending = { id: id, resolve: resolve, fallback: fallback, watchdog: watchdog };
      anWorker.postMessage({
        id: id, fen: fen,
        maxDepth: ANALYSIS.maxDepth, timeMs: ANALYSIS.timeMs, quiesce: ANALYSIS.quiesce
      });
    });
  }

  function fmtScore(s) {
    if (s > MATE_ISH) return '+M';
    if (s < -MATE_ISH) return '−M';
    return (s >= 0 ? '+' : '') + (s / 100).toFixed(1);
  }

  function lossLabel(lossCp) {
    if (lossCp >= 300) return 'a blunder';
    if (lossCp >= 100) return 'a mistake';
    if (lossCp >= 50) return 'an inaccuracy';
    return 'fine';
  }

  // ---- Archive hook (called by app.js when a game ends) ----
  // Dedupe is keyed on the game INSTANCE (app.js's gameSeq) plus the moves:
  // the same ending re-displayed archives once, while an identical game
  // legitimately replayed via New game/Rematch archives again.
  let lastArchiveSig = null;

  function archiveGame(state, settings, status, gameSeq) {
    if (!state.history.length || !status.over) return Promise.resolve(null);
    const sans = state.history.map(function (h) { return h.san; });
    const sig = (gameSeq || 0) + '|' + sans.join(' ') + '|' + status.result;
    if (sig === lastArchiveSig) return Promise.resolve(null); // re-shown end of the same game
    lastArchiveSig = sig;
    return CoachStore.addGame({
      source: 'play',
      tags: {},
      sans: sans,
      result: status.result,
      reason: status.reason,
      mode: settings.mode,
      difficulty: settings.difficulty,
      timeControl: settings.timeControl,
      plies: sans.length,
      createdAt: Date.now()
    }).catch(function () { return null; });
  }

  // ---- Review: game list ----
  function gameLabel(g) {
    if (g.source === 'import') {
      const w = (g.tags && g.tags.White) || 'White';
      const b = (g.tags && g.tags.Black) || 'Black';
      return w + ' vs ' + b;
    }
    return { pvp: 'Two players', 'ai-b': 'You vs computer', 'ai-w': 'Computer vs you' }[g.mode] || 'Game';
  }

  function renderGameList() {
    $('reviewFlow').hidden = true;
    $('gameListWrap').hidden = false;
    CoachStore.listGames().then(function (games) {
      const list = $('gameList');
      list.innerHTML = '';
      $('reviewEmpty').hidden = games.length > 0;
      for (const g of games) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'game-item';
        const when = new Date(g.createdAt);
        btn.textContent = gameLabel(g) + ' · ' + g.result +
          (g.reason ? ' (' + g.reason + ')' : '') + ' · ' +
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

  // ---- Review: position browser + reflection + verification ----
  const reviewBoard = makeBoard($('reviewBoard'), null);
  let review = null; // { game, gs, fens[], ply, flagged, verdict }

  function openReview(game) {
    let gs;
    try { gs = Chess.replaySans(game.sans); }
    catch (e) {
      $('reviewEmpty').hidden = false;
      $('reviewEmpty').textContent = 'This archived game no longer replays: ' + e.message;
      return;
    }
    const fens = gs.history.map(function (h) { return h.fen; });
    fens.push(Chess.toFen(gs));
    review = { game: game, gs: gs, fens: fens, ply: 0, flagged: null, verdict: null };
    $('gameListWrap').hidden = true;
    $('reviewFlow').hidden = false;
    renderReview();
  }

  function renderReview() {
    const r = review;
    const state = Chess.parseFen(r.fens[r.ply]);
    const last = r.ply > 0 ? r.gs.history[r.ply - 1].move : null;
    reviewBoard.render(state, { lastMove: last });
    const side = state.turn === 'w' ? 'White' : 'Black';
    const played = r.ply < r.gs.history.length ? r.gs.history[r.ply] : null;
    $('reviewStatus').textContent = 'Position ' + r.ply + '/' + r.gs.history.length +
      ' · ' + side + ' to move' + (played ? ' · played here: ' + played.san : ' · end of game');
    $('revStart').disabled = r.ply === 0;
    $('revPrev').disabled = r.ply === 0;
    $('revNext').disabled = r.ply >= r.gs.history.length;
    $('revEnd').disabled = r.ply >= r.gs.history.length;
    $('flagMoment').disabled = !played;
    // Stepping away from a flagged moment abandons the (unsaved) reflection.
    if (r.flagged !== r.ply) {
      r.flagged = null;
      r.verdict = null;
      $('reflectForm').hidden = true;
      $('verifyBox').hidden = true;
    }
  }

  function stepReview(to) {
    review.ply = Math.max(0, Math.min(review.gs.history.length, to));
    renderReview();
  }

  $('reviewBack').addEventListener('click', renderGameList);
  $('revStart').addEventListener('click', function () { stepReview(0); });
  $('revPrev').addEventListener('click', function () { stepReview(review.ply - 1); });
  $('revNext').addEventListener('click', function () { stepReview(review.ply + 1); });
  $('revEnd').addEventListener('click', function () { stepReview(review.gs.history.length); });

  $('flagMoment').addEventListener('click', function () {
    review.flagged = review.ply;
    $('reflectThreat').value = '';
    $('reflectCandidates').value = '';
    $('reflectEval').value = 'equal';
    $('reflectForm').hidden = false;
    $('verifyBox').hidden = true;
    $('cardSaved').hidden = true;
    $('reflectThreat').focus();
  });

  $('reflectForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const r = review;
    if (r.flagged === null) return;
    const ply = r.flagged;
    const fenBefore = r.fens[ply];
    const entry = r.gs.history[ply];
    const mover = Chess.parseFen(fenBefore).turn;
    $('verifyBox').hidden = false;
    $('verifyResult').textContent = 'Analysing…';
    $('saveCard').disabled = true;

    analyse(fenBefore).then(function (best) {
      // The played move's value = the value of the position it leads to.
      // If that position is terminal the engine has nothing to search.
      const afterFen = r.fens[ply + 1];
      const afterState = Chess.parseFen(afterFen);
      afterState.positions = {};
      const st = Chess.gameStatus(afterState);
      const playedScoreP = st.over
        ? Promise.resolve({ score: st.result === '1-0' ? MATE_ISH + 99 : st.result === '0-1' ? -(MATE_ISH + 99) : 0 })
        : analyse(afterFen);
      return playedScoreP.then(function (after) {
        // Resolve the engine's move object back to a SAN on this board.
        const legal = Chess.legalMoves(Chess.parseFen(fenBefore));
        const bm = best.move && legal.find(function (m) {
          return m.from === best.move.from && m.to === best.move.to &&
                 (m.promotion || null) === (best.move.promotion || null);
        });
        const bestSan = bm ? Chess.toSan(Chess.parseFen(fenBefore), bm, legal) : '?';
        const same = bm && entry.move.from === bm.from && entry.move.to === bm.to &&
          (entry.move.promotion || null) === (bm.promotion || null);
        // Playing the engine's own move costs nothing by definition — the
        // two probes can still differ (depth parity, terminal shortcuts).
        const lossCp = same ? 0 : Math.max(0,
          Math.round((best.score - after.score) * (mover === 'w' ? 1 : -1)));
        review.verdict = {
          ply: ply, fenBefore: fenBefore, playedSan: entry.san,
          bestSan: bestSan,
          bestMove: bm ? { from: bm.from, to: bm.to, promotion: bm.promotion || null } : null,
          bestScore: best.score, playedScore: after.score, lossCp: lossCp,
          depth: best.depth
        };
        $('verifyResult').textContent = same
          ? 'You played ' + entry.san + ' — the engine agrees (eval ' +
            fmtScore(best.score) + ', depth ' + best.depth + ').'
          : 'You played ' + entry.san + ' (position eval ' + fmtScore(after.score) +
            ') — engine best is ' + bestSan + ' (eval ' + fmtScore(best.score) +
            ', depth ' + best.depth + '). Cost ≈ ' + (lossCp / 100).toFixed(1) +
            ' pawns: ' + lossLabel(lossCp) + '.';
        $('saveCard').disabled = false;
      });
    });
  });

  $('saveCard').addEventListener('click', function () {
    const v = review.verdict;
    if (!v) return;
    const now = Date.now();
    CoachStore.addCard({
      gameId: review.game.id,
      ply: v.ply,
      fenBefore: v.fenBefore,
      playedSan: v.playedSan,
      bestSan: v.bestSan,
      bestMove: v.bestMove,
      bestScore: v.bestScore,
      playedScore: v.playedScore,
      lossCp: v.lossCp,
      cause: $('cardCause').value,
      lesson: $('cardLesson').value.trim(),
      reflection: {
        threat: $('reflectThreat').value.trim(),
        candidates: $('reflectCandidates').value.trim(),
        evaluation: $('reflectEval').value
      },
      createdAt: now,
      due: now,        // first review is immediate (the "learn" step)
      step: -1,        // -1 = not yet on the day ladder
      attempts: []
    }).then(function () {
      $('saveCard').disabled = true;
      $('cardSaved').hidden = false;
      $('cardSaved').textContent = 'Lesson card saved — it is due in Train now, then on the 1/3/7/14/30/90-day ladder.';
    });
  });

  // ---- Import PGN ----
  $('importPgnBtn').addEventListener('click', function () {
    $('importText').value = '';
    $('importError').textContent = '';
    $('importDialog').showModal();
  });
  $('importCancel').addEventListener('click', function () { $('importDialog').close(); });

  $('importStart').addEventListener('click', function () {
    const games = Chess.parsePgn($('importText').value);
    let ok = 0, failed = 0, firstError = null;
    let chain = Promise.resolve();
    for (const g of games) {
      if (g.sans.length === 0) continue;
      chain = chain.then(function () {
        if (g.unsupported) throw new Error('games from a set-up position are not supported');
        const gs = Chess.replaySans(g.sans); // throws on illegal moves
        const status = Chess.gameStatus(gs);
        return CoachStore.addGame({
          source: 'import',
          tags: g.tags,
          sans: gs.history.map(function (h) { return h.san; }), // canonical SANs
          result: status.over ? status.result : g.result,
          reason: status.over ? status.reason : '',
          mode: null, difficulty: null, timeControl: (g.tags && g.tags.TimeControl) || null,
          plies: gs.history.length,
          createdAt: Date.now()
        }).then(function () { ok++; });
      }).catch(function (e) {
        failed++;
        if (!firstError) firstError = e.message || String(e);
      });
    }
    chain.then(function () {
      if (ok === 0 && failed === 0) {
        $('importError').textContent = 'No games found in that text.';
        return;
      }
      if (failed > 0 && ok === 0) {
        $('importError').textContent = 'Import failed: ' + firstError;
        return;
      }
      if (failed > 0) {
        $('importError').textContent = ok + ' imported, ' + failed + ' skipped (' + firstError + ').';
        renderGameList();
        return;
      }
      $('importDialog').close();
      renderGameList();
    });
  });

  // ---- Train ----
  const trainBoard = makeBoard($('trainBoard'), onTrainSquare);
  let train = null; // { queue, card, state, selected, answered }

  function loadTrain() {
    CoachStore.dueCards(Date.now()).then(function (cards) {
      train = { queue: cards, card: null, state: null, selected: null, answered: false };
      nextTrainCard();
    }).catch(function () {
      $('trainEmpty').hidden = false;
      $('trainEmpty').textContent = 'Archive unavailable in this browser.';
      $('trainCardBox').hidden = true;
    });
  }

  function nextTrainCard() {
    const t = train;
    t.card = t.queue.shift() || null;
    t.selected = null;
    t.answered = false;
    $('trainCount').textContent = t.card
      ? (t.queue.length + 1) + ' due'
      : '';
    $('trainEmpty').hidden = !!t.card;
    $('trainCardBox').hidden = !t.card;
    $('trainReveal').hidden = true;
    if (!t.card) return;
    t.state = Chess.parseFen(t.card.fenBefore);
    trainBoard.render(t.state, {});
    $('trainPrompt').textContent =
      (t.state.turn === 'w' ? 'White' : 'Black') +
      ' to move — find the best move. (You played ' + t.card.playedSan + ' in the game.)';
  }

  function onTrainSquare(i) {
    const t = train;
    if (!t || !t.card || t.answered) return;
    const p = t.state.board[i];
    if (t.selected === null || (p && p[0] === t.state.turn)) {
      if (p && p[0] === t.state.turn) {
        t.selected = i;
        trainBoard.render(t.state, { selected: i, targets: Chess.legalMovesFrom(t.state, i) });
      }
      return;
    }
    const candidates = Chess.legalMovesFrom(t.state, t.selected)
      .filter(function (m) { return m.to === i; });
    if (candidates.length === 0) {
      t.selected = null;
      trainBoard.render(t.state, {});
      return;
    }
    // Promotions answer as a queen (a card's best move records its piece).
    const attempt = candidates.find(function (m) { return !m.promotion || m.promotion === 'Q'; }) || candidates[0];
    answerTrain(attempt);
  }

  function answerTrain(attempt) {
    const t = train;
    const best = t.card.bestMove;
    const correct = !!best && attempt.from === best.from && attempt.to === best.to &&
      (attempt.promotion || null) === (best.promotion || null);
    t.answered = true;
    const attemptSan = Chess.toSan(t.state, attempt);
    trainBoard.render(Chess.applyMove(t.state, attempt), { lastMove: attempt });
    $('trainReveal').hidden = false;
    $('trainOutcome').textContent = correct
      ? '✓ ' + attemptSan + ' — that is the engine move.'
      : '✗ You answered ' + attemptSan + '; the engine move was ' + t.card.bestSan +
        ' (in the game you played ' + t.card.playedSan + ').';
    $('trainLesson').textContent =
      (t.card.lesson ? 'Lesson: ' + t.card.lesson + ' · ' : '') +
      'Cause: ' + (CAUSE_LABELS[t.card.cause] || t.card.cause);
    t.lastCorrect = correct;
  }

  // Fixed ladder scheduling. Good climbs, Hard repeats the current rung,
  // Again drops off the ladder and retries later today.
  function schedule(card, grade, now) {
    if (grade === 'again') {
      card.step = -1;
      card.due = now + AGAIN_DELAY;
    } else if (grade === 'hard') {
      card.step = Math.max(card.step, 0);
      card.due = now + LADDER_DAYS[Math.min(card.step, LADDER_DAYS.length - 1)] * DAY;
    } else {
      card.step = Math.min(card.step + 1, LADDER_DAYS.length - 1);
      card.due = now + LADDER_DAYS[card.step] * DAY;
    }
  }

  function grade(g) {
    const t = train;
    if (!t || !t.card || !t.answered) return;
    const now = Date.now();
    t.card.attempts.push({ at: now, grade: g, correct: !!t.lastCorrect });
    schedule(t.card, g, now);
    CoachStore.updateCard(t.card).then(nextTrainCard);
  }

  $('gradeAgain').addEventListener('click', function () { grade('again'); });
  $('gradeHard').addEventListener('click', function () { grade('hard'); });
  $('gradeGood').addEventListener('click', function () { grade('good'); });

  // ---- Progress ----
  function stat(dl, label, value) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function renderProgress() {
    Promise.all([CoachStore.listGames(), CoachStore.listCards()]).then(function (r) {
      const games = r[0], cards = r[1];
      const now = Date.now();
      const dl = $('progressStats');
      dl.innerHTML = '';
      stat(dl, 'Games archived', games.length);
      stat(dl, 'Lesson cards', cards.length);
      stat(dl, 'Cards due now', cards.filter(function (c) { return c.due <= now; }).length);
      const recent = [];
      for (const c of cards) {
        for (const a of c.attempts || []) if (now - a.at <= 30 * DAY) recent.push(a);
      }
      stat(dl, 'Reviews (30 days)', recent.length);
      stat(dl, 'Correct on first try (30 days)',
        recent.length ? recent.filter(function (a) { return a.correct; }).length + '/' + recent.length : '—');
      const causes = $('causeStats');
      causes.innerHTML = '';
      const byCause = {};
      for (const c of cards) byCause[c.cause] = (byCause[c.cause] || 0) + 1;
      const keys = Object.keys(byCause);
      if (keys.length === 0) stat(causes, 'No lesson cards yet', '—');
      for (const k of keys) stat(causes, CAUSE_LABELS[k] || k, byCause[k]);
    }).catch(function () {
      $('dataNote').textContent = 'Archive unavailable in this browser.';
    });
  }

  // ---- Data controls ----
  $('exportData').addEventListener('click', function () {
    CoachStore.exportAll().then(function (data) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      const d = new Date();
      a.download = 'chessy-coach-' + d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      $('dataNote').textContent = 'Exported ' + data.games.length + ' games and ' + data.cards.length + ' cards.';
    });
  });

  $('importData').addEventListener('click', function () { $('importFile').click(); });
  $('importFile').addEventListener('change', function () {
    const file = $('importFile').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      let data = null;
      try { data = JSON.parse(reader.result); } catch (e) { /* handled below */ }
      Promise.resolve()
        .then(function () { return CoachStore.importAll(data); })
        .then(function (n) {
          $('dataNote').textContent = 'Imported ' + n.games + ' games and ' + n.cards + ' cards.';
          renderProgress();
        })
        .catch(function (e) {
          $('dataNote').textContent = 'Import failed: ' + (e.message || e);
        });
      $('importFile').value = '';
    };
    reader.readAsText(file);
  });

  $('deleteData').addEventListener('click', function () {
    if (!window.confirm('Delete ALL archived games, lesson cards and review history?')) return;
    CoachStore.deleteAll().then(function () {
      $('dataNote').textContent = 'All training data deleted.';
      renderProgress();
    });
  });

  window.Coach = { archiveGame: archiveGame, showView: showView };
})();
