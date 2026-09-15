# Frozen H8 / expanded HCE hybrid — 2026-09-15

**The smooth hybrid passes every unchanged guard on reused outer validation. The sealed test remains unopened at this screen stage.**

The selected evaluator uses expanded HCE when material phase is 6 or lower, the frozen H8 evaluator at phase 12 or higher, and a linear blend between them. This keeps the expanded-HCE score exactly in the registered endgame category. No model was retrained, no new labels were collected for this screen, and paid compute was **$0**.

## Frozen design and provenance

- [Exact recovery preregistration](../training/hybrid-v1b.json); [original preregistration](../training/hybrid-v1.json); [aggregate evidence](results-2026-09.json).
- The first registered execution stopped before gate loss calculation because expanded-HCE scores were stored as integral-valued float64 while the blend required integer dtype. Its run marker remains consumed. V1b adds a strict finite, exact-integral, bounded conversion to int64 and keeps the original grid, models and guards.
- Development: frozen v4 H8 phase model, seed 10513, nominal 900-epoch budget / selected 800-epoch checkpoint; 6,614 reused inner-validation rows. Outer: frozen v4 shared-train refit at 840 epochs; 2,374 reused NNUE validation rows. No architecture, training budget, seed or checkpoint was selected again.
- Select the lowest integer inner cross entropy among six registered gates passing the unchanged shipped-HCE phase guard. Expanded HCE previously trained on the inner labels and is an in-sample diagnostic there. Freeze one configuration and final model digest before outer evaluation; no alternate gate is scored on outer.
- Local execution commit `cd39d447e65c0f43aab8d08555b81f194a36e040` and [published mirror](https://github.com/den-run-ai/chessy/commit/7e61901bdfcaf89d477aa7f85bc27f2aa5bdbcce) have identical tree `6c6d4c642b12a88ac7883b392c0601f405428e5d`.

## Complete development grid

| Gate | Inner teacher CE | Endgame CE | Maximum gate-only 1-phase change |
| --- | ---: | ---: | ---: |
| hard-4 | 0.396301146 | 0.308323514 | 170 cp |
| hard-6 | 0.396122778 | 0.307129454 | 170 cp |
| hard-8 | 0.395886967 | 0.307129454 | 170 cp |
| smooth-2-8 | 0.396312955 | 0.308637893 | 29 cp |
| smooth-4-10 | 0.395982641 | 0.307332679 | 29 cp |
| smooth-6-12 | 0.395790780 | 0.307129454 | 29 cp |

The transition statistic freezes the two component evaluator outputs and varies only the phase multiplier. It isolates the gate contribution and does not represent actual legal-move score changes. Hard-gate p99 change was 95 cp; smooth-gate p99 was 16 cp. Runtime legal-transition checks are a separate experiment.

## One frozen outer candidate

| Evaluator | Teacher CE | Gain vs shipped | Endgame CE |
| --- | ---: | ---: | ---: |
| frozen-expanded-hce | 0.403503522 | 0.732% | 0.271049593 |
| pure-neural | 0.396091534 | 2.556% | 0.274707866 |
| shipped-hce | 0.406479909 | 0.000% | 0.280212678 |
| smooth-6-12 hybrid | 0.395561867 | 2.686% | 0.271049593 |

The hybrid improves aggregate CE **2.686% versus shipped** and **1.968% versus expanded HCE**. Endgame CE is exactly the expanded comparator. All original MAE, RMSE, p99, phase coverage and phase CE guards also pass against both comparators; no allowance changed.

Outer coverage: 332 positions use expanded HCE only, 310 use the blend, and 1,732 use H8 only. On the 332 endgames, hybrid and expanded-HCE scores are identical by construction.

## Component ablations on reused inner data

| Evaluator / component change | Inner CE | Endgame CE |
| --- | ---: | ---: |
| expanded | 0.402249025 | 0.307129454 |
| expanded-base-plus-gated-residual | 0.394970830 | 0.307129454 |
| gated-neural-shipped-fallback | 0.397702694 | 0.318438559 |
| hybrid | 0.395790780 | 0.307129454 |
| pure-neural | 0.397361996 | 0.315425191 |
| shipped | 0.410029817 | 0.318438559 |

The shipped-fallback variant removes the expanded-HCE contribution. The expanded-base-plus-gated-residual variant changes the baseline under a residual trained against shipped HCE; it is a deliberate distribution-shift diagnostic and was never eligible for selection.

## Numerical audit and potential tablebase coverage

An independent audit reconstructed **51,046 outputs** with **zero mismatches**, including all six development gates and the sole outer candidate. Maximum outer float/integer difference was **0.820 cp**, below the unchanged 5 cp limit; the mean was 0.220 cp, below 1 cp. Independent JavaScript uses BigInt arithmetic and recomputes material phase from each FEN.

| Piece-count limit | All outer positions | Outer endgames |
| --- | ---: | ---: |
| ≤3 pieces | 1 / 2,374 | 1 / 332 |
| ≤4 pieces | 6 / 2,374 | 6 / 332 |
| ≤5 pieces | 13 / 2,374 | 13 / 332 |
| ≤6 pieces | 32 / 2,374 | 32 / 332 |
| ≤7 pieces | 56 / 2,374 | 55 / 332 |

These are only piece-count upper bounds on potential Syzygy coverage. Castling rights and supported material combinations were not adjudicated. Even seven-piece coverage reaches only 56 outer positions overall and 55 of the 332 endgames; exact small tables cannot replace most of this endgame category.

## Limits and next gate

Both inner and outer results are reused development evidence. Passing their guards qualifies the fixed candidate for a separately registered one-shot sealed test with the original two-comparator bootstrap and quality requirements; it does not establish Elo or justify shipping. The 12,392 neural parameter bytes exclude expanded-HCE coefficients, executable evaluator code and packaged WASM. Runtime size, equal-time search strength, licensing and formal acceptance remain separate gates.

The six-gate search completed in 31.617 seconds with zero training fits and $0 paid compute. Exhausting this registered grid is not universal model saturation.
