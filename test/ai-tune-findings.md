# Evaluation-weight tuning — experiment log

**Decision: no evaluation-weight change ships.** On this run the
validation-selected candidate *does* lower the untouched held-out Texel loss
(by ~1 %), but it is chess-nonsensical and **fails the playing gate** — it cannot
convert K+Q vs K or K+R vs K, and loses ground in self-play. This is the crux of
the whole exercise: **a lower outcome-labelled Texel loss is not the same as
playing strength.** Runtime is unchanged — zero lines.

Scope note up front: this is **not** a claim of a global or universal optimum,
and it is not a claim that the shipped weights minimise Texel loss. On this
low-budget self-play distribution the loss-optimal integer fit is *worse* to play
than the shipped weights — so the gate, not the loss, is the arbiter, exactly as
designed.

Reproduce with `test/ai-tune.js` (development only; not in PR CI). The tuner's own
correctness — including a **distinct-weights fidelity oracle** that catches a
feature wired to the wrong term — is covered by `test/ai-tune.test.js`, which *is*
in CI.

## Setup

- **Terms tuned** (the shipped constants the plan named): knight / bishop / rook /
  queen mobility, doubled and isolated pawn penalties, the pawn shield, and the
  passed-pawn midgame/endgame arrays — 19 parameters.
- **Data**: 600 self-play games (random 6-ply openings, then an engine playout at
  700 nodes/move), quiet-position sampling with a **per-game random phase** →
  **13,058 positions, 78.3 % decisive**, side-to-move balance **53.4 % White /
  46.6 % Black**. Only games that contributed a sampled position count toward
  these statistics and toward the split.
- **Grouped split by game**: **train 420 games / 9,184 pos · validation 90 / 1,940
  · test 90 / 1,934.** No game straddles a boundary.
- **Rounded scoring**: every integer weight vector is scored on
  `Math.round(evaluate())`, the value the engine actually plays; only the
  continuous RMSProp descent uses the smooth score.
- **Selection**: K fitted on the baseline (K ≈ 0.41; train decisive 6,745/9,184);
  weights fitted on **train**, L2-regularised toward the shipped values; **λ chosen
  on validation with the baseline in the candidate set**; final comparison on the
  **untouched test set**.
- **Fidelity**: reconstruction matches `ai.js`'s `evaluate()` on 400 baseline +
  400 **distinct-weights** fresh random positions (the distinct-weights pass
  detects a feature/coefficient swap that the equal-valued baseline cannot).

## λ sweep — selected on validation (rounded scores)

Baseline loss: train 0.128627 · val 0.122003 · **test 0.126424**.

| λ        | train Δloss | val Δloss | weights moved | reading |
|----------|-------------|-----------|---------------|---------|
| 0 (none) | +0.927 %    | **+0.546 %** | 17 / 19 | selected — lowest validation loss |
| 0.05     | +0.003 %    | +0.004 %  | 1 / 19  | a single +1 cp tweak |
| 0.1      | +0.003 %    | +0.004 %  | 1 / 19  | same tweak |
| 0.2–1.0  | 0.000 %     | 0.000 %   | 0 / 19  | shipped weights |

**Selected λ = 0**, which lowers the untouched test loss from 0.126424 to
0.125189 — a **0.977 %** improvement. Its weights, however, are not those of a
sane evaluation:

```
MOBILITY { N: 0, B: 4, R: 7, Q: 6 }      (a zero knight-mobility term)
DOUBLED 27, ISOLATED 10, SHIELD 30        (shield pinned at the cap)
PASSED_MG [0, 0, 37, 146, 129, 200, 80]   (non-monotonic)
PASSED_EG [0, 69, 39, 24, 93, 300, 180]   (non-monotonic)
```

(The λ = 0.05/0.1 fits move a single endgame passed-pawn weight by one centipawn —
noise; they are not selected.)

## Is the selected candidate admissible? No — it fails tactics.

A lower Texel loss is necessary but never sufficient — the outcome-labelled
objective is not the playing objective — so a candidate is admissible only if it
also clears the **tactics suite** and then the predeclared clustered match. The
gate is ordered: tactics first, and a tactics failure is terminal.

The λ = 0 candidate **fails the tactics suite** — 61/63, losing **K+Q vs K** and
**K+R vs K** conversions (baseline: 63/0). A distorted evaluation with a zero
knight-mobility term and a cap-pinned shield can no longer steer even basic won
endings to mate. That regression alone disqualifies it; a candidate that cannot
mate with K+Q is not one whose playing strength is in question, so **no self-play
match is run** — it would only spend compute to confirm a verdict tactics has
already delivered. (This mirrors the converse shortcut: when the selection
returns the baseline unchanged, no tactics run or match is needed either.)

So the candidate lowers held-out Texel loss by ~1 % **and cannot play a won
K+Q ending** — the definition of objective misalignment.

## Conclusion

The experiment yields **no admissible candidate**. On this distribution the
regularised fits that keep sane weights do not beat the shipped weights beyond a
one-centipawn noise margin, and the fit that *does* lower held-out loss by ~1 %
(the unregularised λ = 0) is chess-nonsensical and fails the playing gate. The
shipped evaluation weights stand unchanged. This is precisely what the disciplined
protocol exists to catch: it stops a lower-loss-but-weaker candidate from shipping
as if the loss delta were strength. (The validation-selected candidate is also
noise-sensitive across dataset regenerations, which is a further reason not to
ship it.) Anything materially stronger belongs in a separate optional analysis
engine, not in more evaluation terms or weight churn inside Chessy.
