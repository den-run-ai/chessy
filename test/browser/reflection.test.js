/* Manual reflection: flag one position → answer before the engine speaks
 * → ONE bounded probe → player-owned cause → one card per moment. */
'use strict';
require('./helper').run('reflection', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  async function cards() {
    return page.evaluate(function () { return CoachStore.listCards(); });
  }
  async function verifyDone() {
    await page.waitForFunction(function () {
      const el = document.getElementById('verifyResult');
      return el.textContent && el.textContent.indexOf('Analysing') === -1;
    }, null, { timeout: 60000 });
  }

  // Archive a fool's mate and open it in Review.
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview');
  await page.waitForSelector('#viewReview:not([hidden])');
  await page.waitForFunction(function () {
    return document.getElementById('reviewStatus').textContent.indexOf('Position 0/') !== -1;
  });

  // The end position has no played move to flag.
  await page.click('#revEnd');
  check(await page.locator('#flagMoment').isDisabled(), 'cannot flag the end position');
  await page.click('#revPrev'); // ply 3: Qh4# was played here

  // Reflection gates the engine.
  await page.click('#flagMoment');
  check(await page.locator('#reflectForm').isVisible(), 'reflection form opens on flag');
  check(await page.locator('#verifyBox').isHidden(), 'engine output hidden until reflection submitted');
  await page.click('#reflectVerify'); // EMPTY reflection: required fields block
  check(await page.locator('#verifyBox').isHidden(),
    'empty reflection cannot summon the engine (fields are required)');
  await page.fill('#reflectThreat', '   ');
  await page.fill('#reflectCandidates', '  ');
  await page.selectOption('#reflectEval', 'winning');
  await page.click('#reflectVerify');
  check(await page.locator('#verifyBox').isHidden(),
    'whitespace-only reflection is rejected (trimmed before validation)');

  // One probe; the played mate IS Chessy's move.
  await page.fill('#reflectThreat', 'mate on h4');
  await page.fill('#reflectCandidates', 'Qh4');
  await page.click('#reflectVerify');
  check(await page.locator('#reflectVerify').isDisabled(), 'one probe at a time');
  await verifyDone();
  check((await page.textContent('#verifyResult')).includes('top line'),
    'a matching move is reported as Chessy’s top line (not an error)');
  // Ply 3 is a BLACK decision (…Qh4#): the eval is labelled from Black's
  // perspective, so a bare White-POV number can't be misread. Black delivers
  // mate here, which reads as a win FOR BLACK.
  check((await page.textContent('#verifyResult')).includes('for Black') &&
        (await page.textContent('#verifyResult')).includes('+M'),
    'a Black decision shows the eval from Black’s perspective (+M for Black)');
  check(await page.locator('#causeLabel').isHidden(),
    'no cause asked when the move matches');
  check(!(await page.locator('#reflectVerify').isDisabled()), 'probe button re-enables');
  // Review v2: Chessy shows a few candidate lines (not one verdict), the top
  // line is the played mate, and it is marked as the player's move.
  check(await page.locator('#verifyLines li').count() >= 1,
    'candidate lines are listed (MultiPV, not a single line)');
  check((await page.textContent('#verifyLines')).includes('Qh4') &&
        (await page.locator('#verifyLines li.played').count()) >= 1,
    'the played move appears in the lines and is marked as yours');
  // Provenance is shown (engine version, depth, node count) and — since these
  // budgets complete — the meta is NOT flagged partial.
  const meta = await page.textContent('#verifyMeta');
  check(meta.includes('Chessy v') && meta.includes('depth') && meta.includes('nodes'),
    'provenance (engine version, depth, nodes) is shown with the lines');
  check(!(await page.locator('#verifyMeta.partial').count()),
    'a completed analysis is not flagged partial');

  // Lesson required; the reflection snapshot survives a post-verdict edit.
  await page.click('#saveCard');
  await page.waitForSelector('#cardSaved:not([hidden])');
  check((await page.textContent('#cardSaved')).includes('lesson'),
    'saving requires a one-sentence lesson');
  await page.fill('#reflectThreat', 'rewritten after seeing the verdict');
  await page.fill('#cardLesson', 'Look for forcing mates first');
  await page.evaluate(function () {
    document.getElementById('saveCard').click();
    document.getElementById('saveCard').click();
  });
  await page.waitForFunction(function () {
    return document.getElementById('cardSaved').textContent.indexOf('Lesson card saved') !== -1;
  });
  const saved = await cards();
  check(saved.length === 1, 'double-clicking Save creates exactly one card');
  check(saved[0].kind === 'match' && saved[0].cause === 'match' &&
        saved[0].step === -1 && saved[0].due <= Date.now() &&
        saved[0].reflection.threat === 'mate on h4' && !!saved[0].bestMove,
    'card stores the PRE-verdict reflection snapshot, verdict and immediate due');

  // Re-saving the SAME moment updates its one card — no duplicates.
  await page.fill('#reflectThreat', 'mate on h4, second look');
  await page.fill('#reflectCandidates', 'Qh4');
  await page.selectOption('#reflectEval', 'winning');
  await page.click('#reflectVerify');
  await verifyDone();
  await page.fill('#cardLesson', 'Revised: forcing mates first, always');
  await page.click('#saveCard');
  await page.waitForFunction(function () {
    return document.getElementById('cardSaved').textContent.indexOf('Updated') !== -1;
  });
  const resaved = await cards();
  check(resaved.length === 1 && resaved[0].lesson === 'Revised: forcing mates first, always' &&
        resaved[0].reflection.threat === 'mate on h4, second look',
    're-saving the same moment updates its one card');

  // A NEW probe hides the stale save notice: "Updated…" must not imply
  // freshly edited answers are persisted while a new verdict is pending.
  await page.click('#reflectVerify');
  check(await page.locator('#cardSaved').isHidden(),
    'starting a new probe clears the previous save notice');
  await verifyDone();

  // A PARTIAL (node-budget-capped) analysis stays spoiler-gated and is shown
  // as visibly partial — never dressed up as an exhaustive verdict. Stub the
  // service to return a valid contract with complete:false, then confirm the
  // engine output is still hidden until the reflection is submitted, and the
  // provenance line is flagged partial afterwards. (No-worker / wedged / retry
  // and the off-main-thread guarantee are covered by analysis-service.test.js.)
  const partialGated = await page.evaluate(function () {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const state = Chess.parseFen(fen);
    // Include the ACTUAL played move (f3) so playedLine is populated: a partial
    // scan must NOT report its rank as exact.
    const played = { from: Chess.sqIndex('f2'), to: Chess.sqIndex('f3'), promotion: null };
    const full = ChessyAnalysisCore.analyse(state,
      { maxDepth: 4, multiPV: 3, nodeLimit: 8000, playedMove: played });
    full.complete = false; // pretend the node budget was reached
    window.__realSvc = ChessyAnalysisService.analyse;
    ChessyAnalysisService.analyse = function () { return Promise.resolve(full); };
    return true;
  });
  check(partialGated, 'partial-analysis stub installed');
  await page.click('#revStart'); // ply 0
  await page.click('#flagMoment');
  check(await page.locator('#verifyBox').isHidden(),
    'a partial result is still spoiler-gated: nothing shown before the reflection');
  await page.fill('#reflectThreat', 'testing partial');
  await page.fill('#reflectCandidates', 'e4');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check((await page.locator('#verifyMeta.partial').count()) >= 1,
    'a complete:false analysis is rendered visibly partial');
  // Accessibility: the partial qualifier is in the element's TEXT, not only a
  // CSS ::after that screen readers may not expose.
  check((await page.textContent('#verifyMeta')).toLowerCase().includes('partial'),
    'the partial warning is real text content (screen-reader accessible)');
  // A partial scan must not present an EXACT rank: the summary says "provisional"
  // and the lines use bullets, never "#n" that unsearched moves could displace.
  check((await page.textContent('#verifyResult')).includes('provisional') &&
        !(await page.textContent('#verifyLines')).includes('#'),
    'a partial analysis withholds exact ranks (provisional standing, bulleted lines)');
  // A partial verdict cannot found a card: Save stays disabled and even a
  // forced click creates nothing (Train must never drill an incomplete scan).
  const cardsBeforePartial = (await cards()).length;
  check(await page.locator('#saveCard').isDisabled(),
    'a partial analysis leaves Save disabled');
  await page.evaluate(function () { document.getElementById('saveCard').click(); });
  check((await cards()).length === cardsBeforePartial,
    'a partial analysis founds no lesson card');
  await page.evaluate(function () { ChessyAnalysisService.analyse = window.__realSvc; });
  await page.click('#revEnd'); // step away so the next section starts fresh at ply 0

  // A DIFFERING move: the player owns the call, including "also sound".
  await page.click('#revStart'); // ply 0: f3 was played here
  check(await page.locator('#reflectForm').isHidden(),
    'stepping away abandons the unsaved reflection');
  await page.click('#flagMoment');
  check(await page.evaluate(function () { return document.getElementById('reflectEval').value; }) === '',
    'flagging a new moment clears the previous answers');
  await page.fill('#reflectThreat', 'nothing concrete');
  await page.fill('#reflectCandidates', 'e4, d4');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check((await page.textContent('#verifyResult')).includes('preferred') &&
        (await page.textContent('#verifyResult')).includes('not necessarily an error'),
    'a differing move is not declared an error');
  // Ply 0 (f3) is a WHITE decision: the eval is labelled from White's side.
  check((await page.textContent('#verifyResult')).includes('for White'),
    'a White decision shows the eval from White’s perspective');
  // The played move's standing is always reported, and its line is shown even
  // when it ranked below the top MultiPV lines (appended with its true rank).
  check((await page.textContent('#verifyResult')).includes('your move') &&
        (await page.textContent('#verifyLines')).includes('f3'),
    'the played move is ranked in the summary and shown in the lines (even outside the top MultiPV)');
  check(!(await page.locator('#causeLabel').isHidden()), 'cause picker shown for a differing move');
  await page.fill('#cardLesson', 'Do not weaken the king for nothing');
  await page.click('#saveCard');
  await page.waitForSelector('#cardSaved:not([hidden])');
  check((await page.textContent('#cardSaved')).includes('cause'),
    'differing moves require the player’s cause call');
  await page.selectOption('#cardCause', 'sound-alternative');
  await page.click('#saveCard');
  await page.waitForFunction(function () {
    return document.getElementById('cardSaved').textContent.indexOf('Lesson card saved') !== -1;
  });
  const both = await cards();
  check(both.length === 2 && both.some(function (c) { return c.cause === 'sound-alternative'; }),
    '"my move was also sound" is a first-class cause (2 cards total)');

  // An ILLEGAL/unusable analysis must NOT be turned into a card: a top line
  // whose move matches nothing on the board leaves Save disabled and asks the
  // player to Verify again.
  await page.evaluate(function () {
    window.__realAnalyse = ChessyAnalysisService.analyse;
    ChessyAnalysisService.analyse = function () {
      return Promise.resolve({
        turn: 'w', engine: { id: 'chessy', version: 'x', configHash: 'x' },
        depth: 5, nodes: 1, elapsedMs: 1, complete: true,
        scoreCpWhite: 40, scoreCpPlayer: 40, mate: null, classification: 'unknown-equivalence',
        playedLine: null, stability: null,
        bestLines: [{ move: { from: -1, to: -1, promotion: null }, uci: '??', san: '?',
          scoreCpWhite: 40, scoreCpPlayer: 40, mate: null, pv: ['?'], pvUci: [] }]
      });
    };
  });
  await page.click('#flagMoment'); // re-flag ply 0
  await page.fill('#reflectThreat', 'analysis returns garbage');
  await page.fill('#reflectCandidates', 'e4');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check((await page.textContent('#verifyResult')).includes('could not analyse'),
    'an illegal top-line move is reported, not scored');
  check(await page.locator('#saveCard').isDisabled(),
    'an illegal analysis keeps Save disabled (no card can be founded on it)');
  // Even a click that bypasses the disabled attribute cannot force a card:
  // the handler re-checks disabled and the null verdict.
  await page.evaluate(function () { document.getElementById('saveCard').click(); });
  check((await cards()).length === 2, 'an illegal engine result creates no card');

  // A LEGAL top move but an unusable evaluation (no mate, non-finite score)
  // must also be rejected — never rendered as "+0.0" or persisted into a card.
  await page.evaluate(function () {
    ChessyAnalysisService.analyse = function () {
      const legal = Chess.legalMoves(Chess.parseFen(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'))[0];
      return Promise.resolve({
        turn: 'w', engine: { id: 'chessy', version: 'x', configHash: 'x' },
        depth: 5, nodes: 1, elapsedMs: 1, complete: true,
        scoreCpWhite: null, scoreCpPlayer: null, mate: null, classification: 'unknown-equivalence',
        playedLine: null, stability: null,
        bestLines: [{ move: { from: legal.from, to: legal.to, promotion: legal.promotion || null },
          uci: 'x', san: '?', scoreCpWhite: null, scoreCpPlayer: null, mate: null, pv: ['?'], pvUci: [] }]
      });
    };
  });
  await page.click('#flagMoment'); // re-flag ply 0
  await page.fill('#reflectThreat', 'legal move, no eval');
  await page.fill('#reflectCandidates', 'e4');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check((await page.textContent('#verifyResult')).includes('could not analyse') &&
        await page.locator('#saveCard').isDisabled(),
    'a legal move with an invalid evaluation is rejected, not shown as +0.0 or saved');
  check((await cards()).length === 2, 'an invalid-evaluation result creates no card');
  await page.evaluate(function () { ChessyAnalysisService.analyse = window.__realAnalyse; });

  // A malformed MATE payload (truthy but no finite distance) is NOT a mate: it
  // must be rejected, never rendered as "+Mundefined"/"−MNaN" or saved.
  await page.evaluate(function () {
    window.__realAnalyse2 = ChessyAnalysisService.analyse;
    ChessyAnalysisService.analyse = function () {
      const legal = Chess.legalMoves(Chess.parseFen(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'))[0];
      const bad = { forWhite: false, inPlies: NaN };
      return Promise.resolve({
        turn: 'w', engine: { id: 'chessy', version: 'x', configHash: 'x' },
        depth: 5, nodes: 1, elapsedMs: 1, complete: true,
        scoreCpWhite: null, scoreCpPlayer: null, mate: bad,
        classification: 'unknown-equivalence', playedLine: null, stability: null,
        bestLines: [{ move: { from: legal.from, to: legal.to, promotion: legal.promotion || null },
          uci: 'x', san: '?', scoreCpWhite: null, scoreCpPlayer: null, mate: bad, pv: ['?'], pvUci: [] }]
      });
    };
  });
  await page.click('#flagMoment');
  await page.fill('#reflectThreat', 'malformed mate');
  await page.fill('#reflectCandidates', 'e4');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check((await page.textContent('#verifyResult')).includes('could not analyse') &&
        await page.locator('#saveCard').isDisabled(),
    'a malformed mate payload is rejected (no +Mundefined, no card)');
  await page.evaluate(function () { ChessyAnalysisService.analyse = window.__realAnalyse2; });

  // A partial (complete:false) result whose played move merely LEADS the
  // searched prefix must not be presented as Chessy's settled "top line".
  await page.evaluate(function () {
    window.__realAnalyse3 = ChessyAnalysisService.analyse;
    ChessyAnalysisService.analyse = function () {
      const legal = Chess.legalMoves(Chess.parseFen(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'))[0];
      const line = { move: { from: legal.from, to: legal.to, promotion: legal.promotion || null },
        uci: 'lead', san: 'e4', scoreCpWhite: 20, scoreCpPlayer: 20, mate: null, pv: ['e4'], pvUci: [] };
      return Promise.resolve({
        turn: 'w', engine: { id: 'chessy', version: 'x', configHash: 'x' },
        depth: 3, nodes: 1, elapsedMs: 1, complete: false,
        scoreCpWhite: 20, scoreCpPlayer: 20, mate: null, classification: 'same',
        playedLine: Object.assign({ rank: 1, amongCandidates: true }, line), stability: null,
        bestLines: [line]
      });
    };
  });
  await page.click('#flagMoment');
  await page.fill('#reflectThreat', 'partial match');
  await page.fill('#reflectCandidates', 'e4');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check((await page.textContent('#verifyResult')).includes('so far') &&
        (await page.textContent('#verifyResult')).includes('incomplete') &&
        await page.locator('#saveCard').isDisabled(),
    'a partial top-line claim is qualified as provisional (leads the search so far), not settled');
  await page.evaluate(function () { ChessyAnalysisService.analyse = window.__realAnalyse3; });

  // cardScore must use validMate too: a malformed mate WITH a finite score is
  // still usable (centipawn fallback) and must persist the score, not NaN.
  await page.click('#revNext'); await page.click('#revNext'); // from ply 0 → ply 2 (g4)
  await page.evaluate(function () {
    window.__realAnalyse4 = ChessyAnalysisService.analyse;
    ChessyAnalysisService.analyse = function (req) {
      const pos = Chess.parseFen(req.fen);
      const lm = Chess.legalMoves(pos)[0];
      const line = { move: { from: lm.from, to: lm.to, promotion: lm.promotion || null },
        uci: 'x', san: 'x', scoreCpWhite: 20, scoreCpPlayer: 20, mate: {}, pv: ['x'], pvUci: [] };
      return Promise.resolve({
        turn: pos.turn, engine: { id: 'chessy', version: 'x', configHash: 'x' },
        depth: 5, nodes: 1, elapsedMs: 1, complete: true,
        scoreCpWhite: 20, scoreCpPlayer: 20, mate: {}, classification: 'same',
        playedLine: Object.assign({ rank: 1, amongCandidates: true }, line), stability: null,
        bestLines: [line]
      });
    };
  });
  await page.click('#flagMoment');
  await page.fill('#reflectThreat', 'malformed mate but finite score');
  await page.fill('#reflectCandidates', 'g4');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check(!(await page.locator('#saveCard').isDisabled()),
    'a malformed mate with a finite score is still usable (centipawn fallback)');
  await page.fill('#cardLesson', 'score fallback test');
  await page.click('#saveCard');
  await page.waitForFunction(function () {
    return document.getElementById('cardSaved').textContent.indexOf('saved') !== -1;
  });
  const scoreCard = (await cards()).find(function (c) { return c.ply === 2 && c.lesson === 'score fallback test'; });
  check(scoreCard && scoreCard.bestScore === 20,
    'cardScore uses validMate: a malformed mate persists the finite score, not NaN');
  await page.evaluate(function () { ChessyAnalysisService.analyse = window.__realAnalyse4; });

  // A partial result that never scored the played move (playedLine null) must
  // NOT claim Chessy "preferred" the top line — there is no head-to-head.
  await page.evaluate(function () {
    window.__realAnalyse5 = ChessyAnalysisService.analyse;
    ChessyAnalysisService.analyse = function (req) {
      const pos = Chess.parseFen(req.fen);
      const lm = Chess.legalMoves(pos)[0];
      const line = { move: { from: lm.from, to: lm.to, promotion: lm.promotion || null },
        uci: 'x', san: 'x', scoreCpWhite: 15, scoreCpPlayer: 15, mate: null, pv: ['x'], pvUci: [] };
      return Promise.resolve({
        turn: pos.turn, engine: { id: 'chessy', version: 'x', configHash: 'x' },
        depth: 3, nodes: 1, elapsedMs: 1, complete: false,
        scoreCpWhite: 15, scoreCpPlayer: 15, mate: null, classification: 'unknown-equivalence',
        playedLine: null, stability: null, bestLines: [line]
      });
    };
  });
  await page.click('#flagMoment');
  await page.fill('#reflectThreat', 'partial, move not reached');
  await page.fill('#reflectCandidates', 'x');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check(!(await page.textContent('#verifyResult')).includes('preferred') &&
        (await page.textContent('#verifyResult')).includes('not reached') &&
        await page.locator('#saveCard').isDisabled(),
    'a partial analysis that never scored the played move makes no head-to-head claim');
  await page.evaluate(function () { ChessyAnalysisService.analyse = window.__realAnalyse5; });

  // A null result for the CURRENT request (no worker / wedged) must not leave a
  // stuck "Analysing…": show a retryable failure and keep Save disabled.
  await page.evaluate(function () {
    window.__realAnalyse6 = ChessyAnalysisService.analyse;
    ChessyAnalysisService.analyse = function () { return Promise.resolve(null); };
  });
  await page.click('#flagMoment');
  await page.fill('#reflectThreat', 'null result');
  await page.fill('#reflectCandidates', 'x');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check((await page.textContent('#verifyResult')).includes('could not complete') &&
        !(await page.textContent('#verifyResult')).includes('Analysing') &&
        await page.locator('#saveCard').isDisabled(),
    'a null analysis shows a retryable failure, not a stuck “Analysing…”');
  await page.evaluate(function () { ChessyAnalysisService.analyse = window.__realAnalyse6; });

  // A result with a legal top move and a valid score but GARBLED provenance
  // (no engine, non-numeric nodes/depth) is rejected — never shown as
  // "vundefined · depth undefined · undefined nodes" or saved.
  await page.evaluate(function () {
    window.__realAnalyse7 = ChessyAnalysisService.analyse;
    ChessyAnalysisService.analyse = function (req) {
      const lm = Chess.legalMoves(Chess.parseFen(req.fen))[0];
      return Promise.resolve({
        turn: 'w', engine: null, depth: null, nodes: 'lots', elapsedMs: 1, complete: true,
        scoreCpWhite: 20, scoreCpPlayer: 20, mate: null, classification: 'unknown-equivalence',
        playedLine: null, stability: null,
        bestLines: [{ move: { from: lm.from, to: lm.to, promotion: lm.promotion || null },
          uci: 'x', san: 'x', scoreCpWhite: 20, scoreCpPlayer: 20, mate: null, pv: ['x'], pvUci: [] }]
      });
    };
  });
  await page.click('#flagMoment');
  await page.fill('#reflectThreat', 'bad provenance');
  await page.fill('#reflectCandidates', 'x');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check((await page.textContent('#verifyResult')).includes('could not analyse') &&
        await page.locator('#saveCard').isDisabled(),
    'a result with garbled provenance is rejected (no vundefined / undefined nodes)');
  await page.evaluate(function () { ChessyAnalysisService.analyse = window.__realAnalyse7; });

  // A garbled cached line with a non-array pv must NOT throw while rendering
  // (which would hang on "Analysing…"): it renders as an empty continuation.
  await page.evaluate(function () {
    window.__realAnalyse8 = ChessyAnalysisService.analyse;
    ChessyAnalysisService.analyse = function (req) {
      const lm = Chess.legalMoves(Chess.parseFen(req.fen))[0];
      return Promise.resolve({
        turn: 'w', engine: { id: 'chessy', version: '1.0.0', configHash: 'x' },
        depth: 5, nodes: 100, elapsedMs: 1, complete: true,
        scoreCpWhite: 20, scoreCpPlayer: 20, mate: null, classification: 'different-candidate',
        playedLine: null, stability: null,
        bestLines: [{ move: { from: lm.from, to: lm.to, promotion: lm.promotion || null },
          uci: 'x', san: 'e4', scoreCpWhite: 20, scoreCpPlayer: 20, mate: null, pv: null, pvUci: null }]
      });
    };
  });
  await page.click('#flagMoment');
  await page.fill('#reflectThreat', 'malformed pv');
  await page.fill('#reflectCandidates', 'x');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check((await page.locator('#verifyLines li').count()) >= 1 &&
        !(await page.textContent('#verifyResult')).includes('could not'),
    'a malformed candidate pv renders as an empty continuation (no throw / hang)');
  await page.evaluate(function () { ChessyAnalysisService.analyse = window.__realAnalyse8; });

  // Abandoning a probe: leave the game while it runs — the verdict must
  // not land, and Save must stay disabled for the next moment.
  await page.click('#flagMoment'); // re-flag ply 0
  await page.fill('#reflectThreat', 'x');
  await page.fill('#reflectCandidates', 'y');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await page.click('#reviewBack'); // abandon mid-probe
  await page.waitForTimeout(2500);
  await page.locator('.game-item').first().click();
  await page.click('#flagMoment'); // fresh moment, ply 0
  check(await page.locator('#verifyBox').isHidden(),
    'an abandoned probe repaints nothing on the freshly flagged moment');
  await page.fill('#reflectThreat', 'still nothing');
  await page.fill('#reflectCandidates', 'e4');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check(!(await page.locator('#saveCard').isDisabled()),
    'a fresh probe after the abandoned one works normally');

  // Reflection is about YOUR decisions: in a vs-computer game only the
  // human's moves are flaggable.
  await page.evaluate(function () {
    return CoachStore.putGame({ id: 'ai-game-flag-test', source: 'play', tags: {},
      sans: ['f3', 'e5', 'g4', 'Qh4#'], playerColor: 'w',
      clocks: [null, null, null, null], result: '0-1', reason: 'checkmate',
      mode: 'ai-b', difficulty: '1', timeControl: 'none', plies: 4,
      createdAt: Date.now() + 60000 }); // newest → first list item
  });
  await page.click('#reviewBack');
  await page.waitForSelector('.game-item');
  await page.locator('.game-item').first().click();
  await page.waitForFunction(function () {
    return document.getElementById('reviewStatus').textContent.indexOf('Position 0/4') !== -1;
  });
  check(!(await page.locator('#flagMoment').isDisabled()),
    'your own move (White to move) is flaggable in a vs-computer game');
  await page.click('#revNext'); // ply 1: the computer's reply was played here
  check(await page.locator('#flagMoment').isDisabled(),
    "the computer's move is not flaggable");

  // Leaving Review for Play abandons the reflection completely.
  await page.click('#revPrev'); // ply 0 again — flaggable
  await page.click('#flagMoment');
  check(await page.locator('#reflectForm').isVisible(), 'reflection open before leaving Review');
  await page.click('#tabPlay');
  await page.click('#tabReview');
  await page.waitForSelector('.game-item');
  await page.locator('.game-item').first().click();
  check(await page.locator('#reflectForm').isHidden(),
    'leaving Review abandons the reflection (form closed on return)');

  // The one-card-per-moment rule holds even for RACING saves (two tabs):
  // the store's upsert does its lookup and write in one transaction.
  const raceCount = await page.evaluate(function () {
    const fields = { gameId: 'race-game', ply: 3, lesson: 'race' };
    return Promise.all([
      CoachStore.upsertCardByMoment(fields, { createdAt: 1, attempts: [] }),
      CoachStore.upsertCardByMoment(fields, { createdAt: 1, attempts: [] })
    ]).then(function () { return CoachStore.listCards(); })
      .then(function (all) {
        return all.filter(function (c) { return c.gameId === 'race-game'; }).length;
      });
  });
  check(raceCount === 1, 'two racing saves for one moment yield one card (atomic upsert)');

  // Attempt history is graded AGAINST the card's canonical move: a
  // re-save that changes that move must reset the history (Progress would
  // otherwise read old correct/incorrect flags against the new move),
  // while a re-save keeping the move preserves it.
  const history = await page.evaluate(function () {
    const moment = { gameId: 'attempt-reset', ply: 2 };
    const withBest = function (from, to, extra) {
      return Object.assign({ bestMove: { from: from, to: to, promotion: null } },
        moment, extra || {});
    };
    return CoachStore.upsertCardByMoment(withBest(0, 8), { createdAt: 1, attempts: [] })
      .then(function () {
        return CoachStore.listCards().then(function (all) {
          const card = all.find(function (c) { return c.gameId === 'attempt-reset'; });
          card.attempts = [{ at: 1, grade: 'good', correct: true }];
          return CoachStore.updateCard(card);
        });
      })
      .then(function () { // same canonical move → history kept
        return CoachStore.upsertCardByMoment(withBest(0, 8, { lesson: 'reworded' }), {});
      })
      .then(function () {
        return CoachStore.listCards().then(function (all) {
          return all.find(function (c) { return c.gameId === 'attempt-reset'; }).attempts.length;
        });
      })
      .then(function (keptCount) { // different canonical move → history reset
        return CoachStore.upsertCardByMoment(withBest(0, 16), {}).then(function () {
          return CoachStore.listCards().then(function (all) {
            return { kept: keptCount,
                     afterChange: all.find(function (c) {
                       return c.gameId === 'attempt-reset';
                     }).attempts.length };
          });
        });
      });
  });
  check(history.kept === 1 && history.afterChange === 0,
    'changing the canonical move resets attempt history; keeping it preserves it');

  // Revising an archived ending IN PLACE (same-tab replay edit) removes
  // the lesson cards flagged on the abandoned continuation — they refer
  // to positions the game no longer contains — while cards on the shared
  // move prefix survive.
  const pruned = await page.evaluate(function () {
    const mk = function (sans) {
      return { id: 'prune-game', source: 'play', tags: {}, sans: sans,
        playerColor: 'both', clocks: sans.map(function () { return null; }),
        result: '1-0', reason: 'checkmate', mode: 'pvp', difficulty: '2',
        timeControl: 'none', plies: sans.length, createdAt: 1, tab: 'T-PRUNE' };
    };
    return CoachStore.archiveGame(mk(['e4', 'e5', 'Nf3', 'Nc6']))
      .then(function () {
        return CoachStore.upsertCardByMoment(
          { gameId: 'prune-game', ply: 1, lesson: 'keep' }, { createdAt: 1, attempts: [] });
      })
      .then(function () {
        return CoachStore.upsertCardByMoment(
          { gameId: 'prune-game', ply: 3, lesson: 'drop' }, { createdAt: 1, attempts: [] });
      })
      .then(function () { // revised ending diverging at ply 2, same tab
        return CoachStore.archiveGame(mk(['e4', 'e5', 'Bc4', 'Bc5']));
      })
      .then(function () { return CoachStore.listCards(); })
      .then(function (all) {
        const mine = all.filter(function (c) { return c.gameId === 'prune-game'; });
        return { count: mine.length, ply: mine.length === 1 ? mine[0].ply : -1 };
      });
  });
  check(pruned.count === 1 && pruned.ply === 1,
    'revising an ending prunes cards beyond the shared prefix (shared-prefix card survives)');
});
