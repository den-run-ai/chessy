# Frozen H8 / expanded HCE hybrid — 2026-09-15

**The frozen smooth hybrid passes the one-shot sealed test and every unchanged numerical, error and phase guard.** It improves test teacher loss by **3.528% versus shipped HCE** and **2.304% versus expanded HCE**; this is offline evidence, not an Elo result.

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

## One-shot sealed test

After the development gate and independent screen audit passed, the exact selected gate and final H8 digest were bound in a [separate test preregistration](../training/hybrid-test-v1.json). The 2,331-row test was opened once after the shared dataset marker was reserved. No model, threshold or guard changed after opening.

| Evaluator | Test teacher CE | Gain vs shipped | Test endgame CE |
| --- | ---: | ---: | ---: |
| shipped-hce | 0.398796661 | 0.000% | 0.297950636 |
| frozen-expanded-hce | 0.393803070 | 1.252% | 0.288541685 |
| smooth-6-12 hybrid | 0.384728907 | 3.528% | 0.288541685 |

| Comparator | Hybrid − comparator mean CE | Family-bootstrap 95% CI |
| --- | ---: | ---: |
| frozen-expanded-hce | -0.009074163 | [-0.011976511, -0.006219101] |
| shipped-hce | -0.014067754 | [-0.017553802, -0.010558250] |

Both confidence intervals are strictly below zero using the original 2,000 family-bootstrap draws, fixed seed 1050915 and 2,299 test families. Every original aggregate CE, MAE, RMSE, p99, phase coverage and phase CE guard passes against both comparators. Endgame scores remain exactly the expanded comparator across all 349 test endgames.

Independent JavaScript integer parity found **zero mismatches** on all 2,331 test rows. Maximum float/integer difference was **0.747 cp**; mean difference was 0.218 cp. Test receipt SHA-256: `2006086e8a42333dc7c36d15a09b1e6fdcb027adce32756bfbcd0b78145a2991`. The test opening is consumed and cannot be reused for another selected candidate.

The test used zero training fits and $0 paid compute. A separate completed-test audit **passed**, independently reconstructing test predictions, every metric and original guard, and both bootstrap intervals. The consumed opening and completion markers and exact source/model/data inputs were authenticated. Its SHA-256 is `8cfae1236fb003cc2b58cc1db9cf91b90ef50d59912880a3a7e97d8f5aba27e7`; counts and audit findings are preserved in the aggregate evidence.

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

## Compiled runtime and exact-score optimizations

The [compiled runtime study](../training/hybrid-runtime-results-2026-09.md)
measured all four actual modules on the same authored phase-balanced fixtures.
The frozen hybrid matched 501 independent complete-evaluation cases and passed
native move-transition checks before timing.

| Evaluator | Fast WASM bytes | Brotli bytes | Paired median 16K NPS vs shipped |
| --- | ---: | ---: | ---: |
| Shipped HCE | 37,172 | 17,690 | baseline |
| Expanded HCE | 37,470 | 17,808 | −6.07% |
| Complete H8 evaluator | 50,871 | 27,459 | −6.48% |
| Frozen hybrid | 58,085 | 28,857 | −17.82% |

The hybrid adds 11,167 compressed module bytes. Research modules allow one
additional 64 KiB memory page; production memory limits are unchanged. The
single-host Node timings are diagnostic, and different evaluators can visit
different search trees. They do not replace physical-device admission.

Two [separately registered optimizations](../training/hybrid-runtime-fused-results-2026-09.md)
cached raw material phase and shared duplicated HCE work. Their overall paired
median 16K NPS gains versus the concurrent original hybrid were only 0.402% and
0.418%, below the unchanged 5% requirement. Shared HCE work improved the
middlegame stratum 20.90% and reduced raw WASM to 55,047 bytes, but neither
mechanism was eligible. The conditional 200-game extension was skipped.
Available returned search fields matched; the separately required PV comparison
was not performed and is recorded as a protocol limitation. No claim of full
search/PV equivalence follows.

A review of the earlier eager-accumulator study identified one distinct untested
mechanism. A [separately registered lazy accumulator](../training/hybrid-runtime-lazy-v1.md)
updates neural state only along searched paths and materializes it when needed.
It passed its first native and compiled execution, including 13,919 authored
states, PVS re-search, quiescence, budget aborts and phase-reactivating promotions.
The independent cost audit reproduced 1,503 compiled scores, all 96 available
fixed-node result pairs and the complete 576-record grid.

The lazy implementation improved overall paired median 16K NPS **3.696%** versus
the concurrent original hybrid: opening +9.669%, middlegame +5.954%, endgame
−1.130%. It still missed the unchanged **5%** requirement, so its separately
registered 200-game follow-up was also skipped. Position and Undo stayed at
74 and 10 bytes, but the search-local cache added 9,216 bytes and the module grew
to 60,771 raw / 30,280 Brotli bytes. No timing-informed source change or retry
occurred. Its [full report](../training/hybrid-runtime-lazy-results-2026-09.md)
preserves the actual benefit and the failed gate; this is not a claim that all
possible incremental implementations have been exhausted.

## Equal-time development matches

The [initial 400-game batch](../training/hybrid-match-results-2026-09.md)
failed its complete evidence gate before score analysis: 62 files had become
truncated after their close-time hashes were verified. No subset score or Elo
estimate is valid from that batch. Its files and forensic findings remain
preserved. A separately registered infrastructure recovery uses the same
400 tasks, evaluator modules and 20 ms limits with exact emitted bytes retained
in memory and final audit from a complete archive.

The [replacement batch](../training/hybrid-match-recovery-results-2026-09.md)
completed and passed independent Python-chess replay: **400 games, 48,851
searched moves, 401 archive members, zero mismatches**. All game outcomes below
come from that complete authenticated archive.

| Candidate, each in a separate arm against shipped HCE | Wins | Draws | Losses | Candidate score |
| --- | ---: | ---: | ---: | ---: |
| Frozen hybrid | 57 | 52 | 91 | **41.5%** |
| Expanded HCE | 73 | 50 | 77 | **49.0%** |

These are exposed-opening development results at 20 ms requested per move,
not a direct hybrid-versus-expanded match or a formal Elo estimate. The hybrid's
mean observed time was 20.642 ms versus 20.500 ms for its shipped opponent;
its aggregate NPS ratio was 0.83334. Rare overshoots remain in the evidence.
Descriptive opening-cluster lower bounds were 36.56% and 43.82% respectively.
The held-out teacher-loss gain did not translate into stronger play in this
development comparison. **Keep the shipped HCE.**

Both conditional 200-game extensions were skipped under their separately frozen
speed gates. Their triggers were fixed before the relevant costs and recovery
game outcomes; no outcome-based retry or extension occurred. The original
invalid 400-game batch supplies no scores.

## Limits and remaining gates

Inner and outer results are reused development evidence. The subsequent one-shot test now provides held-out teacher-loss evidence for this frozen hybrid, with both original bootstrap and quality requirements satisfied. It does not establish Elo or justify shipping. The 12,392 neural parameter bytes exclude expanded-HCE coefficients and executable evaluator code; measured WASM sizes are above. Equal-time strength, physical-device performance, licensing and formal acceptance remain separate gates.

The six-gate search completed in 31.617 seconds. This continuation used zero new
training fits, zero new teacher labels and **$0 paid compute**; no Modal job was
launched. The $30 allowance was a ceiling, not a spending target. The registered
six-gate screen and three runtime implementation candidates are complete. All
three runtime candidates missed their frozen advancement requirement. This is
a bounded stopping decision, not universal model or runtime saturation.
