/*
 * Train v2 E4 (#108): an exact completed-scan suggestion may become one
 * conservative, editable lesson draft only after structured reflection and a
 * complete accepted-move comparison. Approval/skip/cap/source ownership use
 * the real IndexedDB store; only engine and scan-ranking boundaries are
 * replaced with deterministic contract-valid fixtures.
 */
'use strict';
require('./helper').run('lesson-proposal', async function (t) {
  const page = t.page, check = t.check;

  async function leaveReview() {
    if (await page.locator('#reviewFlow').isVisible()) {
      await page.click('#reviewBack');
      await page.waitForSelector('#gameListWrap:not([hidden])');
    }
  }

  async function prepareGame(id, mode, createdAt) {
    await page.evaluate(function (input) {
      window.__lessonMode = input.mode;
      return CoachStore.putGame({
        id: input.id,
        source: 'import',
        tags: {},
        sans: ['f3', 'e5', 'g4', 'Qh4#'],
        playerColor: 'w',
        clocks: [
          { thinkMs: 1000, wMs: 59000, bMs: 60000 },
          { thinkMs: 1200, wMs: 59000, bMs: 58800 },
          { thinkMs: 900, wMs: 58100, bMs: 58800 },
          { thinkMs: 1100, wMs: 58100, bMs: 57700 }
        ],
        result: '0-1',
        reason: 'checkmate',
        mode: 'pvp',
        difficulty: '2',
        timeControl: '1+0',
        plies: 4,
        createdAt: input.createdAt
      });
    }, { id: id, mode: mode, createdAt: createdAt });
    await page.evaluate(function (gameId) {
      return CoachReview.openArchivedGame(gameId);
    }, id);
    await page.waitForFunction(function (gameId) {
      const review = CoachReview.current();
      const progress = document.getElementById('scanProgress');
      const start = document.getElementById('scanStart');
      return review && review.game.id === gameId &&
        progress.textContent === 'Not scanned yet.' &&
        !start.hidden && !start.disabled;
    }, id);
    await page.click('#scanStart');
    await page.waitForFunction(function () {
      return document.getElementById('scanProgress').textContent
        .indexOf('Scan complete') !== -1;
    });
  }

  async function openSuggestion(ordinal) {
    const button = page.locator('#scanMomentList .scan-moment').nth(ordinal);
    await button.click();
    await page.waitForSelector('#reflectForm:not([hidden])');
  }

  async function fillNoCandidatesReflection() {
    await page.selectOption('#reflectThreatKind', 'unclear');
    await page.selectOption('#reflectCandidatesKind', 'none');
    await page.selectOption('#reflectLineKind', 'none');
    await page.selectOption('#reflectEval', 'unclear');
  }

  async function verifyReflection() {
    await page.click('#reflectVerify');
    await page.waitForFunction(function () {
      const result = document.getElementById('verifyResult');
      return result.textContent &&
        result.textContent.indexOf('Analysing') === -1;
    });
  }

  async function cardsFor(gameId) {
    return page.evaluate(function (id) {
      return CoachStore.listCards().then(function (cards) {
        return cards.filter(function (card) { return card.gameId === id; });
      });
    }, gameId);
  }

  // Keep the real controller, claim generation, UI, equivalence policy and
  // IndexedDB transactions. The scan fixtures intentionally contain a private
  // sentinel; the validator wrapper admits it only on the batch boundary.
  await page.evaluate(function () {
    window.__lessonCalls = [];
    window.__lessonMode = 'error';
    window.__lessonRealValidate = ChessyAnalysisResult.validate;

    function sameMove(a, b) {
      return !!a && !!b && a.from === b.from && a.to === b.to &&
        (a.promotion || null) === (b.promotion || null);
    }

    function uci(move) {
      return Chess.sqName(move.from) + Chess.sqName(move.to) +
        (move.promotion ? move.promotion.toLowerCase() : '');
    }

    function line(state, legal, move, score) {
      const san = Chess.toSan(state, move, legal);
      const moveUci = uci(move);
      return {
        move: {
          from: move.from,
          to: move.to,
          promotion: move.promotion || null
        },
        uci: moveUci,
        san: san,
        scoreCpWhite: score,
        scoreCpPlayer: state.turn === 'w' ? score : -score,
        mate: null,
        pv: [san],
        pvUci: [moveUci]
      };
    }

    window.__lessonResult = function (req, mode) {
      const review = CoachReview.current();
      const state = review.states[req.ply];
      const legal = Chess.legalMoves(state);
      const requested = req.opts.playedMove;
      const played = legal.find(function (move) {
        return sameMove(move, requested);
      });
      const top = legal.find(function (move) {
        return !sameMove(move, played);
      });
      const third = legal.find(function (move) {
        return !sameMove(move, played) && !sameMove(move, top);
      });
      if (!played || !top || !third) {
        throw new Error('lesson fixture needs three legal root moves');
      }

      const playedScore = mode === 'equivalent' ? 80 : 0;
      const lines = [
        line(state, legal, top, 100),
        line(state, legal, played, playedScore),
        line(state, legal, third, -100)
      ];
      const playedLine = JSON.parse(JSON.stringify(lines[1]));
      playedLine.rank = 2;
      playedLine.amongCandidates = true;
      const identity = ChessyAnalysisCore.identity(
        state, Object.assign({}, req.opts, { positions: req.positions }));
      return {
        engine: {
          id: identity.engineId,
          version: identity.version,
          configHash: identity.configHash
        },
        turn: state.turn,
        positionFingerprint: identity.positionFingerprint,
        complete: true,
        depth: 4,
        nodes: 1234,
        elapsedMs: 12,
        scoreCpWhite: lines[0].scoreCpWhite,
        scoreCpPlayer: lines[0].scoreCpPlayer,
        mate: null,
        bestLines: lines,
        playedLine: playedLine,
        classification: 'different-candidate',
        stability: {
          depths: [3, 4],
          bestMoveStable: mode !== 'unresolved'
        }
      };
    };

    ChessyAnalysisService.analyse = function (req, owner) {
      window.__lessonCalls.push({
        owner: owner,
        gameId: req.gameId,
        ply: req.ply
      });
      if (owner === 'moment-scan') {
        return Promise.resolve({
          __lessonScan: true,
          complete: true,
          stability: req.opts.nodeLimit === 80000
            ? { bestMoveStable: true } : null
        });
      }
      return Promise.resolve(window.__lessonResult(req, window.__lessonMode));
    };
    ChessyAnalysisResult.validate = function (result, state, expected) {
      if (result && result.__lessonScan) return { ok: true };
      return window.__lessonRealValidate(result, state, expected);
    };
    ChessyMomentSelector.quickCandidate = function (result, meta) {
      return {
        ply: meta.ply,
        playedSan: meta.playedSan,
        turn: meta.turn,
        score: 999
      };
    };
    ChessyMomentSelector.shortlist = function (candidates) {
      return candidates.slice(0, 2);
    };
    ChessyMomentSelector.acceptDeep = function (quick, result, meta) {
      return { ply: meta.ply, playedSan: meta.playedSan };
    };
  });

  const approvedGame = 'lesson-browser-approved';
  await prepareGame(approvedGame, 'error', 1001);

  const exact = await page.evaluate(async function (gameId) {
    const state = ChessyMomentScan.state();
    const review = CoachReview.current();
    const stored = await CoachStore.getJob(gameId);
    const claim = ChessyMomentScan.claimSuggestion(state.moments[0]);
    window.__lessonFirstClaim = claim;
    const partialPassTwo = JSON.parse(JSON.stringify(state));
    partialPassTwo.state = 'running';
    partialPassTwo.pass = 2;
    partialPassTwo.verifyIndex = 1;
    partialPassTwo.moments = partialPassTwo.moments.slice(0, 1);
    document.dispatchEvent(new CustomEvent('chessy:scanchange', {
      detail: partialPassTwo
    }));
    const partialMomentHidden =
      document.querySelectorAll('#scanMomentList .scan-moment').length === 0 &&
      document.getElementById('scanSuggestions').hidden;
    document.dispatchEvent(new CustomEvent('chessy:scanchange', {
      detail: state
    }));
    const completedMomentsRestored =
      document.querySelectorAll('#scanMomentList .scan-moment').length === 2;
    return {
      state: state,
      storedState: stored && stored.state,
      storedDecisions: stored && stored.proposalDecisions,
      claim: claim,
      partialMomentHidden: partialMomentHidden,
      completedMomentsRestored: completedMomentsRestored,
      claimFrozen: Object.isFrozen(claim),
      claimKeys: Object.keys(claim || {}).sort(),
      sourceExact: claim && claim.sourceRev ===
        ChessyMomentScan.sourceRevision(review.game, claim.scanColor),
      analysisExact: claim && claim.analysisRev ===
        ChessyMomentScan.analysisRevision(review.game),
      forged: ChessyMomentScan.claimSuggestion({ ply: 1, playedSan: 'e5' }),
      cards: (await CoachStore.listCards()).filter(function (card) {
        return card.gameId === gameId;
      }).length,
      proposalHidden: document.getElementById('lessonProposalBox').hidden,
      proposalStatusHidden:
        document.getElementById('lessonProposalStatus').hidden,
      verifyHidden: document.getElementById('verifyBox').hidden,
      cause: document.getElementById('cardCause').value,
      lesson: document.getElementById('cardLesson').value
    };
  }, approvedGame);
  check(exact.state && exact.state.state === 'done' &&
        exact.storedState === 'done' && exact.state.moments.length === 2,
    'the real controller durably completes an exact two-moment scan');
  check(exact.partialMomentHidden && exact.completedMomentsRestored,
    'partial pass-two moments stay hidden until the completed job can issue claims');
  check(exact.claim && exact.claimFrozen && exact.sourceExact &&
        exact.analysisExact && exact.forged === null &&
        exact.claimKeys.join(',') ===
          'algorithm,analysisRev,identity,jobSchema,ordinal,playedSan,ply,scanColor,sourceRev',
    'only an exact completed scan member receives an immutable scalar claim');
  check(Array.isArray(exact.storedDecisions) &&
        exact.storedDecisions.length === 0 &&
        exact.cards === 0 && exact.proposalHidden &&
        exact.proposalStatusHidden && exact.verifyHidden &&
        exact.cause === '' && exact.lesson === '',
    'a completed scan has no draft, evidence, verdict or card before reflection');

  await openSuggestion(0);
  const beforeGate = await page.evaluate(function () {
    return {
      proposalHidden: document.getElementById('lessonProposalBox').hidden,
      statusHidden: document.getElementById('lessonProposalStatus').hidden,
      verifyHidden: document.getElementById('verifyBox').hidden,
      cause: document.getElementById('cardCause').value,
      lesson: document.getElementById('cardLesson').value
    };
  });
  check(beforeGate.proposalHidden && beforeGate.statusHidden &&
        beforeGate.verifyHidden && beforeGate.cause === '' &&
        beforeGate.lesson === '',
    'opening a claimed suggestion remains spoiler-free before Gate 0');

  await fillNoCandidatesReflection();
  await verifyReflection();
  const drafted = await page.evaluate(function () {
    return {
      proposalVisible: !document.getElementById('lessonProposalBox').hidden,
      evidence: document.getElementById('lessonProposalEvidence').textContent,
      cause: document.getElementById('cardCause').value,
      lesson: document.getElementById('cardLesson').value,
      saveText: document.getElementById('saveCard').textContent,
      reflectionCalls: window.__lessonCalls.filter(function (call) {
        return call.owner === 'reflection' &&
          call.gameId === 'lesson-browser-approved' && call.ply === 0;
      }).length,
      cards: null
    };
  });
  drafted.cards = (await cardsFor(approvedGame)).length;
  check(drafted.proposalVisible &&
        drafted.evidence.includes('complete, stable') &&
        drafted.cause === 'candidates' &&
        drafted.lesson ===
          'Before moving, name at least two legal candidates.' &&
        drafted.saveText === 'Approve lesson card' &&
        drafted.reflectionCalls === 1 &&
        drafted.cards === 0,
    'structured reflection plus verified non-equivalence yields one editable draft but no automatic card');

  const editedLesson =
    'Compare at least two candidate moves before I commit.';
  await page.selectOption('#cardCause', 'evaluation');
  await page.fill('#cardLesson', editedLesson);
  await page.evaluate(function () {
    window.__lessonRealDecide = CoachStore.decideLessonProposal;
    window.__lessonApprovalGate = new Promise(function (resolve) {
      window.__lessonReleaseApproval = resolve;
    });
    CoachStore.decideLessonProposal = function () {
      const args = arguments;
      return window.__lessonApprovalGate.then(function () {
        return window.__lessonRealDecide.apply(CoachStore, args);
      });
    };
  });
  await page.click('#saveCard');
  check(await page.locator('#saveCard').isDisabled() &&
        await page.locator('#skipLessonProposal').isDisabled(),
    'Approve and Skip are mutually disabled while the decision is pending');
  await page.evaluate(function () { window.__lessonReleaseApproval(); });
  await page.waitForFunction(function () {
    const saved = document.getElementById('cardSaved');
    return !saved.hidden && saved.textContent.indexOf('Lesson card saved') !== -1;
  });
  await page.evaluate(function () {
    CoachStore.decideLessonProposal = window.__lessonRealDecide;
    delete window.__lessonRealDecide;
    delete window.__lessonApprovalGate;
    delete window.__lessonReleaseApproval;
  });

  const approved = await page.evaluate(async function (gameId) {
    const cards = (await CoachStore.listCards()).filter(function (card) {
      return card.gameId === gameId;
    });
    const card = cards[0];
    const review = CoachReview.current();
    const job = await CoachStore.getJob(gameId);
    const validation = card ? ChessyLessonProposal.validate(
      card.lessonProposal,
      {
        state: review.states[card.ply],
        reflection: card.reflection,
        equivalence: card.equivalence,
        card: card
      }
    ) : 'missing card';
    return {
      count: cards.length,
      id: card && card.id,
      cause: card && card.cause,
      lesson: card && card.lesson,
      generatedCause: card && card.lessonProposal &&
        card.lessonProposal.draft.cause,
      approvedCause: card && card.lessonProposal &&
        card.lessonProposal.approval.cause,
      approvedLesson: card && card.lessonProposal &&
        card.lessonProposal.approval.lesson,
      reflectionProvenance: card && card.reflection &&
        card.reflection.provenance,
      candidateStatus: card && card.reflection &&
        card.reflection.candidates.status,
      calculationStatus: card && card.reflection &&
        card.reflection.calculation.status,
      criterion: card && card.lessonProposal &&
        card.lessonProposal.evidence.analysis.criterion,
      provider: card && card.lessonProposal &&
        card.lessonProposal.evidence.analysis.provider,
      stable: card && card.lessonProposal &&
        card.lessonProposal.evidence.analysis.stability.bestMoveStable,
      playedVerdict: card && card.lessonProposal &&
        card.lessonProposal.evidence.played.verdict,
      scanIdentity: card && card.lessonProposal &&
        card.lessonProposal.scan.identity,
      claimIdentity: window.__lessonFirstClaim.identity,
      evidenceMatchesCard: card &&
        JSON.stringify(card.lessonProposal.evidence.analysis) ===
          JSON.stringify(card.equivalence),
      decisions: job && job.proposalDecisions,
      validation: validation,
      storeValidation: card
        ? CoachStore.validateCardRecord(card, null, review.game)
        : 'missing card'
    };
  }, approvedGame);
  check(approved.count === 1 &&
        approved.cause === 'evaluation' &&
        approved.lesson === editedLesson &&
        approved.generatedCause === 'candidates' &&
        approved.approvedCause === 'evaluation' &&
        approved.approvedLesson === editedLesson,
    'explicit approval persists the player edits while retaining the generated finding');
  check(approved.reflectionProvenance ===
          'player-self-report/pre-engine-v1' &&
        approved.candidateStatus === 'none' &&
        approved.calculationStatus === 'none' &&
        approved.criterion && approved.criterion.version === 1 &&
        approved.provider && approved.provider.engineId &&
        approved.provider.version && approved.provider.configHash &&
        approved.stable === true &&
        approved.playedVerdict === 'not-equivalent' &&
        approved.scanIdentity === approved.claimIdentity &&
        approved.evidenceMatchesCard &&
        approved.validation === null &&
        approved.storeValidation === null,
    'the durable card carries reproducible structured reflection, exact scan, criterion and engine evidence');
  check(approved.decisions && approved.decisions.length === 1 &&
        approved.decisions[0].status === 'approved',
    'approval is recorded atomically beside the completed scan');

  // Reopen and derive the same proposal again. The deterministic proposal id
  // updates the existing moment/card and decision instead of minting either.
  await leaveReview();
  await page.evaluate(function (gameId) {
    window.__lessonMode = 'error';
    return CoachReview.openArchivedGame(gameId);
  }, approvedGame);
  await page.waitForFunction(function () {
    return document.getElementById('scanProgress').textContent
      .indexOf('Scan complete') !== -1;
  });
  await openSuggestion(0);
  await fillNoCandidatesReflection();
  await verifyReflection();
  check(await page.locator('#lessonProposalBox').isVisible(),
    'reopening re-derives the same approved draft from durable exact evidence');
  const revisedLesson =
    'Re-check candidate evaluations before choosing the move.';
  await page.selectOption('#cardCause', 'impulse');
  await page.fill('#cardLesson', revisedLesson);
  await page.click('#saveCard');
  await page.waitForFunction(function () {
    const saved = document.getElementById('cardSaved');
    return !saved.hidden &&
      saved.textContent.indexOf('Updated this moment') !== -1;
  });
  const repeated = await page.evaluate(async function (input) {
    const cards = (await CoachStore.listCards()).filter(function (card) {
      return card.gameId === input.gameId;
    });
    const job = await CoachStore.getJob(input.gameId);
    return {
      count: cards.length,
      sameId: cards[0] && cards[0].id === input.cardId,
      cause: cards[0] && cards[0].cause,
      lesson: cards[0] && cards[0].lesson,
      decisions: job && job.proposalDecisions
    };
  }, { gameId: approvedGame, cardId: approved.id });
  check(repeated.count === 1 && repeated.sameId &&
        repeated.cause === 'impulse' &&
        repeated.lesson === revisedLesson &&
        repeated.decisions && repeated.decisions.length === 1 &&
        repeated.decisions[0].status === 'approved',
    'reopen and reapprove are idempotent: one card and one approved decision are updated');

  // The second exact scan member can be rejected without producing a card.
  await page.evaluate(function () { CoachReview.goToPly(1); });
  await page.waitForFunction(function () {
    const buttons = document.querySelectorAll('#scanMomentList .scan-moment');
    return buttons.length === 2 && !buttons[1].disabled;
  });
  await openSuggestion(1);
  await fillNoCandidatesReflection();
  await verifyReflection();
  check(await page.locator('#lessonProposalBox').isVisible(),
    'the second exact scan member independently produces a verified draft');
  await page.click('#skipLessonProposal');
  await page.waitForFunction(function () {
    const status = document.getElementById('lessonProposalStatus');
    return !status.hidden && status.textContent.indexOf('Draft skipped') !== -1;
  });
  const skipped = await page.evaluate(async function (gameId) {
    const cards = (await CoachStore.listCards()).filter(function (card) {
      return card.gameId === gameId;
    });
    const job = await CoachStore.getJob(gameId);
    return {
      count: cards.length,
      secondCard: cards.some(function (card) { return card.ply === 2; }),
      decisions: job && job.proposalDecisions,
      proposalHidden: document.getElementById('lessonProposalBox').hidden,
      cause: document.getElementById('cardCause').value,
      lesson: document.getElementById('cardLesson').value
    };
  }, approvedGame);
  check(skipped.count === 1 && !skipped.secondCard &&
        skipped.proposalHidden && skipped.cause === '' &&
        skipped.lesson === '' &&
        skipped.decisions && skipped.decisions.length === 2 &&
        skipped.decisions.some(function (decision) {
          return decision.ordinal === 1 && decision.status === 'skipped';
        }),
    'Skip records the decision but creates no card and clears the generated fields');

  // Decisions are per exact scan moment, not per provider-generated proposal
  // id. Simulate an older provider id in the cache, reopen, and prove the
  // already-skipped moment cannot prompt again.
  await page.evaluate(async function (gameId) {
    const job = await CoachStore.getJob(gameId);
    const skipped = job.proposalDecisions.find(function (decision) {
      return decision.ordinal === 1 && decision.status === 'skipped';
    });
    skipped.proposalId = 'older-provider-proposal-id';
    await CoachStore.putJob(job);
  }, approvedGame);
  await leaveReview();
  await page.evaluate(function (gameId) {
    window.__lessonMode = 'error';
    return CoachReview.openArchivedGame(gameId);
  }, approvedGame);
  await page.waitForFunction(function () {
    return document.getElementById('scanProgress').textContent
      .indexOf('Scan complete') !== -1;
  });
  await openSuggestion(1);
  await fillNoCandidatesReflection();
  await verifyReflection();
  const skipReopen = await page.evaluate(async function (gameId) {
    return {
      proposalHidden: document.getElementById('lessonProposalBox').hidden,
      status: document.getElementById('lessonProposalStatus').textContent,
      cards: (await CoachStore.listCards()).filter(function (card) {
        return card.gameId === gameId;
      }).length
    };
  }, approvedGame);
  check(skipReopen.proposalHidden &&
        skipReopen.status.includes('No sufficiently verified') &&
        skipReopen.cards === 1,
    'a skipped scan moment stays suppressed when provider proposal identity changes');

  // Equivalent and unresolved engine evidence remain manual-only: neither can
  // create or prefill an automatic diagnosis.
  await leaveReview();
  const equivalentGame = 'lesson-browser-equivalent';
  await prepareGame(equivalentGame, 'equivalent', 1002);
  await openSuggestion(0);
  await fillNoCandidatesReflection();
  await verifyReflection();
  const equivalent = await page.evaluate(async function (gameId) {
    return {
      proposalHidden: document.getElementById('lessonProposalBox').hidden,
      status: document.getElementById('lessonProposalStatus').textContent,
      cause: document.getElementById('cardCause').value,
      lesson: document.getElementById('cardLesson').value,
      cards: (await CoachStore.listCards()).filter(function (card) {
        return card.gameId === gameId;
      }).length
    };
  }, equivalentGame);
  check(equivalent.proposalHidden &&
        equivalent.status.includes('No sufficiently verified') &&
        equivalent.cause === '' && equivalent.lesson === '' &&
        equivalent.cards === 0,
    'an engine-equivalent played move yields no proposal and no card');

  await leaveReview();
  const unresolvedGame = 'lesson-browser-unresolved';
  await prepareGame(unresolvedGame, 'unresolved', 1003);
  await openSuggestion(0);
  await fillNoCandidatesReflection();
  await verifyReflection();
  const unresolved = await page.evaluate(async function (gameId) {
    return {
      proposalHidden: document.getElementById('lessonProposalBox').hidden,
      status: document.getElementById('lessonProposalStatus').textContent,
      cause: document.getElementById('cardCause').value,
      lesson: document.getElementById('cardLesson').value,
      cards: (await CoachStore.listCards()).filter(function (card) {
        return card.gameId === gameId;
      }).length
    };
  }, unresolvedGame);
  check(unresolved.proposalHidden &&
        unresolved.status.includes('No sufficiently verified') &&
        unresolved.cause === '' && unresolved.lesson === '' &&
        unresolved.cards === 0,
    'an unstable unresolved comparison yields no proposal and no card');

  // A clock-only source replacement keeps the moves and displayed Review
  // position unchanged. The proposal transaction must still reject approval.
  await leaveReview();
  const staleGame = 'lesson-browser-stale';
  await prepareGame(staleGame, 'error', 1004);
  await openSuggestion(0);
  await fillNoCandidatesReflection();
  await verifyReflection();
  check(await page.locator('#lessonProposalBox').isVisible(),
    'the stale-source case reaches a valid draft before replacement');
  await page.evaluate(async function (gameId) {
    const revised = await CoachStore.getGame(gameId);
    revised.clocks = JSON.parse(JSON.stringify(revised.clocks));
    revised.clocks[0].thinkMs += 777;
    revised.createdAt += 10000;
    await CoachStore.archiveGame(revised);
  }, staleGame);
  await page.click('#saveCard');
  await page.waitForFunction(function () {
    return document.getElementById('reflectForm').hidden &&
      document.getElementById('verifyBox').hidden;
  });
  const stale = await page.evaluate(async function (gameId) {
    const game = await CoachStore.getGame(gameId);
    return {
      cards: (await CoachStore.listCards()).filter(function (card) {
        return card.gameId === gameId;
      }).length,
      sameMoves: game.sans.join(',') === 'f3,e5,g4,Qh4#',
      revisedClock: game.clocks[0].thinkMs === 1777
    };
  }, staleGame);
  check(stale.cards === 0 && stale.sameMoves && stale.revisedClock,
    'a clock-only source revision is atomically stale and cannot receive the proposal card');

  // The same invalidation rule also removes an approval that was valid before
  // corrected clock evidence changed the otherwise identical ending.
  await leaveReview();
  const invalidatedGame = 'lesson-browser-source-invalidation';
  await prepareGame(invalidatedGame, 'error', 1005);
  await openSuggestion(0);
  await fillNoCandidatesReflection();
  await verifyReflection();
  await page.click('#saveCard');
  await page.waitForFunction(function () {
    const saved = document.getElementById('cardSaved');
    return !saved.hidden && saved.textContent.indexOf('Lesson card saved') !== -1;
  });
  const beforeInvalidation = await page.evaluate(async function (gameId) {
    return {
      cards: (await CoachStore.listCards()).filter(function (card) {
        return card.gameId === gameId;
      }).length,
      jobState: (await CoachStore.getJob(gameId)).state
    };
  }, invalidatedGame);
  await page.evaluate(async function (gameId) {
    const revised = await CoachStore.getGame(gameId);
    revised.clocks = JSON.parse(JSON.stringify(revised.clocks));
    revised.clocks[2].thinkMs += 333;
    revised.createdAt += 10000;
    await CoachStore.archiveGame(revised);
  }, invalidatedGame);
  const afterInvalidation = await page.evaluate(async function (gameId) {
    const game = await CoachStore.getGame(gameId);
    const job = await CoachStore.getJob(gameId);
    return {
      cards: (await CoachStore.listCards()).filter(function (card) {
        return card.gameId === gameId;
      }).length,
      jobMissing: job == null,
      sameMoves: game.sans.join(',') === 'f3,e5,g4,Qh4#',
      revisedClock: game.clocks[2].thinkMs === 1233
    };
  }, invalidatedGame);
  check(beforeInvalidation.cards === 1 &&
        beforeInvalidation.jobState === 'done' &&
        afterInvalidation.cards === 0 &&
        afterInvalidation.jobMissing &&
        afterInvalidation.sameMoves && afterInvalidation.revisedClock,
    'corrected clock evidence on the same ending invalidates proposal cards and the completed job');

  // Seed the already-reached durable per-game cap to exercise the user-facing
  // branch across proposal cards that need not share a scan identity.
  // Store-level concurrency/corruption permutations stay in the fast suite;
  // here the real transaction must decline a third distinct target.
  await leaveReview();
  const cappedGame = 'lesson-browser-cap';
  await prepareGame(cappedGame, 'error', 1006);
  await openSuggestion(0);
  await fillNoCandidatesReflection();
  await verifyReflection();
  await page.evaluate(async function (gameId) {
    const state = ChessyMomentScan.state();
    const claim = ChessyMomentScan.claimSuggestion(state.moments[0]);
    for (let i = 0; i < 2; i++) {
      const seededScan = JSON.parse(JSON.stringify(claim));
      seededScan.identity = 'prior-scan-identity-' + (i + 1);
      seededScan.ordinal = i;
      seededScan.ply = 40 + i;
      seededScan.playedSan = 'seed-' + (i + 1);
      await CoachStore.addCard({
        gameId: gameId,
        ply: seededScan.ply,
        due: Date.now() + i,
        step: -1,
        attempts: [],
        cause: 'seed',
        lesson: 'Existing proposal card ' + (i + 1),
        lessonProposal: {
          proposalId: 'seed-proposal-' + (i + 1),
          scan: seededScan
        }
      });
    }
  }, cappedGame);
  await page.click('#saveCard');
  await page.waitForFunction(function () {
    const saved = document.getElementById('cardSaved');
    return !saved.hidden &&
      saved.textContent.indexOf('two approved proposal cards') !== -1;
  });
  const capped = await page.evaluate(async function (gameId) {
    const cards = (await CoachStore.listCards()).filter(function (card) {
      return card.gameId === gameId;
    });
    const job = await CoachStore.getJob(gameId);
    return {
      count: cards.length,
      targetWritten: cards.some(function (card) { return card.ply === 0; }),
      saveEnabled: !document.getElementById('saveCard').disabled,
      approvedDecision: !!job && job.proposalDecisions.some(function (decision) {
        return decision.ordinal === 0 && decision.status === 'approved';
      })
    };
  }, cappedGame);
  check(capped.count === 2 && !capped.targetWritten &&
        capped.saveEnabled && !capped.approvedDecision,
    'the serialized per-game cap refuses a third card without recording a false approval');
});
