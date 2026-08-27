/*
 * Phase 5 critical-moment scan controller.
 *
 * This module deliberately owns orchestration only. ChessyAnalysisCore owns
 * the engine contract, ChessyAnalysisResult owns the trust boundary, and
 * ChessyMomentSelector owns the deterministic selection policy. The
 * controller contributes the parts that are easy to get subtly wrong:
 *
 *   - one sequential quick request at a time over every non-terminal move,
 *     while critical-moment nomination remains limited to the chosen side;
 *   - a shallow pass followed by at most two exact reflection-profile checks;
 *   - a durable checkpoint after every completed decision and verification;
 *   - reload-safe pause/resume with the cursor meaning "next ply";
 *   - generation ownership, so a late callback after Restore/Delete all,
 *     navigation, or an explicit pause can never write or repaint;
 *   - sanitized events: pre-reflection UI sees only progress and
 *     { ply, playedSan } suggestions, never scores, labels or better moves;
 *   - compact move summaries remain private until the matching structured
 *     reflection receipt crosses Gate 0. A full ledger unlocks only after all
 *     suggested moments have been reflected on.
 *
 * Nothing starts automatically. The Review UI must call start()/resume() in
 * response to an explicit player action.
 */
(function (global) {
  'use strict';
  if (typeof Chess === 'undefined' ||
      typeof ChessyAnalysisCore === 'undefined' ||
      typeof ChessyAnalysisService === 'undefined' ||
      typeof ChessyAnalysisResult === 'undefined' ||
      typeof ChessyMomentSelector === 'undefined' ||
      typeof ChessyAnalysisNotation === 'undefined') return;

  var JOB_SCHEMA = 3;
  var ALGORITHM = 'critical-moments-v3';
  var QUICK_EVIDENCE_SCHEMA = 1;
  var QUICK_EVIDENCE_POLICY = 'critical-quick-evidence-v1';
  var QUICK_RESULT_SCHEMA = 1;
  var QUICK_RESULT_POLICY = 'critical-quick-result-v1';
  var DEEP_RESULT_SCHEMA = 1;
  var DEEP_RESULT_POLICY = 'critical-deep-result-v1';
  var QUICK = {
    maxDepth: 5, nodeLimit: 5000, nodeBudget: 150000, multiPV: 1, pvLen: 3
  };
  var QUICK_FALLBACK = {
    maxDepth: 5, nodeLimit: 12000, nodeBudget: 300000, multiPV: 1, pvLen: 3
  };
  // Kept byte-for-byte aligned with reflection.js. A suggestion click can
  // therefore reuse the already validated deep result from the analysis cache.
  var DEEP = {
    maxDepth: 10, nodeLimit: 80000, nodeBudget: 1200000, multiPV: 3, pvLen: 6
  };

  var generation = 0;
  var current = null;
  var currentSource = null;
  var running = false;
  // Validated durable Gate-0 receipts for the current exact game source. This
  // is populated only through CoachStore's replay validator; analysisJobs and
  // lesson cards are never reflection authority.
  var currentReflections = [];
  // Monotonic within this page. A durable commit/invalidation that overlaps a
  // slower prepare() forces that preparation to re-read receipts instead of
  // installing an already-stale snapshot.
  var reflectionEpoch = 0;
  var OWNER = 'moment-scan';

  var QUICK_EVIDENCE_KEYS = [
    'accepted', 'bestMate', 'bestSan', 'bestScoreCpWhite', 'bestUci',
    'clockAnomaly', 'configHash', 'depth', 'engineId', 'engineVersion',
    'evidencePolicy', 'evidenceSchema', 'lossUtility', 'mate', 'playedSan',
    'ply', 'policy', 'positionFingerprint', 'profile', 'schema',
    'scoreCpWhite', 'stability', 'turn'
  ].sort();
  var QUICK_SUMMARY_KEYS = [
    'accepted', 'bestMate', 'bestScoreCpWhite', 'clockAnomaly', 'configHash',
    'depth', 'engineId', 'engineVersion', 'lossUtility', 'mate', 'playedSan',
    'ply', 'policy', 'positionFingerprint', 'profile', 'schema',
    'scoreCpWhite', 'stability', 'turn'
  ].sort();
  var QUICK_RESULT_KEYS = [
    'ply', 'profile', 'result', 'resultPolicy', 'resultSchema'
  ].sort();
  var DEEP_RESULT_KEYS = QUICK_RESULT_KEYS;

  function now() {
    return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
  }

  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  // Shared cache revision for scan and manual reflection. SetUp/FEN is part of
  // the game, so two identical SAN lists from different initial boards must
  // never share a result.
  function analysisRevision(game) {
    return hash(JSON.stringify({
      setupFen: game && game.setupFen || null,
      sans: game && Array.isArray(game.sans) ? game.sans : []
    }));
  }

  // Progress additionally depends on who is being scanned and on exact clock
  // evidence. Changing either must restart selection even though the engine
  // position cache itself remains reusable through analysisRevision().
  function sourceRevision(game, scanColor) {
    return hash(JSON.stringify({
      analysis: analysisRevision(game),
      scanColor: scanColor,
      playerColor: game && game.playerColor || null,
      timeControl: game && game.timeControl || null,
      clocks: game && Array.isArray(game.clocks) ? game.clocks : []
    }));
  }

  function sourceSnapshot(game) {
    return {
      id: game.id,
      setupFen: game.setupFen || null,
      playerColor: game.playerColor || null,
      sans: Array.isArray(game.sans) ? game.sans.slice() : [],
      clocks: Array.isArray(game.clocks)
        ? JSON.parse(JSON.stringify(game.clocks)) : [],
      timeControl: game.timeControl || null
    };
  }

  function sameReflectionSource(snapshot, game) {
    return global.CoachStore &&
      typeof CoachStore.sameReflectionSource === 'function' &&
      CoachStore.sameReflectionSource(snapshot, game);
  }

  function receiptRows(rows) {
    return Array.isArray(rows) ? rows.map(function (receipt) {
      return { ply: receipt.ply, playedSan: receipt.playedSan };
    }) : [];
  }

  function readReceipts(review) {
    return global.CoachStore &&
      typeof CoachStore.listValidReflectionReceipts === 'function'
      ? Promise.resolve(CoachStore.listValidReflectionReceipts(review.game))
      : Promise.resolve([]);
  }

  // If a durable receipt change overlapped an earlier read, repeat until one
  // read spans a stable epoch. Each returned row has already crossed Store's
  // exact-source replay boundary.
  function settleReceiptRead(review, rows, observedEpoch) {
    if (observedEpoch === reflectionEpoch) return Promise.resolve(rows);
    var nextEpoch = reflectionEpoch;
    return readReceipts(review).then(function (fresh) {
      return settleReceiptRead(review, fresh, nextEpoch);
    });
  }

  function scanColorFor(game, requested) {
    var own = game && game.playerColor;
    if (own === 'w' || own === 'b') return own;
    if (own === 'both') return 'both';
    return requested === 'w' || requested === 'b' || requested === 'both'
      ? requested : null;
  }

  function stateTerminal(state) {
    try { return !!Chess.gameStatus(state).over; }
    catch (e) { return true; }
  }

  function scannable(review, ply) {
    if (!review || !review.gs || !Array.isArray(review.gs.history) ||
        ply < 0 || ply >= review.gs.history.length) return false;
    var state = review.states && review.states[ply];
    return !!state && !stateTerminal(state);
  }

  function eligible(review, ply, scanColor) {
    if (!scannable(review, ply)) return false;
    return scanColor === 'both' || review.states[ply].turn === scanColor;
  }

  function countScannable(review) {
    var n = review && review.gs && Array.isArray(review.gs.history)
      ? review.gs.history.length : 0;
    var total = 0;
    for (var ply = 0; ply < n; ply++) {
      if (scannable(review, ply)) total++;
    }
    return total;
  }

  function countScannableBefore(review, cursor) {
    var end = Math.min(
      Number.isInteger(cursor) ? cursor : 0,
      review && review.gs && Array.isArray(review.gs.history)
        ? review.gs.history.length : 0);
    var total = 0;
    for (var ply = 0; ply < end; ply++) {
      if (scannable(review, ply)) total++;
    }
    return total;
  }

  function exactThinkMs(game, ply) {
    var c = game && Array.isArray(game.clocks) ? game.clocks[ply] : null;
    return c && typeof c.thinkMs === 'number' && isFinite(c.thinkMs) &&
      c.thinkMs >= 0 ? c.thinkMs : null;
  }

  function median(values) {
    values = values.slice().sort(function (a, b) { return a - b; });
    if (!values.length) return null;
    var mid = Math.floor(values.length / 2);
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  }

  function typicalThinkMsBySide(review, scanColor) {
    var times = { w: [], b: [] };
    var n = review && review.gs && Array.isArray(review.gs.history)
      ? review.gs.history.length : 0;
    for (var ply = 0; ply < n; ply++) {
      if (!eligible(review, ply, scanColor)) continue;
      var ms = exactThinkMs(review.game, ply);
      if (ms !== null) times[review.states[ply].turn].push(ms);
    }
    return { w: median(times.w), b: median(times.b) };
  }

  function profileOf(name) {
    return name === 'deep' ? DEEP :
      (name === 'quick-fallback' ? QUICK_FALLBACK : QUICK);
  }

  function arrays(job) {
    job.candidates = Array.isArray(job.candidates) ? job.candidates : [];
    job.shortlist = Array.isArray(job.shortlist) ? job.shortlist : [];
    job.moments = Array.isArray(job.moments) ? job.moments : [];
    job.unresolved = Array.isArray(job.unresolved) ? job.unresolved : [];
    job.moveSummaries = Array.isArray(job.moveSummaries)
      ? job.moveSummaries : [];
    job.deepResults = Array.isArray(job.deepResults)
      ? job.deepResults : [];
    job.quickEvidence = Array.isArray(job.quickEvidence)
      ? job.quickEvidence : [];
    job.quickResults = Array.isArray(job.quickResults)
      ? job.quickResults : [];
    job.quickSummaries = Array.isArray(job.quickSummaries)
      ? job.quickSummaries : [];
    // Legacy jobs may contain shape-valid `reflected` rows. They are untrusted
    // cache fields and must not survive normalization/checkpointing; durable,
    // replay-validated reflectionReceipts are the only Gate-0 authority.
    delete job.reflected;
    return job;
  }

  function summaryAt(job, ply) {
    return job.moveSummaries.find(function (summary) {
      return summary.ply === ply;
    }) || null;
  }

  function replaceSummary(job, summary) {
    if (!summary) return;
    var existing = summaryAt(job, summary.ply);
    // A later shallow pass must never downgrade a manually verified deep row.
    if (existing && existing.profile === 'deep' &&
        summary.profile !== 'deep') return;
    job.moveSummaries = job.moveSummaries.filter(function (old) {
      return old.ply !== summary.ply;
    });
    job.moveSummaries.push(summary);
    job.moveSummaries.sort(function (a, b) { return a.ply - b.ply; });
  }

  function copyMate(mate) {
    return mate === null ? null : {
      forWhite: mate.forWhite,
      inPlies: mate.inPlies
    };
  }

  function copyStability(stability) {
    return stability === null ? null : {
      depths: stability.depths.slice(),
      bestMoveStable: stability.bestMoveStable
    };
  }

  /*
   * The public ledger summary deliberately omits engine alternatives. Pass 1
   * nevertheless needs the validated best root move to reproduce the
   * selector's quiet-line weight after a reload. Keep its canonical UCI and
   * SAN integrity mirror beside a frozen quick summary, then regenerate and
   * compare SAN from legal replay; every other selector input is derived from
   * the summary and exact archived clocks.
   */
  function makeQuickEvidence(result, summary) {
    var top = result && Array.isArray(result.bestLines)
      ? result.bestLines[0] : null;
    if (!summary || (summary.profile !== 'quick' &&
        summary.profile !== 'quick-fallback') || !top ||
        typeof top.uci !== 'string' || typeof top.san !== 'string') return null;
    return {
      evidenceSchema: QUICK_EVIDENCE_SCHEMA,
      evidencePolicy: QUICK_EVIDENCE_POLICY,
      schema: summary.schema,
      policy: summary.policy,
      ply: summary.ply,
      playedSan: summary.playedSan,
      turn: summary.turn,
      profile: summary.profile,
      scoreCpWhite: summary.scoreCpWhite,
      mate: copyMate(summary.mate),
      bestScoreCpWhite: summary.bestScoreCpWhite,
      bestMate: copyMate(summary.bestMate),
      lossUtility: summary.lossUtility,
      clockAnomaly: summary.clockAnomaly,
      depth: summary.depth,
      stability: copyStability(summary.stability),
      accepted: summary.accepted,
      engineId: summary.engineId,
      engineVersion: summary.engineVersion,
      configHash: summary.configHash,
      positionFingerprint: summary.positionFingerprint,
      bestUci: top.uci,
      bestSan: top.san
    };
  }

  function replaceQuickEvidence(job, evidence) {
    if (!evidence) return;
    job.quickEvidence = job.quickEvidence.filter(function (old) {
      return old.ply !== evidence.ply;
    });
    job.quickEvidence.push(evidence);
    job.quickEvidence.sort(function (a, b) { return a.ply - b.ply; });
  }

  // The complete validated engine contract is the only durable Pass-1
  // authority. First detach hostile/cyclic input, then copy the explicit
  // AnalysisCore contract allowlist so validator-ignored provider/test fields
  // can never influence restored selection.
  function snapshotResult(result) {
    try {
      var encoded = JSON.stringify(result);
      if (typeof encoded !== 'string') return null;
      var source = JSON.parse(encoded);
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return null;
      }
      var required = [
        'bestLines', 'classification', 'complete', 'depth', 'elapsedMs',
        'engine', 'mate', 'nodes', 'playedLine', 'positionFingerprint',
        'qnodes', 'scoreCpPlayer', 'scoreCpWhite', 'stability', 'turn', 'wdl'
      ];
      if (!required.every(function (key) {
        return Object.prototype.hasOwnProperty.call(source, key);
      }) || source.wdl !== null ||
          !Number.isInteger(source.qnodes) || source.qnodes < 0 ||
          !Number.isInteger(source.nodes) || source.qnodes > source.nodes) {
        return null;
      }
      function mate(value) {
        return value === null ? null : value && typeof value === 'object'
          ? { forWhite: value.forWhite, inPlies: value.inPlies } : value;
      }
      function move(value) {
        return value && typeof value === 'object' ? {
          from: value.from,
          to: value.to,
          promotion: value.promotion == null ? null : value.promotion
        } : value;
      }
      function line(value, played) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return value;
        }
        var copy = {
          move: move(value.move),
          uci: value.uci,
          san: value.san,
          scoreCpWhite: value.scoreCpWhite,
          scoreCpPlayer: value.scoreCpPlayer,
          mate: mate(value.mate),
          pv: Array.isArray(value.pv) ? value.pv.slice() : value.pv,
          pvUci: Array.isArray(value.pvUci)
            ? value.pvUci.slice() : value.pvUci
        };
        if (played) {
          copy.rank = value.rank;
          copy.amongCandidates = value.amongCandidates;
        }
        return copy;
      }
      return {
        engine: source.engine && typeof source.engine === 'object' ? {
          id: source.engine.id,
          version: source.engine.version,
          configHash: source.engine.configHash
        } : source.engine,
        turn: source.turn,
        positionFingerprint: source.positionFingerprint,
        wdl: null,
        complete: source.complete,
        depth: source.depth,
        nodes: source.nodes,
        qnodes: source.qnodes,
        elapsedMs: source.elapsedMs,
        scoreCpWhite: source.scoreCpWhite,
        scoreCpPlayer: source.scoreCpPlayer,
        mate: mate(source.mate),
        bestLines: Array.isArray(source.bestLines)
          ? source.bestLines.map(function (value) { return line(value, false); })
          : source.bestLines,
        playedLine: source.playedLine === null ? null :
          line(source.playedLine, true),
        classification: source.classification,
        stability: source.stability === null ? null :
          source.stability && typeof source.stability === 'object' ? {
            depths: Array.isArray(source.stability.depths)
              ? source.stability.depths.slice() : source.stability.depths,
            bestMoveStable: source.stability.bestMoveStable
          } : source.stability
      };
    } catch (e) {
      return null;
    }
  }

  function makeQuickResult(result, ply, profile) {
    var snapshot = snapshotResult(result);
    if (!snapshot || !Number.isInteger(ply) ||
        (profile !== 'quick' && profile !== 'quick-fallback')) return null;
    return {
      resultSchema: QUICK_RESULT_SCHEMA,
      resultPolicy: QUICK_RESULT_POLICY,
      ply: ply,
      profile: profile,
      result: snapshot
    };
  }

  function replaceQuickResult(job, record) {
    if (!record) return;
    job.quickResults = job.quickResults.filter(function (old) {
      return old.ply !== record.ply;
    });
    job.quickResults.push(record);
    job.quickResults.sort(function (a, b) { return a.ply - b.ply; });
  }

  function makeDeepResult(result, ply) {
    var snapshot = snapshotResult(result);
    if (!snapshot || !Number.isInteger(ply)) return null;
    return {
      resultSchema: DEEP_RESULT_SCHEMA,
      resultPolicy: DEEP_RESULT_POLICY,
      ply: ply,
      profile: 'deep',
      result: snapshot
    };
  }

  function replaceDeepResult(job, record) {
    if (!record) return;
    job.deepResults = job.deepResults.filter(function (old) {
      return old.ply !== record.ply;
    });
    job.deepResults.push(record);
    job.deepResults.sort(function (a, b) { return a.ply - b.ply; });
  }

  function copyQuickSummary(summary) {
    return {
      schema: summary.schema,
      policy: summary.policy,
      ply: summary.ply,
      playedSan: summary.playedSan,
      turn: summary.turn,
      profile: summary.profile,
      scoreCpWhite: summary.scoreCpWhite,
      mate: copyMate(summary.mate),
      bestScoreCpWhite: summary.bestScoreCpWhite,
      bestMate: copyMate(summary.bestMate),
      lossUtility: summary.lossUtility,
      clockAnomaly: summary.clockAnomaly,
      depth: summary.depth,
      stability: copyStability(summary.stability),
      accepted: summary.accepted,
      engineId: summary.engineId,
      engineVersion: summary.engineVersion,
      configHash: summary.configHash,
      positionFingerprint: summary.positionFingerprint
    };
  }

  function replaceQuickSummary(job, summary) {
    if (!summary) return;
    job.quickSummaries = job.quickSummaries.filter(function (old) {
      return old.ply !== summary.ply;
    });
    job.quickSummaries.push(copyQuickSummary(summary));
    job.quickSummaries.sort(function (a, b) { return a.ply - b.ply; });
  }

  function exactKeys(value, expected) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).sort().join('\n') === expected.join('\n');
  }

  function exactMateValue(value) {
    return value === null ||
      (exactKeys(value, ['forWhite', 'inPlies']) &&
       typeof value.forWhite === 'boolean' &&
       Number.isInteger(value.inPlies) && value.inPlies > 0);
  }

  function exactStabilityValue(value) {
    return value === null ||
      (exactKeys(value, ['bestMoveStable', 'depths']) &&
       Array.isArray(value.depths) && value.depths.length === 2 &&
       Object.keys(value.depths).sort().join('\n') === '0\n1' &&
       Number.isInteger(value.depths[0]) && Number.isInteger(value.depths[1]) &&
       typeof value.bestMoveStable === 'boolean');
  }

  function sameMateValue(a, b) {
    return exactMateValue(a) && exactMateValue(b) &&
      (a === null ? b === null : b !== null &&
       a.forWhite === b.forWhite && a.inPlies === b.inPlies);
  }

  function sameStabilityValue(a, b) {
    return exactStabilityValue(a) && exactStabilityValue(b) &&
      (a === null ? b === null : b !== null &&
       a.depths[0] === b.depths[0] && a.depths[1] === b.depths[1] &&
       a.bestMoveStable === b.bestMoveStable);
  }

  function sameSummaryEvidence(evidence, summary) {
    if (!exactKeys(summary, QUICK_SUMMARY_KEYS)) return false;
    var scalarFields = [
      'schema', 'policy', 'ply', 'playedSan', 'turn', 'profile',
      'scoreCpWhite', 'bestScoreCpWhite', 'lossUtility', 'clockAnomaly',
      'depth', 'accepted', 'engineId',
      'engineVersion', 'configHash', 'positionFingerprint'
    ];
    return scalarFields.every(function (name) {
      return evidence[name] === summary[name];
    }) && sameMateValue(evidence.mate, summary.mate) &&
      sameMateValue(evidence.bestMate, summary.bestMate) &&
      sameStabilityValue(evidence.stability, summary.stability);
  }

  function sameQuickEvidence(actual, canonicalSummary, canonicalEvidence) {
    return exactKeys(actual, QUICK_EVIDENCE_KEYS) &&
      canonicalEvidence &&
      actual.evidenceSchema === canonicalEvidence.evidenceSchema &&
      actual.evidencePolicy === canonicalEvidence.evidencePolicy &&
      actual.bestUci === canonicalEvidence.bestUci &&
      actual.bestSan === canonicalEvidence.bestSan &&
      sameSummaryEvidence(actual, canonicalSummary);
  }

  /*
   * Canonical restored-state boundary. The full quick engine result is
   * replay/provenance-validated against its exact request profile, then every
   * summary and selector value is regenerated from that checked contract plus
   * the current archived clocks. Persisted compact/derived fields never feed
   * this function.
   */
  function rebuildQuickState(record, review, job) {
    if (!exactKeys(record, QUICK_RESULT_KEYS) ||
        record.resultSchema !== QUICK_RESULT_SCHEMA ||
        record.resultPolicy !== QUICK_RESULT_POLICY ||
        (record.profile !== 'quick' &&
         record.profile !== 'quick-fallback') ||
        !Number.isInteger(record.ply) ||
        !scannable(review, record.ply)) {
      return { ok: false };
    }
    var result = snapshotResult(record.result);
    if (!result) return { ok: false };
    var state = review.states[record.ply];
    var req = moveRequest(
      review, job, record.ply, profileOf(record.profile), false);
    var checked;
    try {
      checked = ChessyAnalysisResult.validate(
        result, state, expectedFor(state, req, true, 2));
    } catch (e) {
      checked = { ok: false };
    }
    if (!checked || !checked.ok) return { ok: false };
    var meta = {
      ply: record.ply,
      playedSan: review.gs.history[record.ply].san,
      turn: state.turn,
      thinkMs: exactThinkMs(review.game, record.ply),
      typicalThinkMs: job.typicalThinkMsBySide[state.turn],
      validated: true
    };
    var summary = ChessyAnalysisNotation.summarize(
      result, Object.assign({}, meta, { profile: record.profile }));
    var evidence = summary ? makeQuickEvidence(result, summary) : null;
    if (!summary || !evidence) return { ok: false };
    return {
      ok: true,
      result: result,
      summary: summary,
      evidence: evidence,
      candidate: eligible(review, record.ply, job.scanColor)
        ? ChessyMomentSelector.quickCandidate(result, meta) : null
    };
  }

  function validateDeepRecord(record, review, job, requireEligible) {
    if (!exactKeys(record, DEEP_RESULT_KEYS) ||
        record.resultSchema !== DEEP_RESULT_SCHEMA ||
        record.resultPolicy !== DEEP_RESULT_POLICY ||
        record.profile !== 'deep' ||
        !Number.isInteger(record.ply) ||
        !scannable(review, record.ply) ||
        (requireEligible && !eligible(review, record.ply, job.scanColor))) {
      return { ok: false, reason: 'deep-result-shape' };
    }
    var result = snapshotResult(record.result);
    if (!result) return { ok: false, reason: 'deep-result-shape' };
    var state = review.states[record.ply];
    var req = moveRequest(review, job, record.ply, DEEP, false);
    var checked;
    try {
      checked = ChessyAnalysisResult.validate(
        result, state, expectedFor(state, req, true, 3));
    } catch (e) {
      checked = { ok: false, reason: 'validator-failed' };
    }
    if (!checked || !checked.ok) {
      return { ok: false, reason: checked && checked.reason };
    }
    return {
      ok: true,
      result: result,
      meta: {
        ply: record.ply,
        playedSan: review.gs.history[record.ply].san,
        turn: state.turn,
        thinkMs: exactThinkMs(review.game, record.ply),
        typicalThinkMs: job.typicalThinkMsBySide[state.turn],
        validated: true
      }
    };
  }

  function rebuildDeepState(record, quick, review, job) {
    if (!quick || quick.ply !== (record && record.ply)) {
      return { ok: false, reason: 'deep-result-shape' };
    }
    var checked = validateDeepRecord(record, review, job, true);
    if (!checked.ok) return checked;
    var accepted = ChessyMomentSelector.acceptDeep(
      quick, checked.result, checked.meta);
    var summary = ChessyAnalysisNotation.summarize(
      checked.result, Object.assign({}, checked.meta, {
        profile: 'deep',
        accepted: !!accepted
      }));
    if (!summary) return { ok: false, reason: 'summary-invalid' };
    return {
      ok: true,
      result: checked.result,
      summary: summary,
      accepted: accepted
    };
  }

  function rebuildManualDeepState(record, review, job) {
    var checked = validateDeepRecord(record, review, job, false);
    if (!checked.ok) return checked;
    var summary = ChessyAnalysisNotation.summarize(
      checked.result, Object.assign({}, checked.meta, {
        profile: 'deep',
        accepted: false
      }));
    return summary ? {
      ok: true,
      result: checked.result,
      summary: summary,
      accepted: null
    } : { ok: false, reason: 'summary-invalid' };
  }

  function sameFlatRecord(a, b) {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' ||
        Array.isArray(a) || Array.isArray(b)) return false;
    var aKeys = Object.keys(a).sort();
    var bKeys = Object.keys(b).sort();
    return aKeys.length === bKeys.length &&
      aKeys.every(function (key, index) {
        return key === bKeys[index] && a[key] === b[key];
      });
  }

  function sameCandidateList(actual, expected) {
    return Array.isArray(actual) && actual.length === expected.length &&
      actual.every(function (candidate, index) {
        return sameFlatRecord(candidate, expected[index]);
      });
  }

  function reflectionGate(job) {
    var reflected = Object.create(null);
    currentReflections.forEach(function (item) { reflected[item.ply] = true; });
    var required = job.moments.map(function (moment) { return moment.ply; });
    var completed;
    var unlocked;
    if (required.length) {
      completed = required.filter(function (ply) { return reflected[ply]; }).length;
      unlocked = completed === required.length;
    } else {
      completed = job.moveSummaries.some(function (summary) {
        return reflected[summary.ply];
      }) ? 1 : 0;
      required = job.moveSummaries.length ? [null] : [];
      unlocked = required.length === 1 && completed === 1;
    }
    return {
      reflected: reflected,
      required: required.length,
      completed: completed,
      unlocked: job.state === 'done' && unlocked
    };
  }

  function publicState(job) {
    if (!job) return null;
    var gate = reflectionGate(job);
    var state = {
      gameId: job.gameId,
      state: job.state,
      pass: job.pass,
      cursorPly: job.cursorPly,
      checked: job.checked,
      total: job.total,
      verifyIndex: job.verifyIndex,
      verifyTotal: Array.isArray(job.shortlist) ? job.shortlist.length : 0,
      moments: (Array.isArray(job.moments) ? job.moments : []).map(function (m) {
        return { ply: m.ply, playedSan: m.playedSan };
      }),
      reflectionRequired: gate.required,
      reflectionCompleted: gate.completed,
      reportUnlocked: gate.unlocked,
      unresolvedCount: Array.isArray(job.unresolved) ? job.unresolved.length : 0,
      error: typeof job.error === 'string' ? job.error : null
    };
    // Gate 0 is enforced at the public-state boundary, not only in the DOM.
    // Before a reflection there is no score-bearing property to inspect via a
    // stray event listener, accessibility attribute or developer console.
    var visible = job.moveSummaries.filter(function (summary) {
      return gate.unlocked || gate.reflected[summary.ply];
    });
    if (job.state === 'done' && visible.length) {
      state.report = visible.map(ChessyAnalysisNotation.publicEntry);
    }
    return state;
  }

  function emit(job) {
    if (typeof document === 'undefined' || !document.dispatchEvent) return;
    try {
      document.dispatchEvent(new CustomEvent('chessy:scanchange', {
        detail: publicState(job)
      }));
    } catch (e) { /* a non-DOM test environment may not provide CustomEvent */ }
  }

  function owns(token, job) {
    return token === generation && current === job;
  }

  function stopLocal() {
    generation++;
    running = false;
    try { ChessyAnalysisService.cancel(OWNER); } catch (e) { /* best effort */ }
  }

  // Guard every checkpoint against the source record in the SAME IndexedDB
  // transaction as the job put. That atomic store seam closes the TOCTOU race
  // where a same-id revision could otherwise commit after getGame() but before
  // putJob(), then receive an orphaned stale checkpoint.
  function checkpoint(token, job) {
    if (!owns(token, job)) return Promise.resolve(false);
    if (!global.CoachStore || !CoachStore.putJob) {
      return pauseForFailure(token, job, 'Archive unavailable — scan paused.');
    }
    job.updatedAt = now();
    if (CoachStore.putJobIfGame) {
      return Promise.resolve(CoachStore.putJobIfGame(job, currentSource))
        .then(function (wrote) {
          if (!owns(token, job)) return false;
          if (!wrote) {
            stopLocal();
            if (current === job) current = null;
            currentSource = null;
            emit(null);
            return false;
          }
          emit(job);
          return true;
        }).catch(function () {
          return pauseForFailure(token, job, 'Could not save progress — scan paused.');
        });
    }
    // Compatibility fallback for an intentionally partial test harness.
    if (!CoachStore.getGame) {
      return pauseForFailure(token, job, 'Archive unavailable — scan paused.');
    }
    return Promise.resolve(CoachStore.getGame(job.gameId)).then(function (game) {
      if (!owns(token, job)) return false;
      if (!game || sourceRevision(game, job.scanColor) !== job.sourceRev) {
        stopLocal();
        if (current === job) current = null;
        currentSource = null;
        emit(null);
        return false;
      }
      return Promise.resolve(CoachStore.putJob(job)).then(function () {
        if (!owns(token, job)) return false;
        emit(job);
        return true;
      });
    }).catch(function () {
      return pauseForFailure(token, job, 'Could not save progress — scan paused.');
    });
  }

  function pauseForFailure(token, job, message) {
    if (!owns(token, job)) return Promise.resolve(false);
    // Do not attempt another write after a persistence failure. Retain the
    // last durable cursor and require an explicit resume.
    generation++;
    running = false;
    job.state = 'paused';
    job.error = message;
    try { ChessyAnalysisService.cancel(OWNER); } catch (e) { /* best effort */ }
    emit(job);
    return Promise.resolve(false);
  }

  function moveRequest(review, job, ply, profile, fresh) {
    var entry = review.gs.history[ply];
    var state = review.states[ply];
    return {
      gameId: job.gameId,
      ply: ply,
      gameRev: job.analysisRev,
      fen: review.fens[ply],
      positions: state.positions,
      fresh: !!fresh,
      opts: {
        playedMove: entry.move,
        maxDepth: profile.maxDepth,
        nodeLimit: profile.nodeLimit,
        nodeBudget: profile.nodeBudget,
        multiPV: profile.multiPV,
        pvLen: profile.pvLen
      }
    };
  }

  function expectedFor(state, req, requirePlayed, minDepth) {
    var opts = Object.assign({}, req.opts, { positions: req.positions });
    return {
      identity: ChessyAnalysisCore.identity(state, opts),
      requireComplete: true,
      requirePlayed: !!requirePlayed,
      requireStability: minDepth >= 3,
      playedMove: req.opts.playedMove,
      minDepth: minDepth || 1
    };
  }

  function validate(result, state, req, minDepth) {
    try {
      return ChessyAnalysisResult.validate(
        result, state, expectedFor(state, req, true, minDepth));
    } catch (e) {
      return { ok: false, reason: 'validator-failed' };
    }
  }

  function unresolved(job, ply, phase, reason) {
    job.unresolved.push({
      ply: ply,
      phase: phase,
      reason: typeof reason === 'string' ? reason : 'unusable-result'
    });
  }

  function analyseQuick(review, job, ply, token) {
    var state = review.states[ply];
    var firstReq = moveRequest(review, job, ply, QUICK, false);
    return ChessyAnalysisService.analyse(firstReq, OWNER).then(function (res) {
      if (!owns(token, job)) return { stopped: true };
      if (res === null) return { paused: true };
      var checked = validate(res, state, firstReq, 2);
      if (checked.ok) {
        return {
          result: res,
          validation: checked,
          profile: 'quick'
        };
      }

      // Exactly one stronger retry. The profile changes the cache key and fresh
      // also prevents a malformed served value from being handed back.
      var retryReq = moveRequest(review, job, ply, QUICK_FALLBACK, true);
      return ChessyAnalysisService.analyse(retryReq, OWNER).then(function (retry) {
        if (!owns(token, job)) return { stopped: true };
        if (retry === null) return { paused: true };
        var retryChecked = validate(retry, state, retryReq, 2);
        if (!retryChecked.ok) {
          return { unusable: true, reason: retryChecked.reason || checked.reason };
        }
        return {
          result: retry,
          validation: retryChecked,
          profile: 'quick-fallback'
        };
      });
    });
  }

  function nextScannable(review, cursor) {
    var end = review.gs.history.length;
    for (var ply = cursor; ply < end; ply++) {
      if (scannable(review, ply)) return ply;
    }
    return end;
  }

  function runPassOne(review, job, token) {
    if (!owns(token, job)) return Promise.resolve(job);
    var ply = nextScannable(review, job.cursorPly);
    if (ply >= review.gs.history.length) {
      job.shortlist = ChessyMomentSelector.shortlist(job.candidates, 2);
      // A manual deep promotion may predate shortlisting. Pass 2 owns exact
      // admission for selected slots, so restore their canonical quick rows
      // and verify them in order; unrelated manual rows remain authoritative.
      var selected = Object.create(null);
      job.shortlist.forEach(function (candidate) {
        selected[candidate.ply] = true;
      });
      job.deepResults = job.deepResults.filter(function (record) {
        return !selected[record.ply];
      });
      job.moments = job.moments.filter(function (moment) {
        return !selected[moment.ply];
      });
      job.moveSummaries = job.moveSummaries.map(function (summary) {
        return selected[summary.ply]
          ? copyQuickSummary(job.quickSummaries.find(function (quickSummary) {
            return quickSummary.ply === summary.ply;
          })) : summary;
      });
      job.pass = 2;
      job.verifyIndex = 0;
      delete job.error;
      // Persist the pass transition before dispatching expensive deep work.
      return checkpoint(token, job).then(function (saved) {
        return saved ? runPassTwo(review, job, token) : job;
      });
    }

    // Terminal plies are represented by the absolute cursor. The analysed ply
    // is not advanced until a usable or terminally unusable result has been
    // checkpointed.
    job.cursorPly = ply;
    return analyseQuick(review, job, ply, token).then(function (out) {
      if (!owns(token, job) || out.stopped) return job;
      if (out.paused) return pauseAfterNull(token, job);
      if (out.unusable) {
        unresolved(job, ply, 'quick', out.reason);
      } else {
        var record = makeQuickResult(out.result, ply, out.profile);
        var rebuilt = record
          ? rebuildQuickState(record, review, job) : { ok: false };
        if (!rebuilt.ok) {
          unresolved(job, ply, 'quick', 'quick-result-invalid');
        } else {
          replaceSummary(job, rebuilt.summary);
          replaceQuickSummary(job, rebuilt.summary);
          replaceQuickEvidence(job, rebuilt.evidence);
          replaceQuickResult(job, record);
          job.candidates = job.candidates.filter(function (candidate) {
            return candidate.ply !== ply;
          });
          if (rebuilt.candidate) job.candidates.push(rebuilt.candidate);
          job.candidates.sort(function (a, b) { return a.ply - b.ply; });
        }
      }
      job.cursorPly = ply + 1; // cursor always denotes the NEXT absolute ply
      job.checked++;
      delete job.error;
      return checkpoint(token, job).then(function (saved) {
        return saved ? runPassOne(review, job, token) : job;
      });
    });
  }

  function runPassTwo(review, job, token) {
    if (!owns(token, job)) return Promise.resolve(job);
    if (job.verifyIndex >= job.shortlist.length) {
      job.state = 'done';
      job.pass = 2;
      delete job.error;
      running = false;
      return checkpoint(token, job).then(function () { return job; });
    }
    var quick = job.shortlist[job.verifyIndex];
    var ply = quick.ply;
    if (!eligible(review, ply, job.scanColor)) {
      return pauseDeepFailure(
        token, job, ply, 'position-no-longer-eligible');
    }
    var req = moveRequest(review, job, ply, DEEP, false);
    return ChessyAnalysisService.analyse(req, OWNER).then(function (res) {
      if (!owns(token, job)) return job;
      if (res === null) return pauseAfterNull(token, job);
      var record = makeDeepResult(res, ply);
      var rebuilt = record
        ? rebuildDeepState(record, quick, review, job) : { ok: false };
      if (!rebuilt.ok) {
        return pauseDeepFailure(
          token, job, ply, rebuilt.reason || 'deep-result-invalid');
      }
      replaceDeepResult(job, record);
      replaceSummary(job, rebuilt.summary);
      job.unresolved = job.unresolved.filter(function (item) {
        return !(item.phase === 'deep' && item.ply === ply);
      });
      // Replace by ply even if a future caller repeats a verification. A
      // rejected repeat must also remove stale admission for that slot.
      job.moments = job.moments.filter(function (moment) {
        return moment.ply !== ply;
      });
      if (rebuilt.accepted && rebuilt.summary.accepted === true) {
        // Enforce the spoiler boundary even if a future selector regresses.
        job.moments.push({
          ply: rebuilt.accepted.ply,
          playedSan: rebuilt.accepted.playedSan
        });
        job.moments.sort(function (a, b) { return a.ply - b.ply; });
      }
      job.verifyIndex++;
      delete job.error;
      return checkpoint(token, job).then(function (saved) {
        return saved ? runPassTwo(review, job, token) : job;
      });
    });
  }

  function pauseAfterNull(token, job) {
    if (!owns(token, job)) return Promise.resolve(job);
    job.state = 'paused';
    job.error = 'Analysis was interrupted — resume to continue.';
    running = false;
    return checkpoint(token, job).then(function () { return job; });
  }

  function pauseDeepFailure(token, job, ply, reason) {
    if (!owns(token, job)) return Promise.resolve(job);
    job.unresolved = job.unresolved.filter(function (item) {
      return !(item.phase === 'deep' && item.ply === ply);
    });
    unresolved(job, ply, 'deep', reason);
    job.state = 'paused';
    job.error = 'Deep analysis was unusable — resume to retry.';
    running = false;
    return checkpoint(token, job).then(function () { return job; });
  }

  function normalizeLoaded(job, review, scanColor) {
    if (!job || job.schema !== JOB_SCHEMA || job.algorithm !== ALGORITHM ||
        job.gameId !== review.game.id ||
        job.sourceRev !== sourceRevision(review.game, scanColor) ||
        job.analysisRev !== analysisRevision(review.game) ||
        job.scanColor !== scanColor) return null;
    // Schema 3 persists these as integrity mirrors plus their independent,
    // full quick-result authority. Missing/malformed arrays are not migrated.
    if (!Array.isArray(job.candidates) || !Array.isArray(job.shortlist) ||
        !Array.isArray(job.deepResults) ||
        !Array.isArray(job.quickResults) ||
        !Array.isArray(job.quickEvidence) ||
        !Array.isArray(job.quickSummaries)) return null;
    arrays(job);
    function validRef(item) {
      return !!item && typeof item === 'object' &&
        Number.isInteger(item.ply) && item.ply >= 0 &&
        item.ply < review.gs.history.length &&
        scannable(review, item.ply) &&
        typeof item.playedSan === 'string' &&
        item.playedSan === review.gs.history[item.ply].san;
    }
    function validEligibleRef(item) {
      return validRef(item) && eligible(review, item.ply, scanColor);
    }
    var unresolvedCount = job.unresolved.length;
    job.unresolved = job.unresolved.filter(function (item) {
      return !!item && typeof item === 'object' &&
        Number.isInteger(item.ply) && item.ply >= 0 &&
        item.ply < review.gs.history.length &&
        scannable(review, item.ply) &&
        (item.phase === 'quick' || item.phase === 'deep') &&
        typeof item.reason === 'string' && item.reason.length > 0;
    });
    if (job.unresolved.length !== unresolvedCount) return null;
    var normalizedTypicalThinkMs = typicalThinkMsBySide(review, scanColor);
    job.typicalThinkMsBySide = normalizedTypicalThinkMs;
    delete job.typicalThinkMs;
    var seenSummaries = Object.create(null);
    job.moveSummaries = job.moveSummaries.filter(function (summary) {
      if (!summary || seenSummaries[summary.ply] ||
          !validRef(summary) ||
          summary.turn !== review.states[summary.ply].turn) return false;
      var req = moveRequest(
        review, job, summary.ply, profileOf(summary.profile), false);
      var identity = expectedFor(
        review.states[summary.ply], req, true,
        summary.profile === 'deep' ? 3 : 2).identity;
      var ok = ChessyAnalysisNotation.validate(summary, {
        ply: summary.ply,
        playedSan: review.gs.history[summary.ply].san,
        turn: review.states[summary.ply].turn,
        thinkMs: exactThinkMs(review.game, summary.ply),
        typicalThinkMs:
          normalizedTypicalThinkMs[review.states[summary.ply].turn],
        identity: identity
      });
      if (ok) seenSummaries[summary.ply] = true;
      return ok;
    }).sort(function (a, b) { return a.ply - b.ply; });
    var seenQuickSummaries = Object.create(null);
    job.quickSummaries = job.quickSummaries.filter(function (summary) {
      if (!summary || seenQuickSummaries[summary.ply] ||
          !validRef(summary) ||
          (summary.profile !== 'quick' &&
           summary.profile !== 'quick-fallback') ||
          summary.turn !== review.states[summary.ply].turn ||
          !exactKeys(summary, QUICK_SUMMARY_KEYS)) return false;
      var req = moveRequest(
        review, job, summary.ply, profileOf(summary.profile), false);
      var identity = expectedFor(
        review.states[summary.ply], req, true, 2).identity;
      var ok = ChessyAnalysisNotation.validate(summary, {
        ply: summary.ply,
        playedSan: review.gs.history[summary.ply].san,
        turn: review.states[summary.ply].turn,
        thinkMs: exactThinkMs(review.game, summary.ply),
        typicalThinkMs:
          normalizedTypicalThinkMs[review.states[summary.ply].turn],
        identity: identity
      });
      if (ok) seenQuickSummaries[summary.ply] = true;
      return ok;
    }).sort(function (a, b) { return a.ply - b.ply; });

    job.cursorPly = Number.isInteger(job.cursorPly) && job.cursorPly >= 0
      ? Math.min(job.cursorPly, review.gs.history.length) : 0;
    job.total = countScannable(review);
    if (!Number.isInteger(job.checked) || job.checked < 0 ||
        job.checked !== countScannableBefore(review, job.cursorPly)) return null;
    job.pass = job.pass === 2 ? 2 : 1;

    // A quick failure proves only that the previous process could not obtain a
    // usable result. It is never positive coverage for that ply. On restore,
    // retry from the earliest such marker and discard every downstream cache
    // field so an inserted unresolved suffix cannot advance Pass 1 or Pass 2.
    var quickRetryPly = null;
    job.unresolved.forEach(function (item) {
      if (item.phase !== 'quick') return;
      if (quickRetryPly === null || item.ply < quickRetryPly) {
        quickRetryPly = item.ply;
      }
    });
    if (quickRetryPly !== null) {
      quickRetryPly = Math.min(job.cursorPly, quickRetryPly);
      function beforeRetry(item) {
        return !!item && Number.isInteger(item.ply) &&
          item.ply < quickRetryPly;
      }
      job.quickResults = job.quickResults.filter(beforeRetry);
      job.deepResults = [];
      job.quickEvidence = job.quickEvidence.filter(beforeRetry);
      job.quickSummaries = job.quickSummaries.filter(beforeRetry);
      job.candidates = job.candidates.filter(beforeRetry);
      job.cursorPly = quickRetryPly;
      job.checked = countScannableBefore(review, quickRetryPly);
      job.pass = 1;
      job.verifyIndex = 0;
      job.shortlist = [];
      job.moments = [];
      job.unresolved = [];
      job.moveSummaries = job.quickSummaries.map(copyQuickSummary);
      job.state = 'paused';
      delete job.retry;
      delete job.error;
    }

    var storedCandidates = job.candidates;
    var storedShortlist = job.shortlist;

    // Rebuild every compact/selector field from full quick results which pass
    // the production replay/provenance validator. Persisted summaries,
    // evidence, candidates and shortlist are comparison mirrors only.
    var resultByPly = Object.create(null);
    var evidenceByPly = Object.create(null);
    var quickSummaryByPly = Object.create(null);
    var canonicalCandidates = [];
    function persistedPly(item) {
      return item && typeof item === 'object' && Number.isInteger(item.ply)
        ? item.ply : -1;
    }
    job.quickEvidence.sort(function (a, b) {
      return persistedPly(a) - persistedPly(b);
    });
    job.quickSummaries.sort(function (a, b) {
      return persistedPly(a) - persistedPly(b);
    });
    for (var mirrorIndex = 0;
         mirrorIndex < job.quickEvidence.length; mirrorIndex++) {
      var mirrorEvidence = job.quickEvidence[mirrorIndex];
      if (!mirrorEvidence || evidenceByPly[mirrorEvidence.ply]) return null;
      evidenceByPly[mirrorEvidence.ply] = mirrorEvidence;
    }
    for (var quickSummaryIndex = 0;
         quickSummaryIndex < job.quickSummaries.length; quickSummaryIndex++) {
      var quickSummary = job.quickSummaries[quickSummaryIndex];
      if (!quickSummary || quickSummaryByPly[quickSummary.ply]) return null;
      quickSummaryByPly[quickSummary.ply] = quickSummary;
    }
    job.quickResults.sort(function (a, b) {
      return persistedPly(a) - persistedPly(b);
    });
    for (var resultIndex = 0;
         resultIndex < job.quickResults.length; resultIndex++) {
      var record = job.quickResults[resultIndex];
      if (!record || resultByPly[record.ply] ||
          record.ply >= job.cursorPly) return null;
      var rebuilt = rebuildQuickState(record, review, job);
      if (!rebuilt.ok) return null;
      // Persist the allowlisted snapshot on the next checkpoint as well, so
      // harmless validator-ignored fields injected into cache state are
      // scrubbed rather than carried forward indefinitely.
      record.result = rebuilt.result;
      var matchingEvidence = evidenceByPly[record.ply];
      var matchingQuickSummary = quickSummaryByPly[record.ply];
      if (!matchingEvidence || !matchingQuickSummary ||
          !sameQuickEvidence(
            matchingEvidence, rebuilt.summary, rebuilt.evidence) ||
          !sameSummaryEvidence(rebuilt.evidence, matchingQuickSummary)) {
        return null;
      }
      var matchingSummary = summaryAt(job, record.ply);
      if (!matchingSummary) return null;
      if ((matchingSummary.profile === 'quick' ||
           matchingSummary.profile === 'quick-fallback') &&
          !sameSummaryEvidence(rebuilt.evidence, matchingSummary)) return null;
      resultByPly[record.ply] = record;
      if (rebuilt.candidate) canonicalCandidates.push(rebuilt.candidate);
    }
    for (var completedPly = 0;
         completedPly < job.cursorPly; completedPly++) {
      if (!scannable(review, completedPly)) continue;
      if (!resultByPly[completedPly]) return null;
    }
    if (job.quickResults.length !== job.quickEvidence.length ||
        job.quickResults.length !== job.quickSummaries.length) return null;
    if (!sameCandidateList(storedCandidates, canonicalCandidates)) return null;
    var canonicalShortlist = job.pass === 2
      ? ChessyMomentSelector.shortlist(canonicalCandidates, 2) : [];
    if (!sameCandidateList(storedShortlist, canonicalShortlist)) return null;
    job.candidates = canonicalCandidates;
    job.shortlist = canonicalShortlist;

    if (!Number.isInteger(job.verifyIndex) || job.verifyIndex < 0 ||
        job.verifyIndex > job.shortlist.length) return null;
    var shortlistIndexByPly = Object.create(null);
    job.shortlist.forEach(function (candidate, index) {
      shortlistIndexByPly[candidate.ply] = index;
    });

    // A persisted deep failure is no more authoritative than a quick one. It
    // marks the earliest slot which must be retried; it cannot complete a
    // prefix, suppress a suggestion, or reach the zero-suggestion gate.
    var deepRetryIndex = null;
    var invalidDeepFailure = false;
    job.unresolved.forEach(function (item) {
      if (item.phase !== 'deep') return;
      var index = shortlistIndexByPly[item.ply];
      if (job.pass !== 2 || !Number.isInteger(index)) {
        invalidDeepFailure = true;
        return;
      }
      if (deepRetryIndex === null || index < deepRetryIndex) {
        deepRetryIndex = index;
      }
    });
    if (invalidDeepFailure) return null;
    if (deepRetryIndex !== null) {
      deepRetryIndex = Math.min(job.verifyIndex, deepRetryIndex);
      var retryPly = Object.create(null);
      for (var retryIndex = deepRetryIndex;
           retryIndex < job.shortlist.length; retryIndex++) {
        retryPly[job.shortlist[retryIndex].ply] = true;
      }
      job.deepResults = job.deepResults.filter(function (record) {
        var index = record && typeof record === 'object'
          ? shortlistIndexByPly[record.ply] : null;
        return Number.isInteger(index) ? index < deepRetryIndex :
          !!record && typeof record === 'object' &&
            Number.isInteger(record.ply) && index === undefined;
      });
      job.moveSummaries = job.moveSummaries.filter(function (summary) {
        return !retryPly[summary.ply];
      });
      for (var restoreIndex = deepRetryIndex;
           restoreIndex < job.shortlist.length; restoreIndex++) {
        var restorePly = job.shortlist[restoreIndex].ply;
        var restoreSummary = quickSummaryByPly[restorePly];
        if (!restoreSummary) return null;
        job.moveSummaries.push(copyQuickSummary(restoreSummary));
      }
      job.moveSummaries.sort(function (a, b) { return a.ply - b.ply; });
      job.moments = job.moments.filter(function (moment) {
        return !retryPly[moment.ply];
      });
      job.verifyIndex = deepRetryIndex;
      job.unresolved = [];
      job.state = 'paused';
      delete job.retry;
      delete job.error;
    }

    var deepByPly = Object.create(null);
    var expectedMoments = [];
    function persistedPlyForDeep(item) {
      return item && typeof item === 'object' && Number.isInteger(item.ply)
        ? item.ply : -1;
    }
    job.deepResults.sort(function (a, b) {
      return persistedPlyForDeep(a) - persistedPlyForDeep(b);
    });
    for (var deepIndex = 0;
         deepIndex < job.deepResults.length; deepIndex++) {
      var deepRecord = job.deepResults[deepIndex];
      var completedIndex = deepRecord && typeof deepRecord === 'object'
        ? shortlistIndexByPly[deepRecord.ply] : null;
      if (!deepRecord || typeof deepRecord !== 'object' ||
          deepByPly[deepRecord.ply]) return null;
      var rebuiltDeep;
      if (Number.isInteger(completedIndex)) {
        if (completedIndex >= job.verifyIndex) return null;
        rebuiltDeep = rebuildDeepState(
          deepRecord, job.shortlist[completedIndex], review, job);
      } else {
        rebuiltDeep = rebuildManualDeepState(deepRecord, review, job);
      }
      if (!rebuiltDeep.ok) return null;
      deepRecord.result = rebuiltDeep.result;
      var deepSummary = summaryAt(job, deepRecord.ply);
      if (!deepSummary ||
          !sameSummaryEvidence(rebuiltDeep.summary, deepSummary)) return null;
      deepByPly[deepRecord.ply] = deepRecord;
      if (Number.isInteger(completedIndex) && rebuiltDeep.accepted) {
        expectedMoments.push({
          ply: rebuiltDeep.accepted.ply,
          playedSan: rebuiltDeep.accepted.playedSan
        });
      }
    }
    for (var completedIndex = 0;
         completedIndex < job.verifyIndex; completedIndex++) {
      if (!deepByPly[job.shortlist[completedIndex].ply]) return null;
    }
    for (var suffixIndex = job.verifyIndex;
         suffixIndex < job.shortlist.length; suffixIndex++) {
      var suffixSummary = summaryAt(job, job.shortlist[suffixIndex].ply);
      if (suffixSummary && suffixSummary.profile === 'deep') return null;
    }
    var deepSummaryCount = job.moveSummaries.filter(function (summary) {
      return summary.profile === 'deep';
    }).length;
    if (job.deepResults.length !== deepSummaryCount ||
        job.unresolved.length !== 0) return null;
    if (job.moveSummaries.some(function (summary) {
      return summary.profile === 'deep' && !deepByPly[summary.ply];
    })) return null;

    // Moments are an exact integrity mirror, not a filterable cache hint.
    // Duplicate or malformed rows must restart instead of being silently
    // collapsed into a seemingly canonical coaching requirement.
    var seenMoments = Object.create(null);
    if (job.moments.length > 2 || job.moments.some(function (m) {
      if (!exactKeys(m, ['playedSan', 'ply']) ||
          !validEligibleRef(m) || seenMoments[m.ply]) return true;
      seenMoments[m.ply] = true;
      return false;
    })) return null;
    // Selector admission is represented redundantly on purpose: the summary
    // controls punctuation, while moments controls coaching links and Gate 0.
    // They must agree exactly, and every admitted moment must have originated
    // from the durable pass-two shortlist. Coordinated cache corruption must
    // restart recomputable work rather than mint a Chessy annotation.
    if (job.moments.some(function (moment) {
      return !job.shortlist.some(function (quick) {
        return quick.ply === moment.ply &&
          quick.playedSan === moment.playedSan &&
          quick.turn === review.states[moment.ply].turn;
      });
    })) return null;
    var admitted = Object.create(null);
    job.moments.forEach(function (moment) { admitted[moment.ply] = true; });
    if (job.moveSummaries.some(function (summary) {
      return summary.accepted !== !!admitted[summary.ply];
    })) return null;
    // A required suggestion without its exact trusted deep summary can never
    // receive a reveal receipt. Restart this recomputable job instead of
    // persisting a permanently locked or partially migrated report.
    if (job.moments.some(function (moment) {
      var summary = summaryAt(job, moment.ply);
      return !summary || summary.profile !== 'deep' ||
        summary.accepted !== true ||
        !summary.stability ||
        summary.stability.bestMoveStable !== true;
    })) return null;
    // Never upgrade a legacy cache row into receipt authority.
    delete job.reflected;
    if (job.moments.length !== expectedMoments.length ||
        job.moments.some(function (moment, index) {
          return moment.ply !== expectedMoments[index].ply ||
            moment.playedSan !== expectedMoments[index].playedSan;
        })) return null;
    if (job.state === 'running') job.state = 'paused'; // stale process ownership
    if (job.state !== 'done' && job.state !== 'paused' &&
        job.state !== 'idle') job.state = 'paused';
    if (job.state === 'done' &&
        (job.pass !== 2 || job.verifyIndex < job.shortlist.length)) {
      job.state = 'paused';
    }
    if (job.pass === 2 &&
        (job.cursorPly !== review.gs.history.length ||
         job.checked !== job.total)) return null;
    return job;
  }

  function freshJob(review, scanColor) {
    return {
      schema: JOB_SCHEMA,
      algorithm: ALGORITHM,
      gameId: review.game.id,
      sourceRev: sourceRevision(review.game, scanColor),
      analysisRev: analysisRevision(review.game),
      scanColor: scanColor,
      state: 'idle',
      pass: 1,
      cursorPly: 0,
      checked: 0,
      total: countScannable(review),
      candidates: [],
      shortlist: [],
      verifyIndex: 0,
      moments: [],
      unresolved: [],
      moveSummaries: [],
      deepResults: [],
      quickResults: [],
      quickEvidence: [],
      quickSummaries: [],
      typicalThinkMsBySide: typicalThinkMsBySide(review, scanColor),
      updatedAt: now()
    };
  }

  function prepare(review, opts) {
    opts = opts || {};
    if (!review || !review.game || !review.gs || !Array.isArray(review.gs.history) ||
        !Array.isArray(review.states) || !Array.isArray(review.fens)) {
      return Promise.reject(new Error('an open, replayed game is required'));
    }
    stopLocal();
    current = null;
    currentSource = null;
    currentReflections = [];
    var token = generation;
    // A restart discards prior WORK, but an imported game may still need the
    // explicit White/Black/Both choice saved with that work. Read only for a
    // normal resume/load or when restart has no known/explicit side; known-side
    // games and explicit restart choices do not acquire a needless read
    // dependency.
    var needsStoredChoice = !scanColorFor(review.game, opts.scanColor);
    var shouldRead = !opts.restart || needsStoredChoice;
    var getJob = global.CoachStore && CoachStore.getJob && shouldRead
      ? Promise.resolve(CoachStore.getJob(review.game.id)) : Promise.resolve(null);
    var receiptReadEpoch = reflectionEpoch;
    var getReceipts = readReceipts(review);
    return Promise.all([getJob, getReceipts]).then(function (loaded) {
      var stored = loaded[0];
      if (token !== generation) return null;
      return settleReceiptRead(review, loaded[1], receiptReadEpoch)
        .then(function (receipts) {
          if (token !== generation) return null;
          // An imported game has no known owner. The explicit first-run choice
          // is stored on the job and remains the choice on reload/resume; do
          // not make the player answer again, and never silently default.
          var priorChoice = stored &&
            (stored.scanColor === 'w' || stored.scanColor === 'b' ||
             stored.scanColor === 'both') ? stored.scanColor : null;
          var scanColor = scanColorFor(
            review.game,
            opts.scanColor !== undefined ? opts.scanColor : priorChoice);
          if (!scanColor) {
            throw new Error(
              'choose White, Black or both before scanning this game');
          }
          var job = opts.restart ? null :
            normalizeLoaded(stored, review, scanColor);
          if (!job) job = freshJob(review, scanColor);
          currentSource = sourceSnapshot(review.game);
          current = job;
          currentReflections = receiptRows(receipts);
          emit(job);
          // A synchronous scanchange listener (or a microtask queued by it)
          // may pause/navigate before start() receives this prepared job.
          return { job: job, token: token };
        });
    });
  }

  // Start or resume only on explicit UI action. restart discards all previous
  // scan work for this game; otherwise a matching durable checkpoint resumes.
  function start(review, opts) {
    opts = opts || {};
    return prepare(review, opts).then(function (prepared) {
      if (!prepared || prepared.token !== generation ||
          current !== prepared.job) return null;
      var job = prepared.job;
      if (job.state === 'done' && !opts.restart) return publicState(job);
      job.state = 'running';
      delete job.error;
      running = true;
      var token = generation;
      return checkpoint(token, job).then(function (saved) {
        if (!saved) return current === job ? job : null;
        return job.pass === 2 ? runPassTwo(review, job, token)
          : runPassOne(review, job, token);
      }).then(function () {
        return current === job ? publicState(job) : null;
      });
    });
  }

  function resume(review, opts) {
    opts = Object.assign({}, opts || {}, { restart: false });
    return start(review, opts);
  }

  function pause() {
    var job = current;
    generation++;
    var wasRunning = running;
    running = false;
    try { ChessyAnalysisService.cancel(OWNER); } catch (e) { /* best effort */ }
    // Invalidating the generation is required even while prepare() is awaiting
    // a durable getJob(): at that point there is deliberately no current job
    // and no running request yet, but navigation/pause must still prevent the
    // pending start from later acquiring ownership.
    if (!job || !wasRunning) return Promise.resolve(publicState(job));
    job.state = 'paused';
    job.error = null;
    var token = generation;
    // This explicit checkpoint has the new ownership token. The abandoned
    // analysis continuation still carries the old token and is inert.
    return checkpoint(token, job).then(function () { return publicState(current); });
  }

  /*
   * Durably bind one canonical structured Calculation value to this exact
   * archived source and ply. Store replay validation is the only path that can
   * add Gate-0 authority; cache/job fields and lesson cards are ignored.
   */
  function recordReflection(review, ply, calculation) {
    if (!review || !review.game || !Number.isInteger(ply) ||
        !review.gs || !Array.isArray(review.gs.history) ||
        ply < 0 || ply >= review.gs.history.length ||
        !scannable(review, ply)) return Promise.resolve(false);
    if (!global.CoachStore ||
        typeof CoachStore.putReflectionReceipt !== 'function') {
      return Promise.resolve(false);
    }
    return Promise.resolve(CoachStore.putReflectionReceipt(
      review.game, ply, calculation)).then(function (stored) {
      if (!stored) return false;
      reflectionEpoch++;
      var token = generation;
      // Re-read the committed record instead of manufacturing an in-memory
      // tuple from 32-bit revision hashes. This also observes a revision or
      // retraction that serialized immediately after the receipt write.
      return readReceipts(review).then(function (receipts) {
        var job = current;
        if (token !== generation || !job ||
            job.gameId !== review.game.id ||
            !sameReflectionSource(currentSource, review.game) ||
            job.sourceRev !== sourceRevision(review.game, job.scanColor)) {
          return true;
        }
        currentReflections = receiptRows(receipts);
        emit(job);
        return true;
      }, function () { return true; });
    }, function () { return false; });
  }

  /*
   * A successful manual Verify uses the exact same deep profile. Revalidate it
   * inside the controller, then promote a quick ledger row to a deep score.
   * Only a ply admitted by the scan selector inherits accepted-moment
   * punctuation; a manually chosen row gains depth, never an invented NAG.
   */
  function recordVerifiedSummary(review, ply, result) {
    var job = current;
    if (!job || !review || review.game.id !== job.gameId ||
        job.sourceRev !== sourceRevision(review.game, job.scanColor) ||
        job.analysisRev !== analysisRevision(review.game) ||
        !Number.isInteger(ply) ||
        !scannable(review, ply)) return Promise.resolve(false);
    var state = review.states[ply];
    var req = moveRequest(review, job, ply, DEEP, false);
    var checked = validate(result, state, req, 3);
    if (!checked.ok) return Promise.resolve(false);
    var shortlistIndex = job.shortlist.findIndex(function (candidate) {
      return candidate.ply === ply;
    });
    if (shortlistIndex >= 0) {
      var fillsRetry = shortlistIndex === job.verifyIndex &&
        job.unresolved.some(function (item) {
          return item.phase === 'deep' && item.ply === ply;
        });
      if (shortlistIndex > job.verifyIndex ||
          (shortlistIndex === job.verifyIndex && !fillsRetry)) {
        return Promise.resolve(false);
      }
      var record = makeDeepResult(result, ply);
      var rebuilt = record ? rebuildDeepState(
        record, job.shortlist[shortlistIndex], review, job) : { ok: false };
      if (!rebuilt.ok) return Promise.resolve(false);
      replaceDeepResult(job, record);
      replaceSummary(job, rebuilt.summary);
      job.moments = job.moments.filter(function (moment) {
        return moment.ply !== ply;
      });
      if (rebuilt.accepted) {
        job.moments.push({
          ply: rebuilt.accepted.ply,
          playedSan: rebuilt.accepted.playedSan
        });
        job.moments.sort(function (a, b) { return a.ply - b.ply; });
      }
      job.unresolved = job.unresolved.filter(function (item) {
        return !(item.phase === 'deep' && item.ply === ply);
      });
      if (fillsRetry) job.verifyIndex++;
      var scanToken = generation;
      return checkpoint(scanToken, job);
    }
    var manualRecord = makeDeepResult(result, ply);
    var manualRebuilt = manualRecord
      ? rebuildManualDeepState(manualRecord, review, job) : { ok: false };
    if (!manualRebuilt.ok) return Promise.resolve(false);
    replaceDeepResult(job, manualRecord);
    replaceSummary(job, manualRebuilt.summary);
    var token = generation;
    return checkpoint(token, job);
  }

  // Synchronous generation invalidation for destructive operations. It
  // intentionally performs NO write: Restore/Delete all own the database
  // transaction and clear jobs atomically.
  function invalidate() {
    stopLocal();
    current = null;
    currentSource = null;
    currentReflections = [];
    emit(null);
  }

  function load(review, opts) {
    return prepare(review, opts || {}).then(function (prepared) {
      if (!prepared || prepared.token !== generation ||
          current !== prepared.job) return null;
      var job = prepared.job;
      // A stale persisted "running" state was normalized above. Persist that
      // pause so the same record is honest to every future reader.
      var token = generation;
      return checkpoint(token, job).then(function () { return publicState(current); });
    });
  }

  function state() { return publicState(current); }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('chessy:archivecleared', invalidate);
    document.addEventListener('chessy:reflectionsourceinvalidated', function (e) {
      reflectionEpoch++;
      var gameId = e && e.detail && e.detail.gameId;
      if (!current || current.gameId !== gameId) return;
      stopLocal();
      current = null;
      currentSource = null;
      currentReflections = [];
      emit(null);
    });
    document.addEventListener('chessy:reviewrender', function () {
      if (global.CoachReview && !CoachReview.current()) pause();
    });
    document.addEventListener('chessy:viewchange', function () {
      if (document.body && document.body.dataset.view !== 'review') pause();
    });
  }

  global.ChessyMomentScan = {
    start: start,
    resume: resume,
    pause: pause,
    recordReflection: recordReflection,
    recordVerifiedSummary: recordVerifiedSummary,
    invalidate: invalidate,
    load: load,
    state: state,
    analysisRevision: analysisRevision,
    sourceRevision: sourceRevision,
    profiles: {
      quick: Object.assign({}, QUICK),
      quickFallback: Object.assign({}, QUICK_FALLBACK),
      deep: Object.assign({}, DEEP)
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
