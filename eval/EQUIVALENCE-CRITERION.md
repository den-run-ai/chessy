# Accepted-move equivalence criterion — `chessy-equivalence` v1

The **versioned accepted-move criterion** required by Train v2 E1
([#76](https://github.com/den-run-ai/chessy/issues/76)) and roadmap step 4
([#23](https://github.com/den-run-ai/chessy/issues/23)): the explicit,
documented **CP/mate fallback**. Merging this document and its implementation
(`assets/equivalence.js`) constitutes the roadmap's "approve and version the
accepted-move criterion" decision for the built-in provider.

This is **not WDL equivalence** and is never described as such: the built-in
engine has no win/draw/loss model, so every piece of evidence carries
`wdl: null` — unavailable, never synthesized. A future provider with reliable
WDL ([#107](https://github.com/den-run-ai/chessy/issues/107)) would be a new
criterion basis under a new version, not a reinterpretation of this one.

## Identity

| Field | Value |
| --- | --- |
| `id` | `chessy-equivalence` |
| `version` | `1` |
| `basis` | `cp-mate-fallback` |
| `params.cpTolerance` | `30` (centipawns, inclusive) |

The exact object is pinned by `test/equivalence.test.js`: any change to what
"equivalent" means must bump `version` there and here, consciously.

## What it grades

`ChessyEquivalence.grade(result, state, expected, attemptUci)` grades one
attempted move against one trusted analysis result and returns **persistable
evidence**, never a bare boolean:

- `criterion` — the identity above, snapshotted into the evidence;
- `provider` (`engineId`, `version`, `configHash`) and
  `positionFingerprint` — provenance copied from the validated result;
- `coverage` — `all-roots` when `bestLines` covers every legal move,
  `candidates` otherwise — plus `complete`, `legalRootCount`,
  `candidateLineCount`, and `coveredRootCount`;
- `playedProbe` — the result's optional played-move probe even when the current
  call grades a different move, including its evaluation, candidate
  membership, rank, `rankBasis`, and proven `rankLowerBound`;
- `stability` — the validated depth pair and `bestMoveStable` value that
  authorized (or prevented) a negative verdict;
- `best`, `attempt` (uci, san, covered, evaluation, cp gap, rank,
  `rankBasis`, `rankLowerBound`) and
  `accepted` — the accepted-move set among returned candidates plus a covered
  outside-MultiPV `playedLine`, with their scores;
- `verdict` — `best` | `equivalent` | `not-equivalent` | `unknown` — and a
  machine-readable `reason`.

## Decision procedure

1. **Canonicalize, then fail closed on untrusted analysis.** Result, source
   state, and expected identity are snapshotted once into inert data before
   validation, so accessor/Proxy values cannot change or throw on a
   post-validation read. The whole snapshot must pass the shipped
   `ChessyAnalysisResult.validate` against the snapshotted expected identity.
   Its centipawn representation is restricted to safe integers in the built-in
   engine's non-mate band (absolute value ≤ 999000), so hostile finite values
   cannot collide with mate ordering or overflow a persisted gap.
   `requireComplete` is forced to `true` — grading callers cannot waive
   completeness the way scan orchestration can. A rejected or unreadable
   input produces `{ ok: false, reason: 'analysis-…' }`: no verdict, no
   evidence.
2. **Fail closed on an illegal attempt** (`attempt-illegal`).
3. **Locate the attempt's evidence line**: its candidate line when returned,
   else the validated `playedLine` produced for exactly this move. An
   outside-candidate line's `rank` is explicitly **provider-reported**, not
   independently proven by the shortlist. The validator proves its legal
   range, that it is below the candidate-rank lower bound, and—using
   categorical mate/centipawn ordering—that it cannot outrank the shortlist's
   final line. Candidate ranks are proven by array position. With no attempt
   line, the verdict is **`unknown` (`not-covered`)** — an attempt outside
   MultiPV is *never* auto-failed ("not yet covered" is not "wrong"); the
   caller must first analyse the attempt (`playedMove`) to grade it.
4. **The engine's own best move is `best`** (gap 0 for centipawn lines, no
   gap for mate lines).
5. **Otherwise apply the CP/mate case matrix.** Representations never mix in
   one subtraction; only cp-vs-cp produces a numeric gap:

   | best line ↓ / attempt → | mate **for** player | centipawn | mate **against** player |
   | --- | --- | --- | --- |
   | mate **for** player | **equivalent** — any forced mate wins; distance is speed, not correctness | **not-equivalent** (`missed-forced-mate`) | **not-equivalent** (`walks-into-mate`) |
   | centipawn | **equivalent** (`attempt-not-worse`) | gap = best − attempt (player POV); **equivalent** iff gap ≤ 30 cp | **not-equivalent** (`walks-into-mate`) |
   | mate **against** player | **equivalent** (`attempt-not-worse`) | **equivalent** (`attempt-not-worse`) | **equivalent** iff the attempt resists at least as long (`equal-resistance`); hastening the mate is **not-equivalent** (`faster-mate-against`) |

6. **Rejection requires a stable best move.** Declaring the player's move an
   error is the harmful false outcome, so a would-be `not-equivalent` verdict
   on a result whose `stability.bestMoveStable` is not exactly `true`
   downgrades to **`unknown` (`unstable-best`)**. Acceptance (`best`,
   `equivalent`) is unaffected by stability: accepting a within-tolerance
   move is safe in both failure directions.

## Policy rationale and validation status — why 30 cp

`cpTolerance = 30` is a versioned product-policy boundary, not a fitted
statistical estimate. It accepts a root within **0.30 pawn** of the engine's
best score while keeping ordinary half-pawn losses outside the accepted set.
The gap is always computed inside **one** complete, validated result at one
fixed budget, with both roots scored by the same search.

The frozen E3 baseline
([`ANALYSIS-BASELINE.md`](./ANALYSIS-BASELINE.md), merged in
[#110](https://github.com/den-run-ai/chessy/pull/110)) informed that policy:

- On its 34-case train/validation shard, the ¼× scan's chosen root re-scored
  inside the 1× all-roots result has median regret **0 cp** and p90 **5 cp**.
  That compact CI shard is an execution subset, not a statistically complete
  train/validation sample.
- On all 103 live cases, the same descriptive distribution has median
  **0 cp** and p90 **17 cp**. This is cross-budget chosen-move regret—not
  repeated measurement of the same root—so it is context for a conservative
  boundary, not an error bar on an in-result gap.
- Its near-equal roots exercise the intended distinction between a bounded
  alternative and a genuine mistake; the committed exact E3 fixture freezes
  every **PR-shard** puzzle's v1 verdict/reason so later semantic drift cannot
  hide in aggregates. `--full` reports all 40 puzzle outcomes descriptively;
  there is no committed full-mode baseline.

**Historical disclosure.** The full `eval-v1` metrics, including records tagged
`test`, had already been inspected in #110, and the first version of this
criterion explicitly used the full-corpus p90 of 17 cp in its rationale.
Therefore that split is **not an untouched holdout for this v1 decision**.
This document makes no post-selection or out-of-sample claim for it; those
records are deterministic development/compatibility evidence.

A genuinely fresh check requires new, non-overlapping source data frozen before
the criterion is run. [#112](https://github.com/den-run-ai/chessy/issues/112)
predeclares that one-shot lockbox: exclude every existing puzzle and source
game, freeze the source snapshot/selection/hash and the exact v1 implementation
first, and keep results out of routine tuning feedback. The tranche is consumed
on its first reveal regardless of outcome; if that result changes criterion
code or policy, only a new tranche can validate the revision.

## Provenance and the stability of outcomes

Evidence embeds the criterion identity **and** the provider identity
(`engineId`/`version`/`configHash`/`positionFingerprint`). Grading is a pure
function of its stored inputs: the same persisted provenance always
reproduces the same verdict. An engine update changes the identity and
therefore produces **new** evidence — it never rewrites a persisted outcome
(#76: "engine updates must not silently rewrite historical outcomes").

## Change protocol

1. Bump `version` in `assets/equivalence.js` and in this document, and update
   the pinned identity in `test/equivalence.test.js` — the pin exists so a
   parameter edit cannot land as an invisible behaviour change.
2. Record the policy rationale and every dataset consulted. Use development
   data for changes; an out-of-sample claim requires a new lockbox under #112,
   frozen before the changed criterion is run.
3. Re-baseline the E3 PR-shard scorecard's exact `equivalence` fixture in
   `eval/ANALYSIS-BASELINE.json` and `.md` in the same change. Baseline
   compatibility includes the criterion identity, and every baseline puzzle's
   `id → verdict/reason` in that committed shard is compared exactly; an
   identity change, missing case, or grading drift fails until consciously
   reviewed and re-baselined. Full-mode output remains descriptive unless a
   separate full baseline is explicitly added.

Consumed by: #76 E2 (move grading), #108 (verified lesson proposals).
Related: #23, #87, #107, #110.
