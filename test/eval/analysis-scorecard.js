/*
 * eval-v1 ANALYSIS scorecard (E3 slice) — run with:
 *   node test/eval/analysis-scorecard.js            # frozen E3 shard (CI default)
 *   node test/eval/analysis-scorecard.js --full     # the whole committed corpus
 *   node test/eval/analysis-scorecard.js --json      # machine-readable score vector
 *   node test/eval/analysis-scorecard.js --out f.json           # write the score vector
 *   node test/eval/analysis-scorecard.js --baseline b.json       # before/after vs a prior run
 *   node test/eval/analysis-scorecard.js --self-test             # prove the gate has teeth
 *
 * PUBLISH A SCORE VECTOR, NOT ONE HEADLINE NUMBER. Where the correctness
 * scorecard (test/eval/scorecard.js, the E2 slice) asks *"is the engine's
 * output legal and deterministic?"*, this E3 runner asks *"is the analysis /
 * coaching output GOOD?"* — on the same frozen, license-clean corpus:
 *
 *   STRICT (output contracts, version-independent — gate at 100%):
 *     rootComplete    the whole result passes the shipped
 *                     ChessyAnalysisResult.validate, and bestLines covers
 *                     EVERY legal root (a true MultiPV, not a shortlist)
 *     playedRank      the coaching played-move accounting is self-consistent:
 *                     reported rank equals the true rank over all roots, and
 *                     classification matches that rank at the shipped
 *                     candidate width (equivalent-move recognition)
 *
 *   QUALITY (ratchet from --baseline: may improve, may never regress):
 *     puzzleTop1      the crowd-validated CC0 Lichess key move is the
 *                     engine's #1 line (acceptable top-1 / solve rate)
 *     puzzleRecall3   the key move is within the top 3 (oracle best recall@3)
 *     pvStability     best move unchanged one ply shallower — measured here,
 *                     never read off the engine's own stability flag
 *     budgetStability best line unchanged at ¼× the scan budget (--full adds
 *                     the 4× tier); a tier is graded only if the shipped
 *                     validator accepts its result — an unusable tier is a
 *                     miss and a catastrophic regret, never a skip
 *     regret          median / p90 (/ p99 in --full) centipawn regret of the
 *                     QUICK-scan pick re-scored at full depth, plus a
 *                     catastrophic-miss count ("final precision")
 *
 * Oracle comparisons deliberately AVOID exact centipawn/PV equality (per the
 * tracker): acceptable-move sets, set overlap, budget invariance and a regret
 * tail distribution — never a single Elo number. The only external oracle is
 * the CC0 Lichess puzzle key move, so the run stays offline and needs no GPL
 * engine. Determinism (proven by the E2 scorecard) makes every number here
 * bit-reproducible in CI, so the ratchet is exact — no tolerance band.
 *
 * GATE: strict axes fail the build on any miss; quality axes fail on any
 * regression vs a committed baseline (--baseline).
 *
 * Development/build-time tool (uses node:crypto for the corpus integrity
 * check); never loaded by the browser app.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('../../assets/engine.js');
require('../../assets/ai.js');
require('../../assets/analysis-core.js');
// The SHIPPED trust boundary. The strict axes delegate whole-object validation
// to it rather than restating any part of it, so this gate can never be laxer
// than the coaching path consuming the same output — if the app tightens the
// invariant, the gate tightens with it instead of silently drifting apart.
require('../../assets/analysis-result.js');
const Chess = globalThis.Chess;
const AC = globalThis.ChessyAnalysisCore;
const AR = globalThis.ChessyAnalysisResult;
// Used to derive the depth-(d-1) best move INDEPENDENTLY for pvStability.
const ChessAI = globalThis.ChessAI;

const CORPUS_DIR = path.join(__dirname, '..', '..', 'eval', 'corpus');

// ---------------------------------------------------------------------------
// E3 analysis configuration. All budgets are node-count knobs so the sweep is
// deterministic and machine-independent (never wall-clock). The `ref` pass sets
// multiPV wide enough to score EVERY legal root — analyse() scores all roots
// internally regardless of multiPV, so a wide multiPV only widens the returned
// list. `ship` mirrors the shipped coaching width (reflection.js CFG.multiPV
// = 3) so the classification axis tests the real candidate-set boundary.
// `quarter`/`quad` are the ¼×/4× scan tiers for the budget-stability sweep;
// they read only the best move so they stay cheap. Baked into the score vector
// so a config drift can never compare "clean" against a baseline built under a
// different budget.
// ---------------------------------------------------------------------------
const E3_OPTS = {
  ref:     { nodeLimit: 2000, nodeBudget: 2000000, multiPV: 999, pvLen: 4, quiesce: true },
  ship:    { nodeLimit: 2000, nodeBudget: 2000000, multiPV: 3,   pvLen: 4, quiesce: true },
  quarter: { nodeLimit: 500,  nodeBudget: 2000000, multiPV: 1,   pvLen: 1, quiesce: true },
  quad:    { nodeLimit: 8000, nodeBudget: 2000000, multiPV: 1,   pvLen: 1, quiesce: true }
};
// A mate is worth more than any material score; convert it to a large, ply-
// discounted centipawn value so regret over a mixed mate/eval field is ordered
// correctly. Per-case regret is then capped at CATASTROPHIC_CP so a single
// mate-miss registers as one catastrophic blunder rather than swamping the
// median/p90 with a million-cp spike.
const MATE_CP = 1000000;
const CATASTROPHIC_CP = 1000;

// ---------------------------------------------------------------------------
// shared helpers (kept in step with scorecard.js / gen-corpus.js)
// ---------------------------------------------------------------------------
function sha256(str) { return crypto.createHash('sha256').update(str, 'utf8').digest('hex'); }
function uciOf(m) { return Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promotion ? m.promotion.toLowerCase() : ''); }
function lf(s) { return s.replace(/\r\n/g, '\n'); }
function stateOf(rec) {
  // Build from the FROZEN, hash-verified fen (same rule as the E2 scorecard);
  // only history-only fixtures fall back to replay.
  return rec.fen ? Chess.newGameState(rec.fen) : Chess.replaySans(rec.move_history);
}
function loadCorpus() {
  const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'manifest.json'), 'utf8'));
  const raw = lf(fs.readFileSync(path.join(CORPUS_DIR, manifest.ndjson), 'utf8'));
  if (sha256(raw) !== manifest.ndjson_sha256) {
    throw new Error('corpus integrity check FAILED: ' + manifest.ndjson +
      ' sha256 does not match manifest — regenerate with test/eval/gen-corpus.js');
  }
  const records = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { manifest, records };
}

// Player-POV magnitude of a reported line, mate-aware, for ordering and regret.
// analyse() reports scores from the side-to-move's perspective (higher is
// better); a mate FOR the player beats every eval, a mate AGAINST is worse than
// every eval, both discounted by distance so a faster mate outranks a slower one.
function orderVal(line, turn) {
  if (line.mate) {
    const playerMates = line.mate.forWhite === (turn === 'w');
    return (playerMates ? 1 : -1) * (MATE_CP - line.mate.inPlies);
  }
  return line.scoreCpPlayer;
}

// Fault injection for --self-test. Every analyse() in this runner goes through
// here. Each fault simulates a distinct shape of ENGINE regression — never a
// corpus-label edit: the strict axes grade the engine's self-consistency, so a
// swapped-but-legal key move would still rank correctly and rightly stay green.
let FAULT = null;
function analyse(state, opts) {
  const res = AC.analyse(state, opts);
  // Truncation vs emptiness exercise different code paths: an empty MultiPV on
  // a live position must be SCORED as a failure, never skipped, or a regression
  // that empties the output would pass with zero strict checks.
  if (FAULT === 'truncate-multipv' && res.bestLines.length > 1) {
    res.bestLines = res.bestLines.slice(0, 1);
  }
  if (FAULT === 'empty-multipv') res.bestLines = [];
  // A non-finite score makes every `>` comparison false, so it silently defeats
  // both the ordering check and the regret ratchet unless finiteness is tested.
  if (FAULT === 'strip-scores') {
    for (const l of res.bestLines) if (!l.mate) delete l.scoreCpPlayer;
  }
  // Well-shaped and finite, but violating the shipped validMate contract
  // (inPlies must be a positive integer).
  if (FAULT === 'zero-mate') {
    for (const l of res.bestLines) if (l.mate) l.mate.inPlies = 0;
    if (res.mate) res.mate.inPlies = 0;
  }
  // Representation violations that leave every number intact and plausible:
  // `mate` must be explicitly null (not absent), and the White/player centipawn
  // pair must agree. Both are rejected by the shipped validEval.
  if (FAULT === 'absent-mate') {
    for (const l of res.bestLines) if (!l.mate) delete l.mate;
  }
  if (FAULT === 'skew-white') {
    for (const l of res.bestLines) if (!l.mate) l.scoreCpWhite = l.scoreCpWhite + 250;
  }
  // Line-level corruption with a pristine evaluation and a legally-replaying
  // pvUci — only a whole-line resolve catches a bogus SAN or a `move` object
  // disagreeing with its own UCI.
  if (FAULT === 'bad-san') {
    for (const l of res.bestLines) { l.pv = l.pv.map(() => 'Zz9'); l.san = 'Zz9'; }
  }
  if (FAULT === 'skew-move') {
    for (const l of res.bestLines) l.move = { from: 0, to: 1, promotion: null };
  }
  // Result-level corruption outside the per-line data: the headline score
  // desynchronized from bestLines[0], a stability pair not matching the
  // reported depth, broken engine provenance.
  if (FAULT === 'top-eval-skew' && res.scoreCpWhite !== null) {
    res.scoreCpWhite += 100; res.scoreCpPlayer += 100;
  }
  if (FAULT === 'stability-depths' && res.stability) res.stability.depths = [1, 1];
  if (FAULT === 'tamper-provenance') res.engine.version = 'tampered';
  // `complete` must be exactly `true`, not merely truthy.
  if (FAULT === 'complete-truthy') res.complete = 'yes';
  // Corruption confined to the PLAYED line, which only the shipped-width pass
  // produces — the axis that grades coaching output must validate its own
  // result, not lean on the reference pass having been checked.
  if (FAULT === 'played-san' && res.playedLine) {
    res.playedLine.san = 'Zz9';
    if (res.playedLine.pv) res.playedLine.pv[0] = 'Zz9';
  }
  // An auxiliary (¼×/4×) tier that exhausts its budget returns complete:false
  // with a partial line list. Grading it as signal would score garbage — a
  // partial pick that happens to match the reference would even count as
  // stable. This fault never touches the graded ref/ship results, so it cannot
  // turn the STRICT gate red; it must instead be fully visible to the ratchet.
  if (FAULT === 'incomplete-aux' && (opts === E3_OPTS.quarter || opts === E3_OPTS.quad)) {
    res.complete = false;
  }
  // A flattering self-report moves a QUALITY number UP, and the ratchet only
  // fails on a falling number — so pvStability must be IMMUNE to this fault
  // (unmoved), which it can only be by measuring the behaviour itself.
  if (FAULT === 'liar-stability' && res.stability) res.stability.bestMoveStable = true;
  return res;
}
function isLive(rec) { return !(rec.assert && rec.assert.terminal); }
function isPuzzle(rec) { return rec.expected_moves && rec.expected_moves.length > 0; }
// The frozen E3 PR shard: every shard puzzle (all five difficulty bands) plus
// the core, live generated fixtures. Small enough for a per-PR run, stratified
// enough to move when analysis quality moves. --full analyses every live case.
function inE3Shard(rec) { return rec.shard && isLive(rec) && (isPuzzle(rec) || rec.core); }

// ---------------------------------------------------------------------------
// per-axis checks. Fraction axes return {ok} results; the regret axis feeds a
// separate distribution accumulator.
// ---------------------------------------------------------------------------
// STRICT: the ENTIRE result must satisfy the SHIPPED contract. Everything the
// app itself demands is delegated WHOLESALE to `ChessyAnalysisResult.validate`
// — provenance, turn, `complete`, depth/nodes/elapsed, `stability.depths`, the
// top-level evaluation and its agreement with `bestLines[0]`, then per line the
// evaluation, a full `resolveLine`, duplicate detection and player-POV
// ordering, plus the whole played-line contract. The expected identity comes
// from `ChessyAnalysisCore.identity(state, opts)`, so provenance is checked
// against an independent derivation rather than the result vouching for
// itself. Reuse the invariant, never paraphrase it — a paraphrase (even of
// part of a contract) drifts laxer than the code consuming the same output.
// E3 adds exactly one requirement of its own.
function checkRootComplete(state, ref, opts) {
  const verdict = AR.validate(ref, state, AC.identity(state, opts));
  if (!verdict.ok) {
    return { ok: false, detail: 'analysis result rejected by the shipped validator: ' + verdict.reason };
  }
  // The E3-SPECIFIC addition: the app tolerates a shortlist, this scorecard does
  // not. `bestLines` must cover EVERY legal root — that is what makes it a true
  // MultiPV and what the whole position-quality vector is computed over.
  const legal = Chess.legalMoves(state);
  if (ref.bestLines.length !== legal.length) {
    return { ok: false, detail: 'MultiPV covered ' + ref.bestLines.length + ' of ' + legal.length +
      ' legal roots (not a full MultiPV)' };
  }
  return { ok: true, detail: legal.length + ' roots, shipped-validator clean' };
}

// STRICT: the coaching played-move accounting is self-consistent. Feed the
// crowd-validated key move as the "played" move at the SHIPPED candidate width
// and confirm its reported rank equals its true rank over all roots, and that
// classification matches that rank + the candidate width.
function checkPlayedRank(rec, state, ref) {
  const key = rec.expected_moves[0];
  const played = Chess.legalMoves(state).find(m => uciOf(m) === key);
  if (!played) return { ok: false, detail: 'labelled key move ' + key + ' is not legal (corrupt fixture)' };
  const shipMultiPV = E3_OPTS.ship.multiPV;
  const shipOpts = Object.assign({ playedMove: played }, E3_OPTS.ship);
  const res = analyse(state, shipOpts);
  // The SHIPPED contract first, on the shipped-width result: this covers the
  // played-line rank/amongCandidates/classification derivation, that the played
  // line matches its candidate line exactly, and that the played move resolves
  // to the move we actually asked about (`playedMove` + `requirePlayed`).
  const expected = Object.assign({}, AC.identity(state, shipOpts),
    { playedMove: played, requirePlayed: true });
  const verdict = AR.validate(res, state, expected);
  if (!verdict.ok) {
    return { ok: false, detail: 'shipped-width result rejected by the shipped validator: ' + verdict.reason };
  }
  const pl = res.playedLine;
  if (!pl) return { ok: false, detail: 'played key move ' + key + ' was not ranked (playedLine null)' };
  // True rank of the key move over ALL roots (the ref pass scored every one).
  const trueRank = ref.bestLines.findIndex(l => l.uci === key) + 1;
  if (pl.rank !== trueRank) return { ok: false, detail: 'reported rank ' + pl.rank + ' != true rank ' + trueRank };
  const wantCandidate = trueRank <= shipMultiPV;
  if (pl.amongCandidates !== wantCandidate) {
    return { ok: false, detail: 'amongCandidates=' + pl.amongCandidates + ' but rank ' + trueRank + ' vs width ' + shipMultiPV };
  }
  const wantCls = trueRank === 1 ? 'same' : (wantCandidate ? 'different-candidate' : 'unknown-equivalence');
  if (res.classification !== wantCls) {
    return { ok: false, detail: 'classification ' + res.classification + ' != ' + wantCls + ' (rank ' + trueRank + ')' };
  }
  return { ok: true, detail: 'rank ' + trueRank + ' → ' + wantCls };
}

// QUALITY: acceptable top-1 (solve rate) and oracle best recall@3.
function checkPuzzleTop1(rec, ref) {
  const key = rec.expected_moves[0];
  const ok = ref.bestLines.length > 0 && ref.bestLines[0].uci === key;
  return { ok: ok, detail: 'key ' + key + ' vs top1 ' + (ref.bestLines[0] ? ref.bestLines[0].uci : '-') };
}
function checkPuzzleRecall3(rec, ref) {
  const key = rec.expected_moves[0];
  const top3 = ref.bestLines.slice(0, 3).map(l => l.uci);
  return { ok: top3.includes(key), detail: 'key ' + key + ' vs top3 {' + top3.join(',') + '}' };
}

// QUALITY-tier guard: a ¼×/4× result is graded only if the SHIPPED validator
// accepts it outright — the same wholesale delegation the strict axes use.
// analyse() reports complete:false when it exhausts nodeBudget, and a partial
// result can still carry a plausible first line; trusting it would let an
// unusable tier score as agreement. Rejected tiers are scored as failures by
// the caller, never skipped.
function auxUsable(res, state, opts) {
  return AR.validate(res, state, AC.identity(state, opts)).ok;
}

// QUALITY: is the best move the same one ply shallower? MEASURED HERE — the
// shallower best move is derived by an independent fixed-depth search at d-1,
// never read off `analyse()`'s own `stability.bestMoveStable` flag. Echoing
// the flag would grade the engine on its own say-so: a regression that simply
// asserted the flag true would sail through the ratchet as an *improvement*,
// since the ratchet only fails on a falling number — and `validate()` cannot
// help, because it checks the flag's type, not its truth. (A fixed-depth
// think() at d-1 is not the same computation as `analyse()`'s internal shallow
// pass and legitimately disagrees on a couple of positions: the number is the
// scorecard's measurement, not the subject's claim about itself.)
function checkPvStability(state, ref) {
  if (!ref.stability) return null; // unmeasured (depth 1): omit, don't fabricate
  const shallowDepth = ref.depth - 1;
  if (shallowDepth < 1) return null;
  const shallow = ChessAI.think(state, {
    maxDepth: shallowDepth, nodeLimit: E3_OPTS.ref.nodeBudget,
    quiesce: E3_OPTS.ref.quiesce, positions: state.positions, randomize: false
  });
  const shallowBest = shallow.move ? uciOf(shallow.move) : null;
  const deepBest = ref.bestLines[0].uci;
  const ok = shallowBest === deepBest;
  return { ok: ok, detail: 'd' + shallowDepth + '=' + shallowBest + ' d' + ref.depth + '=' + deepBest +
    (ok ? '' : ' (moved)') };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const STRICT_AXES = ['rootComplete', 'playedRank'];
const QUALITY_AXES = ['puzzleTop1', 'puzzleRecall3', 'pvStability', 'budgetStability'];
const FRACTION_AXES = STRICT_AXES.concat(QUALITY_AXES);

function run(records, full) {
  const axes = {};
  for (const a of FRACTION_AXES) axes[a] = { checked: 0, pass: 0, fail: 0 };
  const failures = [];
  const regrets = []; // per-case capped centipawn regret of the quick pick
  let catastrophic = 0;

  const add = (axis, r, id) => {
    if (!r) return;
    axes[axis].checked++;
    if (r.ok) axes[axis].pass++;
    else { axes[axis].fail++; failures.push({ id: id, axis: axis, detail: r.detail }); }
  };

  for (const rec of records) {
    if (!isLive(rec)) continue; // analyse() has no move to grade on a terminal
    const state = stateOf(rec);
    const ref = analyse(state, E3_OPTS.ref);
    // An empty MultiPV on a LIVE position is a rootComplete FAILURE, never a
    // case to skip — skipping would let emptied output report `gate: PASS`
    // with zero strict checks. Score it first, THEN stop: the downstream axes
    // all dereference bestLines[0].
    add('rootComplete', checkRootComplete(state, ref, E3_OPTS.ref), rec.id);
    if (!ref.bestLines.length) continue; // strict failure already recorded above
    if (isPuzzle(rec)) {
      add('playedRank', checkPlayedRank(rec, state, ref), rec.id);
      add('puzzleTop1', checkPuzzleTop1(rec, ref), rec.id);
      add('puzzleRecall3', checkPuzzleRecall3(rec, ref), rec.id);
    }
    add('pvStability', checkPvStability(state, ref), rec.id);

    // Budget-stability + regret: the QUICK (¼×) scan's best move, judged against
    // the full-depth reference. --full also runs the 4× tier for a ¼×/1×/4×
    // three-way agreement. Regret re-scores the quick pick with the reference's
    // own all-roots line (always present — the pick is a legal root).
    const quick = analyse(state, E3_OPTS.quarter);
    const quickOk = auxUsable(quick, state, E3_OPTS.quarter);
    const quickBest = quickOk ? quick.bestLines[0].uci : null;
    const refBest = ref.bestLines[0].uci;
    let stable = quickOk && quickBest === refBest;
    // Report EVERY tier that ran, so a case that agrees at ¼× but diverges at 4×
    // names the tier that moved instead of printing two identical moves.
    let detail = quickOk ? '¼×=' + quickBest + ' 1×=' + refBest
                         : '¼× unusable (rejected by the shipped validator) 1×=' + refBest;
    if (full) {
      const quad = analyse(state, E3_OPTS.quad);
      const quadOk = auxUsable(quad, state, E3_OPTS.quad);
      const quadBest = quadOk ? quad.bestLines[0].uci : null;
      stable = stable && quadOk && quadBest === refBest;
      detail += quadOk ? ' 4×=' + quadBest : ' 4× unusable (rejected by the shipped validator)';
    }
    add('budgetStability', { ok: stable, detail: detail }, rec.id);

    if (!quickOk) {
      // An unusable quick scan has no pick to re-score: the quick-scan feature
      // itself failed, which is a catastrophic miss — never a dropped sample,
      // or losing coverage could "improve" the quantiles.
      catastrophic++; regrets.push(CATASTROPHIC_CP);
    } else {
      const quickLine = ref.bestLines.find(l => l.uci === quickBest);
      if (!quickLine) { catastrophic++; regrets.push(CATASTROPHIC_CP); }
      else {
        const raw = orderVal(ref.bestLines[0], ref.turn) - orderVal(quickLine, ref.turn);
        // A non-finite regret would poison the quantiles into NaN, which compares
        // false against everything and would silently blind the ratchet. Strict
        // rootComplete already rejects the malformed scores that could cause it;
        // count any survivor as catastrophic rather than letting it vanish.
        if (!Number.isFinite(raw)) { catastrophic++; regrets.push(CATASTROPHIC_CP); }
        else {
          regrets.push(Math.max(0, Math.min(CATASTROPHIC_CP, raw)));
          if (raw >= CATASTROPHIC_CP) catastrophic++;
        }
      }
    }
  }

  let checks = 0, pass = 0, fail = 0, strictFail = 0;
  for (const a of FRACTION_AXES) { checks += axes[a].checked; pass += axes[a].pass; fail += axes[a].fail; }
  for (const a of STRICT_AXES) strictFail += axes[a].fail;
  return { axes, regret: summariseRegret(regrets, catastrophic, full),
    totals: { checks, pass, fail, strictFail }, failures };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
function summariseRegret(regrets, catastrophic, full) {
  const s = regrets.slice().sort((a, b) => a - b);
  const r = { n: s.length, median: percentile(s, 0.5), p90: percentile(s, 0.9), catastrophic: catastrophic };
  if (full) r.p99 = percentile(s, 0.99);
  return r;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------
function scoreVector(mode, records, result, manifest) {
  return {
    corpus: manifest.corpus,
    generator_version: manifest.generator_version,
    ndjson_sha256: manifest.ndjson_sha256,
    scorecard: 'analysis-v1',
    mode: mode,
    // The E3 config is part of the identity of every number below — a baseline
    // built under a different budget must not compare "clean".
    e3_opts: E3_OPTS,
    cases: records.length,
    axes: result.axes,
    regret: result.regret,
    totals: result.totals,
    gate: result.totals.strictFail === 0 ? 'PASS' : 'FAIL'
  };
}

const pad = s => (s + '                ').slice(0, 16);
function printReport(sv, failures) {
  console.log('eval-v1 ANALYSIS scorecard — ' + sv.mode + ' (' + sv.cases + ' cases)');
  console.log('  corpus ' + sv.corpus + ' @ ' + sv.generator_version);
  for (const axis of FRACTION_AXES) {
    const a = sv.axes[axis];
    const strict = STRICT_AXES.includes(axis);
    if (!a.checked) { console.log('  ' + pad(axis) + ' ' + (strict ? 'strict ' : 'ratchet') + '     — (no cases)'); continue; }
    // Only STRICT axes can "FAIL" on their own. A quality axis reports a SCORE:
    // an unsolved puzzle is the measured quality level, not a broken build — it
    // fails only by regressing against the committed baseline (--baseline).
    const flag = strict ? (a.fail === 0 ? 'ok  ' : 'FAIL') : 'score';
    console.log('  ' + pad(axis) + ' ' + (strict ? 'strict ' : 'ratchet') + ' ' + flag + ' ' + a.pass + '/' + a.checked);
  }
  const r = sv.regret;
  console.log('  ' + pad('regret cp') + ' ratchet score median ' + r.median + '  p90 ' + r.p90 +
    (r.p99 != null ? '  p99 ' + r.p99 : '') + '  catastrophic ' + r.catastrophic + '/' + r.n);
  console.log('  ' + pad('STRICT gate') + '      ' + (sv.totals.strictFail === 0 ? 'PASS' : 'FAIL') +
    ' (' + sv.totals.strictFail + ' strict failures)');

  const strictMisses = failures.filter(f => STRICT_AXES.includes(f.axis));
  const qualityMisses = failures.filter(f => !STRICT_AXES.includes(f.axis));
  if (strictMisses.length) {
    console.log('\nSTRICT failures (these break the build):');
    for (const f of strictMisses) console.log('  FAIL [' + f.axis + '] ' + f.id + ' — ' + f.detail);
  }
  if (qualityMisses.length) {
    console.log('\nquality misses (informational — they set the ratchet, they do not fail the build):');
    for (const f of qualityMisses) console.log('  miss [' + f.axis + '] ' + f.id + ' — ' + f.detail);
  }
}

// Ratchet comparison: no axis may lose a pass or shed coverage, and regret
// quantiles may never rise. Determinism makes this exact — no tolerance band.
function compareBaseline(baseline, sv, log) {
  log = log || console.log;
  log('\nbefore/after vs baseline (' + baseline.mode + '):');
  const optsEq = JSON.stringify(baseline.e3_opts) === JSON.stringify(sv.e3_opts);
  if (baseline.corpus !== sv.corpus || baseline.mode !== sv.mode || !optsEq ||
      baseline.scorecard !== sv.scorecard ||
      baseline.generator_version !== sv.generator_version ||
      baseline.ndjson_sha256 !== sv.ndjson_sha256) {
    log('  INCOMPATIBLE baseline: ' + baseline.corpus + '/' + baseline.generator_version + '/' + baseline.mode +
      ' digest=' + String(baseline.ndjson_sha256).slice(0, 12) +
      ' vs ' + sv.corpus + '/' + sv.generator_version + '/' + sv.mode +
      ' digest=' + String(sv.ndjson_sha256).slice(0, 12) + '  ← REGRESSION');
    return false;
  }
  let regressed = false;
  for (const axis of FRACTION_AXES) {
    const b = baseline.axes[axis] || { pass: 0, checked: 0, fail: 0 };
    const a = sv.axes[axis];
    if (!a.checked && !b.checked) continue;
    // Any new failure, any lost pass, or any dropped coverage is a regression.
    const bad = a.fail > (b.fail || 0) || a.pass < b.pass || a.checked < b.checked;
    if (bad) regressed = true;
    const delta = a.pass - b.pass;
    log('  ' + pad(axis) + ' ' + b.pass + '/' + b.checked + ' → ' + a.pass + '/' + a.checked +
      (delta ? '  (' + (delta > 0 ? '+' : '') + delta + ')' : '') + (bad ? '  ← REGRESSION' : ''));
  }
  // Regret: rising median/p90/p99 or more catastrophic misses regress — and so
  // does a SHRINKING SAMPLE, since losing samples could otherwise "improve" the
  // quantiles while measuring strictly less (coverage is part of the score,
  // same rule as `checked` above). NaN-safe: a non-finite quantile compares
  // false against everything, so anything not finite regresses outright.
  const br = baseline.regret, ar = sv.regret;
  const worse = (a, b) => !Number.isFinite(a) || a > b;
  const rBad = !Number.isFinite(ar.n) || ar.n < br.n ||
    worse(ar.median, br.median) || worse(ar.p90, br.p90) ||
    worse(ar.catastrophic, br.catastrophic) ||
    (br.p99 != null && ar.p99 != null && worse(ar.p99, br.p99));
  if (rBad) regressed = true;
  log('  ' + pad('regret cp') + ' n ' + br.n + '→' + ar.n +
    ' med ' + br.median + '→' + ar.median + ' p90 ' + br.p90 + '→' + ar.p90 +
    (br.p99 != null ? ' p99 ' + br.p99 + '→' + ar.p99 : '') +
    ' catastrophic ' + br.catastrophic + '→' + ar.catastrophic + (rBad ? '  ← REGRESSION' : ''));
  return !regressed;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const asJson = args.includes('--json');
  const selfTest = args.includes('--self-test');
  const outIdx = args.indexOf('--out');
  const baseIdx = args.indexOf('--baseline');

  const { manifest, records: all } = loadCorpus();
  const records = full ? all.filter(isLive) : all.filter(inE3Shard);
  const mode = full ? 'full' : 'shard';

  const result = run(records, full);
  const sv = scoreVector(mode, records, result, manifest);

  const diag = asJson ? console.error : console.log;
  if (asJson) console.log(JSON.stringify(sv, null, 2));
  else printReport(sv, result.failures);

  let baselineOk = true;
  if (baseIdx >= 0) {
    const baseline = JSON.parse(fs.readFileSync(args[baseIdx + 1], 'utf8'));
    baselineOk = compareBaseline(baseline, sv, diag);
  }
  if (outIdx >= 0) {
    fs.writeFileSync(args[outIdx + 1], JSON.stringify(sv, null, 2) + '\n');
    diag('\nscore vector written to ' + args[outIdx + 1]);
  }

  // Self-test: inject each engine fault and confirm the STRICT gate goes red —
  // a gate that can never turn red is not a gate.
  if (selfTest) {
    let allDetected = true;
    const puzzleCount = records.filter(isPuzzle).length;
    for (const fault of ['truncate-multipv', 'empty-multipv', 'strip-scores',
                         'zero-mate', 'absent-mate', 'skew-white',
                         'bad-san', 'skew-move',
                         'top-eval-skew', 'stability-depths', 'tamper-provenance',
                         'complete-truthy', 'played-san']) {
      FAULT = fault;
      const sr = run(records, full);
      FAULT = null;
      // A fault must fail while STILL HAVING CHECKED every case — a run that
      // quietly checked nothing is itself a vacuous pass. Coverage is asserted
      // PER AXIS, never pooled: the axes differ in applicability (rootComplete
      // = every live record, playedRank = puzzles only), so a pooled sum can
      // hit the threshold while an entire subset escaped (on the 36-case
      // shard, dropping all 13 puzzle root checks still leaves 23 + 13 = 36).
      // rootComplete is recorded before any early exit, so its coverage must
      // hold exactly under every fault; playedRank coverage legitimately
      // varies (a fault that empties bestLines stops each case before the
      // puzzle axes run), so it is reported for visibility, not asserted.
      const rootChecked = sr.axes.rootComplete.checked;
      const playedChecked = sr.axes.playedRank.checked;
      const fullRootCoverage = rootChecked === records.length;
      const detected = sr.totals.strictFail > 0 && fullRootCoverage;
      allDetected = allDetected && detected;
      const coverage = 'rootComplete ' + rootChecked + '/' + records.length +
        ', playedRank ' + playedChecked + '/' + puzzleCount;
      diag('\nself-test (' + fault + '): strict gate ' +
        (detected ? 'correctly went RED ✓ (' + sr.totals.strictFail + ' strict failures; ' +
                    coverage + ')'
                  : 'FAILED ✗ — ' + sr.totals.strictFail + ' strict failures; ' + coverage +
                    (fullRootCoverage ? ' (need >0 strict failures)'
                                      : ' — rootComplete must cover EVERY record; a subset escaped')));
    }

    // RATCHET-VISIBLE faults: corrupting an auxiliary (¼×/4×) tier cannot turn
    // the STRICT gate red — the graded ref/ship results are untouched — so the
    // requirement is full visibility to the ratchet instead: every tier flagged
    // unusable (budgetStability at 0 passes with coverage intact) and every
    // quick-scan regret counted catastrophic (sample not shrunk). A silently
    // trusted or silently skipped tier would leave the numbers clean.
    const clean = run(records, full);
    {
      FAULT = 'incomplete-aux';
      const sr = run(records, full);
      FAULT = null;
      const bs = sr.axes.budgetStability, cb = clean.axes.budgetStability;
      const visible = sr.totals.strictFail === 0 &&
        bs.checked === cb.checked && bs.pass === 0 &&
        sr.regret.n === clean.regret.n &&
        sr.regret.catastrophic === sr.regret.n;
      allDetected = allDetected && visible;
      diag('\nself-test (incomplete-aux, ratchet): ' +
        (visible ? 'fully VISIBLE ✓ (budgetStability ' + bs.pass + '/' + bs.checked +
                   ', regret catastrophic ' + sr.regret.catastrophic + '/' + sr.regret.n +
                   ', strict gate correctly unaffected)'
                 : 'ESCAPED ✗ — budgetStability ' + bs.pass + '/' + bs.checked +
                   ' (clean ' + cb.pass + '/' + cb.checked + '), regret n ' +
                   clean.regret.n + '→' + sr.regret.n + ' catastrophic ' +
                   sr.regret.catastrophic + ', strictFail ' + sr.totals.strictFail +
                   ' — an unusable tier must be flagged and counted, never trusted or skipped'));
    }

    // IMMUNITY faults: corruptions that would move a QUALITY number UPWARD.
    // These must NOT turn the gate red — the ratchet only fails on a falling
    // number, so a flattering self-report would ratchet through as progress.
    // The assertion is that the score does not MOVE: the axis must measure the
    // behaviour itself rather than echo the claim.
    for (const [fault, axis] of [['liar-stability', 'pvStability']]) {
      FAULT = fault;
      const sr = run(records, full);
      FAULT = null;
      const before = clean.axes[axis], after = sr.axes[axis];
      const immune = before.pass === after.pass && before.checked === after.checked;
      allDetected = allDetected && immune;
      diag('\nself-test (' + fault + ', immunity): ' + axis + ' ' +
        (immune ? 'correctly UNMOVED ✓ (' + after.pass + '/' + after.checked +
                  ' — measured independently, not read off the result)'
                : 'MOVED ✗ ' + before.pass + '/' + before.checked + ' → ' + after.pass + '/' +
                  after.checked + ' — the axis is echoing the engine\'s self-report, so a ' +
                  'broken implementation would ratchet through as an improvement'));
    }
    if (!allDetected) process.exit(3);
  }

  const ok = sv.gate === 'PASS' && baselineOk;
  process.exit(ok ? 0 : 1);
}

main();
