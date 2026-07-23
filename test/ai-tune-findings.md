# Evaluation-weight tuning — experiment log

**Decision: no evaluation-weight change ships.** On this distribution the
validation-selected candidate differs from the shipped weights by a single
centipawn on one endgame passed-pawn term — a change at the noise floor
(untouched-test improvement 0.002 %) that a one-centipawn tweak on a rarely-active
weight cannot plausibly convert into a demonstrated strength gain. Runtime is
unchanged — zero lines.

Scope note up front: this is **not** a claim of a global or universal optimum.
The regulariser is centred on the shipped weights, so a large λ trivially returns
them — that alone proves nothing. The substantive evidence is narrower: under a
leakage-free grouped split with validation-based model selection **and the
engine's rounded scoring**, the only fits that beat the shipped weights on
validation do so by a single centipawn (noise), and the only fit that moves the
weights substantially (λ = 0) *overfits* — its held-out loss is worse. All of
this is specific to low-budget self-play from random 6-ply openings.

Reproduce with `test/ai-tune.js` (development only; not in PR CI). The tuner's own
correctness is covered by `test/ai-tune.test.js`, which *is* in CI.

## Setup

- **Terms tuned** (the shipped constants the plan named): knight / bishop / rook /
  queen mobility, doubled and isolated pawn penalties, the pawn shield, and the
  passed-pawn midgame/endgame arrays — 19 parameters.
- **Data**: 600 self-play games (random 6-ply openings for spread, then an engine
  playout at 700 nodes/move), quiet-position sampling with a **per-game random
  phase** (so both sides to move are sampled — balance **53.5 % White / 46.5 %
  Black**, not the 100 % White a fixed even opening + even stride would give) →
  **13,042 positions, 78.3 % decisive**, each labelled by its game's outcome and
  tagged with its game id.
- **Grouped split by game**: **train 419 games / 8,807 pos · validation 90 / 2,161
  · test 90 / 2,074.** No game straddles a boundary.
- **Rounded scoring**: the engine plays `Math.round(evaluate())`, so every integer
  weight vector (baseline, polish, selection, final reporting, K fit) is scored on
  the rounded evaluation. Only the continuous RMSProp descent uses the smooth
  score, where the gradient is defined.
- **Selection**: K fitted on the baseline (K ≈ 0.475); weights fitted on **train**
  by RMSProp + integer polish, L2-regularised toward the shipped values; **λ chosen
  on validation with the baseline itself in the candidate set**; final comparison to
  baseline on the **untouched test set**.
- **Fidelity**: the tuner's feature reconstruction equals `ai.js`'s own
  `evaluate()` on 400 fresh random positions (distribution-independent; the 13,042
  dataset positions are not individually re-checked).

## λ sweep — selected on validation (rounded scores)

Baseline loss: train 0.125679 · val 0.127153 · **test 0.134707**.

| λ        | train Δloss | val Δloss | weights moved | reading |
|----------|-------------|-----------|---------------|---------|
| 0 (none) | +1.411 %    | **−0.442 %** | 17 / 19 | lowers train, **raises validation** — overfits |
| 0.05     | +0.003 %    | +0.001 %  | 1 / 19  | selected — a single +1 cp tweak |
| 0.1      | +0.003 %    | +0.001 %  | 1 / 19  | same single tweak |
| 0.2–1.0  | 0.000 %     | 0.000 %   | 0 / 19  | shipped weights |

**Selected λ = 0.05.** The candidate is the shipped weights with exactly one
change: `PASSED_EG[5]` (passed pawn five ranks advanced, endgame) 130 → 131. On
the untouched test set it scores 0.134704 vs the baseline's 0.134707 — a
**+0.002 %** improvement, i.e. one part in ~45,000. This is indistinguishable from
noise: the selection is working (it picks the lowest validation loss), but the
margin that separates this candidate from the baseline is a single centipawn.

The λ = 0 (unregularised) fit moves 17 of 19 weights and lowers *training* loss by
1.4 %, but its **held-out validation loss is worse** (−0.442 %) — textbook
overfitting, rejected by validation without needing any further test.

## Is the selected candidate admissible?

A lower Texel loss is necessary but never sufficient — the outcome-labelled
objective is not the playing objective — so a candidate is admissible only if it
also clears the tactics suite and the predeclared clustered self-play match with a
95 % lower bound above 50 %. For the `PASSED_EG[5] +1` candidate:

- **Tactics**: 63/63 — no regression (a one-centipawn change is far too small to
  disturb the fixed-node tactical tests).
- **Self-play vs baseline** (candidate = working tree, base = HEAD; 3000
  nodes/move, a bounded 60-opening × both-colours = 120-game confirmatory run,
  played to completion — no interim stopping): the two engines play essentially
  even, as a one-centipawn change to a single endgame passed-pawn weight must —
  near-identical engines draw or split the pair. The clustered 95 % lower bound
  does **not** clear 50 %. (This bounded run is a confirmatory check, not the full
  predeclared 800-game gate; the point is only that the candidate shows no
  demonstrable strength, and it does not.)

The candidate is therefore **not** a demonstrated improvement — it is a
noise-level artifact of a validation margin one part in ~45,000 wide.

## Conclusion

On this low-budget self-play distribution, with a leakage-free grouped split,
rounded scoring, and validation-based selection that includes the baseline, the
experiment yields **no admissible candidate**: the substantially-moved fit (λ = 0)
overfits, and the validation-selected fit is a single-centipawn change whose
held-out improvement (0.002 %) is at the noise floor and cannot meet the strength
gate. The shipped evaluation weights stand unchanged. This is the outcome the
disciplined protocol exists to surface — it stops noise and overfitting from
shipping as strength. Anything materially stronger belongs in a separate optional
analysis engine, not in more evaluation terms or weight churn inside Chessy.
