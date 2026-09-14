# Natural-game compact-evaluator pilot — 2026-09-14

## Decision

The clean 50,000-position research pilot passed its frozen predictive test:
**1.49% lower teacher loss**, with improved CP errors and all three phases improving.
The subsequent 80-game development screen was mixed: **42.5% candidate points
at 50 ms and 58.75% at 200 ms**, with both 95% intervals including 50%.
**Stop this candidate here: no Elo/time improvement is established.** The shipped evaluator,
all five difficulty budgets, and WASM remain unchanged: **37,172 raw / 17,690
Brotli bytes**. This session used local CPU; Modal spend is **$0**.

## Authenticated data and admission

The complete official CC0 [January 2013 Lichess archive](https://database.lichess.org/standard/lichess_db_standard_rated_2013-01.pgn.zst)
contains 121,332 games. Its 17,761,302 compressed bytes match the
[official checksum](https://database.lichess.org/standard/sha256sums.txt):
`aa40b3671fa3cf1072eb182892cd90b0e1e003a4a5943492f64b77e7f3fd1635`.
This separate research source does not replace PR #146's June 2026 production
source or satisfy the million-position study.

Frozen, label-blind selection yielded 50,000 positions from distinct games,
with 49,381 structural families isolated across five roles. The seven frozen
quarantine inputs cover 2,179 clusters, 1,085 families and 40 known game IDs.
Unknown incident lineage and shared player/opening dependence remain limits;
family counts are not established effective sample sizes.

| Role | Accepted | Opening | Middlegame | Endgame |
| --- | ---: | ---: | ---: | ---: |
| Shared train | 33,103 | 17,459 | 10,550 | 5,094 |
| HCE validation | 4,717 | 2,502 | 1,469 | 746 |
| HCE test | 4,678 | 2,502 | 1,455 | 721 |
| NNUE validation | 2,374 | 1,310 | 732 | 332 |
| NNUE test | 2,331 | 1,260 | 722 | 349 |

Eight CPU workers completed all 50,000 full-history Stockfish 18 searches at
100,000 nodes in 26.35 minutes. **47,203 labels passed; 2,797 (5.594%) were
excluded**, below the frozen 10% limit. Exclusions comprise 1,525 mate scores,
869 bestmove/PV mismatches, 399 depth-rule failures and four below-budget
searches. These fail the frozen admission rules; they are not necessarily
incorrect Stockfish scores.

Independent auditing authenticated all raw source-record slices, replayed
every selected legal prefix and every accepted PV, reconstructed all 50,000
raw UCI admissions, and proved exact accepted/excluded coverage. There were
**zero mismatches** across 1,633,597 raw UCI lines. Independent full quietness
reselection covers 128 sampled games; recorded quiet human moves do not prove
all legal alternatives are quiet. Artifact auditing mechanically parses all
roles without computing candidate performance.

## Frozen fit and transfer

The comparison retains the baseline and tests constrained existing PeSTO
coefficients with or without six pawn-attack terms over six positive lambdas.
PST changes are bounded to ±10 cp, auxiliary weights to integer ±25%, and pawn
attacks to 0–20 cp; unsupported terms stay at baseline. Calibration uses train
only. Validation requires at least 0.5% relative CE improvement, no more than
2% CP MAE/RMSE deterioration, and no more than 1% phase CE deterioration.

Only an eligible frozen selection can open HCE test performance once. Transfer
also requires a strictly negative upper 95% CE-difference endpoint over 2,000
family-bootstrap replicates and at least 100 admitted test rows per phase.
Failure stops scaling and retuning. NNUE roles remain unused for model fitting
or performance evaluation.

Validation selected the 753 existing coefficients plus six pawn-attack terms at lambda 0.02. All 12 constrained optimizers converged.

| Split | Baseline CE | Selected CE | Relative gain | CP MAE, baseline → selected | CP RMSE, baseline → selected |
| --- | ---: | ---: | ---: | ---: | ---: |
| Validation | 0.404448 | 0.398888 | 1.375% | 131.99 → 129.78 | 183.33 → 181.38 |
| HCE test | 0.394056 | 0.388172 | 1.493% | 127.80 → 126.09 | 175.61 → 173.12 |

The test's 4,622 structural families produce a paired CE-difference 95% interval of **[−0.007364, −0.004379]**. All frozen transfer guards pass. Baseline WASM reconstruction and Python/Node candidate arithmetic agree across all 42,498 consumed HCE positions. Calibration reached its frozen upper bound, k=4.0, and was retained unchanged. Pawn attacks contribute only **0.00894%** additional validation CE improvement over the best existing-weight retune.

The exact selected vector passed private compiled parity on all 42,498 HCE positions and 1,050 authored cases. Its private WASM is 37,478 raw / 17,793 Brotli bytes (+306/+103); the shipped module is unchanged. The one complete local fixed-node benchmark passed independently audited cost gates: aggregate throughput is 1.15% lower at 10k nodes and 4.02% lower at 100k nodes. All 1,536 raw measurements and 84 file identities passed independent audit; the frozen 80-game development batch subsequently passed complete independent replay. The private candidate retains an explained failure in an unchanged baseline-only score assertion; exact selected-candidate parity passes, and production tests remain unchanged. A predictive test pass alone cannot establish an Elo/time advantage.


## Private development matches and final decision

The single frozen batch completed all **80 games and 9,882 searched moves**, with no execution failures, missing games, selective retries or full reruns. Independent Python replay found **zero mismatches** across complete opening histories, legal moves, repetition maps and terminal results. It authenticated actual frozen inputs and rechecked the entire fixed-node prerequisite. All 81 closed original files match their 81 archived copies.

| Requested time per move | Candidate W / D / L | Candidate points | Opening-pair bootstrap 95% interval | Ply-cap draws |
| --- | ---: | ---: | ---: | ---: |
| 50 ms | 12 / 10 / 18 | 42.50% | 28.75%–56.25% | 7 |
| 200 ms | 15 / 17 / 8 | 58.75% | 48.75%–68.75% | 10 |

Each budget uses the same 20 historically exposed openings in both colors. The frozen 2,000-replicate bootstrap (seed 1370915) resamples opening pairs; those pairs are not proven independent families. Both intervals include 50%, and the point estimates move in opposite directions across budgets. The 180-searched-ply cap produces separately identified diagnostic draws; it is not an adjudicated chess draw.

| Requested time | Candidate / baseline mean actual ms per move | Candidate / baseline mean-time ratio | Candidate / baseline total actual ms | Candidate / baseline move count |
| --- | ---: | ---: | ---: | ---: |
| 50 ms | 49.196 / 49.181 | 1.000306 | 116,988.030 / 117,149.001 | 2,378 / 2,382 |
| 200 ms | 194.686 / 195.116 | 0.997792 | 498,979.129 / 499,302.630 | 2,563 / 2,559 |

Actual elapsed search time is recorded per move; matched requested limits do not imply exact elapsed-time or CPU equality. Four games ran concurrently in complete waves. Replay authenticates the recorded search metadata and checks its consistency; it does not independently certify engine timing internals. This local diagnostic is not a mobile/browser/device or formal holdout measurement.

**Stop this candidate here.** The clean predictive improvement survives held-out transfer, but these matches do not establish an Elo/time advantage. There is no statistical win claim, Elo conversion, score-based retry, post-test alternative selection, larger match dispatch or automatic neural-network rescue. The exact selected weights remain private; production evaluator, size ratchet and all five level budgets remain unchanged. Reserved NNUE roles and the formal 400-opening holdout remain unused for model performance or search.

[Machine-readable match evidence](natural-pilot/natural-runtime-match-2026-09.json) preserves all per-opening paired scores, timing totals and audit limitations. Closed summary SHA-256: `95f6afd4674a39371482c2311a5fce80da5e3afb24f749639bab5c32d62fa7a2`. Independent audit SHA-256: `3fc8b20037144669e50cf07752a71ae5eec5b71401a5a0237afbcebbbf6e36b8`.

## Execution and remaining boundaries

The first label attempt was invalidated after 5,593 partition records when two
transcript paths were replaced during live writes. The cause is unproven; all
observed evidence is preserved. Exactly one complete infrastructure replacement
was registered before restarting, with unchanged scientific rules and no model
performance inspected. The replacement completed and passed its independent
audit. This is a disclosed retry, not a fresh independent dataset.

Before fitting, review also enforced mandatory audit-evidence rehashing,
canonical test-exposure state that survives copied selection files, and pinned
numeric dependencies. These changes preserved the numerical preregistration.

PR #171 fixed canonical NNUE E4 admission within draft PR #146's foundation,
not main. The generic production consumers still lack authenticated raw
transcript/exclusion partition checks. A synthetic reproduction returned exit
0 despite six missing evidence files. This pilot's dedicated audit does not
resolve that defect. Formal match-family, signature and device gates also
remain open. Teacher loss cannot authorize runtime integration or level
recalibration.

See the [full report and compact evidence](natural-pilot/REPORT.md) and
[immutable research implementation](https://github.com/den-run-ai/chessy/tree/c716a4c74a920168a1694f355738edf9921e0d31).
PRs #169/#170 merged into main; #171 merged only into the training foundation
and #172 only into the research branch. Their required CI checks passed.
Raw experiment artifacts are preserved separately; no fitted vector or neural
network is committed to the game.
