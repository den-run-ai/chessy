# Evaluation-weight tuning — experiment log

**Decision: this experiment produced no admissible candidate, so no evaluation
change ships.** Runtime is unchanged — zero lines. The plan named evaluation
tuning as the most plausible remaining strength gain; a disciplined run finds no
admissible candidate on the distribution tested.

Scope note up front: this is **not** a claim that the shipped weights are a
global or universal optimum. The regulariser is centred on the shipped values,
so a large λ trivially returns them — that alone proves nothing. The substantive
evidence is narrower and stated below: under a leakage-free grouped split with
validation-based model selection, the fit does not leave the shipped weights, and
the only fit that moves them fails to generalise **and** breaks tactics. All of
this is specific to low-budget self-play from random 6-ply openings.

Reproduce with `test/ai-tune.js` (development only; not in PR CI). The tuner's
own correctness is covered by `test/ai-tune.test.js`, which *is* in CI.

## Setup

- **Terms tuned** (the shipped constants the plan named): knight / bishop / rook
  / queen mobility, the doubled and isolated pawn penalties, the pawn shield, and
  the passed-pawn midgame/endgame arrays — 19 parameters.
- **Data**: 600 self-play games (random 6-ply openings for spread, then an engine
  playout at 700 nodes/move), 1-of-4 quiet-position sampling → **13,763
  positions, 77.8 % decisive**, each labelled by its game's outcome from White's
  point of view. Every position carries its game id.
- **Grouped split by game** (no game straddles a boundary — the leakage a
  position-level shuffle would allow): **train 420 games / 9,595 pos · validation
  90 / 2,131 · test 90 / 2,037.**
- **Fit**: the sigmoid scale `K` is fitted on the baseline (K ≈ 0.52) and held
  fixed; weights are fitted on **train** by RMSProp + integer polish, L2-
  regularised toward the shipped values. **λ is chosen on validation; the winner
  is compared to the baseline on the untouched test set** (val is spent on
  selection, so it cannot also be the final holdout).
- **Fidelity**: the tuner's feature reconstruction equals `ai.js`'s own
  `evaluate()` on 400 fresh random positions (distribution-independent check; the
  13,763 dataset positions are not individually re-checked).

## λ sweep — selected on validation

Baseline loss: train 0.118948 · val 0.120207 · **test 0.121979**.

| λ        | train Δloss | val Δloss | weights moved | reading |
|----------|-------------|-----------|---------------|---------|
| 0 (none) | +0.636 %    | **−0.405 %** | 16 / 19 | lowers train, **raises validation** — overfits |
| 0.05     | +0.004 %    | −0.001 %  | 2 / 19  | within noise, slightly worse on val |
| 0.1      | 0.000 %     | 0.000 %   | 0 / 19  | selected (lowest val loss) |
| 0.2–1.0  | 0.000 %     | 0.000 %   | 0 / 19  | unchanged |

**Selected λ = 0.1 → the fit leaves the shipped weights unchanged → the final
untouched-test comparison is exactly equal (0.000 %).** No candidate to ship.

Note this is stronger — and cleaner — than the earlier position-shuffled run,
which (through train/val leakage) had reported λ = 0 *improving* validation. With
the leak removed, λ = 0 makes validation **worse**: that earlier improvement was
a leakage artifact.

## The only moved fit (λ = 0) is inadmissible two ways

```
MOBILITY { N: 5, B: 4, R: 2, Q: 4 }
DOUBLED 4, ISOLATED 13, SHIELD 30
PASSED_MG [0, 0, 0, 96, 123, 119, 80]
PASSED_EG [0, 35, 51, 90, 188, 215, 180]
```

1. **Fails to generalise** — it lowers train loss but *raises* held-out loss
   (validation −0.405 %, test **−1.020 %**), and its weights are chess-
   nonsensical (shield pinned at the cap, non-monotonic passed-pawn arrays).
2. **Fails the tactics suite** — 62/63, losing the K+Q vs K conversion (baseline:
   63/0). Even a candidate that *did* lower held-out loss would be rejected here:
   the outcome-labelled Texel objective is not the playing objective. This is
   objective misalignment, and it is why loss is necessary but never sufficient.

## Self-play match — exploratory only

An earlier λ = 0 variant was played against the shipped weights (2000 nodes/move)
purely to sanity-check direction after it had *already* been disqualified by
tactics. It trailed and was stopped at **8.5 / 20 (42.5 %)**. This is an
exploratory post-disqualification pilot, **not** gate evidence: the formal gate
is a predeclared clustered match with no interim stopping, so no statistical
strength conclusion is drawn from these 20 games. No candidate reached the gate.

## Conclusion

On this low-budget self-play distribution, with a leakage-free grouped split and
validation-based selection, the experiment yields **no admissible candidate**:
the selected model is the shipped model, and the only alternative that moves the
weights neither generalises nor survives tactics. The shipped evaluation weights
stand unchanged. This is the outcome the disciplined protocol exists to
surface — it stops noise and overfitting from shipping as strength. Anything
materially stronger belongs in a separate optional analysis engine, not in more
evaluation terms or weight churn inside Chessy.
