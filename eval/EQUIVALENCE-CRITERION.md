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
  `candidates` otherwise;
- `best`, `attempt` (uci, san, covered, true rank, evaluation, cp gap) and
  `accepted` — the accepted-move set among the returned lines with their
  scores;
- `verdict` — `best` | `equivalent` | `not-equivalent` | `unknown` — and a
  machine-readable `reason`.

## Decision procedure

1. **Fail closed on untrusted analysis.** The whole result must pass the
   shipped `ChessyAnalysisResult.validate` against the caller's expected
   identity. `requireComplete` is forced to `true` — grading callers cannot
   waive completeness the way scan orchestration can. A rejected result
   produces `{ ok: false, reason: 'analysis-…' }`: no verdict, no evidence.
2. **Fail closed on an illegal attempt** (`attempt-illegal`).
3. **Locate the attempt's evidence line**: its candidate line when returned,
   else the validated `playedLine` produced for exactly this move. With
   neither, the verdict is **`unknown` (`not-covered`)** — an attempt outside
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

## Calibration — why 30 cp

Calibrated against the frozen E3 analysis baseline
([`ANALYSIS-BASELINE.md`](./ANALYSIS-BASELINE.md), merged in
[#110](https://github.com/den-run-ai/chessy/pull/110)), measured on the
license-clean corpus with the shipped validator in the loop:

- **Lower bound — the engine's own measurement noise.** Re-scoring the same
  position at a different node budget moves the reported best by a median of
  0 cp but a **p90 of 17 cp** over the full corpus (quick-scan regret,
  103 cases; the PR shard's p90 is 5 cp). A tolerance below that floor would
  flip grades on budget noise rather than on chess.
- **Near-equivalent roots must grade equivalent.** The baseline's
  `pvStability`/`budgetStability` misses concentrate on positions whose top
  roots are deliberately near-equal, with **median regret 0 cp** — exactly
  the "bounded, near-equivalent" variation the evaluation tracker requires
  distinguishing from a real mistake.
- **Upper bound — the conventional inaccuracy threshold.** Standard
  annotation practice (e.g. Lichess) starts labelling moves as inaccuracies
  around a **~50 cp** loss. The tolerance must stay clearly below that, or
  genuine inaccuracies would be blessed as equivalent.

`cpTolerance = 30` sits between those bounds: comfortably above the 17 cp
p90 noise floor, materially below the 50 cp inaccuracy convention. The gap
itself is always computed inside **one** complete, validated result (fixed
budget, every root scored by the same search), so the noise floor is the
conservative anchor, not an in-band error estimate.

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
2. Re-derive the calibration section from the then-current analysis baseline.
3. Re-baseline any evaluation gate that scores grading behaviour, in the same
   change, so the shift is visible in review rather than silent.

Consumed by: #76 E2 (move grading), #108 (verified lesson proposals).
Related: #23, #87, #107, #110.
