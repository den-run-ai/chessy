# Clean natural-game compact-evaluator pilot — 2026-09-14

## Scope

This is a separately preregistered, research-only study on the complete official CC0 January 2013 Lichess archive. It does not change the June 2026 production source, admit production labels, or certify Elo. The earlier random-continuation 4.7% loss result is not a directly comparable baseline because the data distribution and teacher budget differ.

## Source and selection

- Complete compressed archive: 17,761,302 bytes; SHA-256 `aa40b3671fa3cf1072eb182892cd90b0e1e003a4a5943492f64b77e7f3fd1635`.
- Full inventory: 121,332 games; 50,000 selected positions from 50,000 unique source games, 50,000 exact/mirror clusters, and 49,381 structural families. Maximum four positions per family, all within one role.
- Both ratings at least 1200, base time at least three minutes, complete legal games, one label-blind quiet candidate per game. Quietness uses the actual next recorded move; it does not prove every legal move is quiet.
- The seven frozen evaluation/incident/opening files contribute 2,179 quarantined clusters, 1,085 families and 40 known source-game IDs. Unknown upstream incident lineage remains unknown. Independent audit replayed all 50,000 selected prefixes and keys, authenticated the hash/framing inventory of all 121,332 raw source records and all artifact hashes, and independently recomputed 128 quiet-candidate selections. Quarantine and coverage checks reuse their frozen helpers. Zero observed source/family split overlaps or quarantine intersections; the family count is not a proven effective sample size.

| Role | Selected | Opening | Middlegame | Endgame |
| --- | ---: | ---: | ---: | ---: |
| shared-train | 35,031 | 17,982 | 11,109 | 5,940 |
| hce-validation | 5,033 | 2,582 | 1,568 | 883 |
| hce-test | 4,962 | 2,572 | 1,533 | 857 |
| nnue-validation | 2,510 | 1,349 | 770 | 391 |
| nnue-test | 2,464 | 1,292 | 759 | 413 |

## Frozen comparison

The baseline remains selectable. Two constrained surfaces are compared: 753 existing coefficients, and those coefficients plus six pawn-attack terms. PST changes are limited to ±10 cp; auxiliary coefficients to integer ±25% bounds; pawn attacks to 0–20 cp; unsupported columns stay at baseline. The four integer mobility coefficients remain positive. The positive regularization grid is selected on validation only.

Admission requires at most 10% exclusions, absolute teacher CP at most 2,000, and the frozen post-admission coverage gates. Train-only calibration is frozen before fits; exact integer runtime rounding, baseline WASM parity, minimum 0.5% CE gain, at most 2% CP MAE/RMSE deterioration, and phase loss guards determine eligibility. Only an eligible selection may open HCE test performance once. The same loss, CP-error and phase guards apply on test, with 2,000 family-cluster bootstrap replicates requiring the upper 95% CE-difference endpoint to be strictly below zero and at least 100 admitted rows per phase before scaling. NNUE roles remain reserved for modeling. The independent artifact audit mechanically parses all roles for integrity and legality; that does not compute candidate performance. A failed selection or transfer stops scaling; there is no automatic larger fit or neural-network rescue.

The [selection](https://github.com/den-run-ai/chessy/blob/c716a4c74a920168a1694f355738edf9921e0d31/eval/training/natural-pilot-v1.json), [fit](https://github.com/den-run-ai/chessy/blob/c716a4c74a920168a1694f355738edf9921e0d31/eval/training/natural-fit-v1.json), [teacher](https://github.com/den-run-ai/chessy/blob/c716a4c74a920168a1694f355738edf9921e0d31/eval/training/natural-teacher-v1.json) and [execution amendment](https://github.com/den-run-ai/chessy/blob/c716a4c74a920168a1694f355738edf9921e0d31/eval/training/natural-execution-v2.json) are frozen. The source-built SF18 executable SHA-256 is `ef2b67169e88bafb47f6f2311fe059c64f26e77344c5d507f05928d7fce25319`; this research identity is separate from the production prebuilt identity. Candidate arithmetic was first checked in Python/Node and then verified against the private compiled WASM, as reported below. Shared-player and broader opening dependence remain limitations.

## Infrastructure failure and disclosed replacement

The first attempt was interrupted after 5,593 partition records because two raw transcript paths had been replaced while writers still held their original descriptors. Their visible files contained only initialization lines. The cause of replacement is unproven. All observed files and hashes are preserved; that attempt is invalid, may not fit, and is never selectively resumed. No model was fitted and no test performance was inspected.

The corrected writer checks descriptor/path identity and size at every write boundary and rehashes actual published bytes at close. Sixteen adversarial test groups cover replacement, truncation, same-size overwrite, failure preservation, transport and admission. A separate eight-process, 16-search real Stockfish integration on authored development positions verified the corrected persistence path.

A separately recorded execution amendment permits exactly one complete replacement using unchanged data, splits, teacher, targets, budgets, eligibility, and numerical decision rules. Live output is kept in a local temporary directory and copied only after writers close and hashes verify. This is an infrastructure replacement, not an independent dataset or a score-based retry.

## Results

The replacement completed all 50,000 searches in 1,580.85 seconds (26.35 minutes): 47,203 accepted labels and 2,797 exclusions (5.594%, below the frozen 10% ceiling). Its closed summary SHA-256 is `8862475a1c4d22867832b6a7399da91f2a1a14f1aad26994826e98a8975bc26d`. Independent raw-evidence audit passed in 63.68 seconds: all 50,000 full source histories, raw UCI admissions, terminal bestmoves and exact partition joins; every one of the 47,203 accepted PVs replayed legally; zero mismatches. Actual file hashes, byte counts and line counts match across all eight workers. Audit report SHA-256: `5af7e6f2ef9d3f6d0668555ac2c43c7f0e2a35aeeb0b84b19a090c60bdc851d9`. The frozen fitting/transfer outcome is below.

| Role | Accepted | Opening | Middlegame | Endgame | Excluded |
| --- | ---: | ---: | ---: | ---: | ---: |
| shared-train | 33,103 | 17,459 | 10,550 | 5,094 | 1,928 |
| hce-validation | 4,717 | 2,502 | 1,469 | 746 | 316 |
| hce-test | 4,678 | 2,502 | 1,455 | 721 | 284 |
| nnue-validation | 2,374 | 1,310 | 732 | 332 | 136 |
| nnue-test | 2,331 | 1,260 | 722 | 349 | 133 |

The 1,633,597 raw UCI lines support 1,525 mate-score exclusions, 869 bestmove/PV mismatches, 399 search-depth rule failures, and four below-budget searches. These are failures of the frozen admission rule, not necessarily incorrect Stockfish scores. [Machine-readable admission summary](natural-pilot-admission-2026-09.json).

Before any fit, independent code review identified two consumer safeguards to enforce: mandatory binding and rehashing of successful audit evidence, and a canonical test-exposure marker independent of the caller's selection filename. These are pre-fit enforcement corrections, with the numerical preregistration unchanged and no model performance inspected.

The once-only frozen test passed. Validation selected the constrained 753 existing coefficients plus six pawn-attack terms at lambda 0.02; all 12 optimizers converged. No test-based retuning followed.

| Split | Rows | Baseline CE | Selected CE | Relative CE gain | CP MAE, baseline → selected | CP RMSE, baseline → selected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Validation | 4,717 | 0.404448 | 0.398888 | 1.375% | 131.99 → 129.78 | 183.33 → 181.38 |
| Held-out HCE test | 4,678 | 0.394056 | 0.388172 | 1.493% | 127.80 → 126.09 | 175.61 → 173.12 |

All three phases improve. The 4,678 test positions cover 4,622 structural families; the paired family-bootstrap 95% interval for candidate-minus-baseline CE is **[−0.007364, −0.004379]**. Frozen transfer guards pass. Baseline WASM reconstruction and Python/Node candidate arithmetic each have zero mismatches across the 42,498 consumed HCE positions. Subsequent private compiled parity is reported below; predictive accuracy alone is not playing-strength evidence.

Calibration reached its frozen upper bound, k=4.0, and was retained unchanged. Pawn attacks add only 0.00894% relative validation CE improvement over the best constrained753 fit; most gain comes from conservative retuning. No alternative vector is selected from test results. NNUE roles remain unused for model fitting/performance. [Weight-free fit report](natural-pilot-fit-2026-09.json); original full report SHA-256: a70fd8c11747d84bc8509dea208ba2630b1e90930856f6246fdb05953f819ada.

A separately [registered private runtime stage](https://github.com/den-run-ai/chessy/blob/c716a4c74a920168a1694f355738edf9921e0d31/eval/training/natural-runtime-v1.json), published before runtime measurements at commit 373060454ed1aa730e2cdce558b568779285d9b9, measured the exact selected vector. Its gates require a byte-identical baseline build, zero compiled candidate parity mismatches, at most 2% added raw/Brotli size, and at least 95% baseline throughput before any development matches at matched requested time limits. Production size limits and all admission rules remain unchanged.

## Runtime and compute

The shipped evaluator, five difficulty budgets, and WASM remain unchanged: 37,172 raw / 17,690 Brotli bytes. Modal spend in this session is $0. No GPU or hosted match workflow was dispatched; benchmarks and development matches ran locally.

A hypothetical H4/H8 two-perspective network would add about 6,180/12,356 bytes of i16 weights and i32 biases before code/metadata if appended to HCE. No H4/H8 quantizer or Rust integration currently exists. A neural screen requires its own preregistration and reserved roles. It is not an automatic response to a failed HCE playing-strength screen.

## Private compiled runtime checks

The pinned baseline rebuild is byte-identical and passes all seven Rust tests. The private candidate matches the frozen selected affine evaluation on **42,498 consumed HCE positions plus 1,050 authored fixtures**, with zero mismatches. Independent native parity also passes all 1,050 authored cases, including signed half ties, Black mirrors, pawn-attack edges and fixed mop-up behavior.

| Module | Raw bytes | Brotli bytes | Change from shipped |
| --- | ---: | ---: | --- |
| Shipped/rebuilt baseline | 37,172 | 17,690 | — |
| Private selected candidate | 37,478 | 17,793 | +306 raw / +103 Brotli |

Both private size gates pass using Node 22.23.2 / Brotli 1.1.0. Candidate WASM SHA-256 is `6a68f2a9513224129d7527044c12cb53d57c5c9193109b739abc857b5ef84dd2`. These bytes are private research artifacts; the shipped module and its production size ratchet are unchanged.

The candidate's unchanged baseline-specific Rust score-oracle test fails because it asserts the shipped evaluator's values; the other six tests pass. Some historical oracle fixtures contain adjacent kings and fall outside the frozen affine parser's legal-position domain, so no invented candidate expectations or weakened assertions were substituted. The original failure is preserved separately from the passing exact candidate parity. This is not a claim that the unchanged baseline-score suite passed for the candidate. [Static runtime evidence](natural-runtime-static-2026-09.json).

## Private fixed-node cost

The single preregistered local fixed-node run completed all 1,536 records, including warmups, in 61.17 seconds. Each budget has 288 measured baseline/candidate pairs across 96 phase-balanced training positions. Requested node totals match exactly on both sides.

| Node budget | Median paired candidate/baseline NPS | Aggregate candidate/baseline NPS | Frozen minimum |
| --- | ---: | ---: | ---: |
| 10,000 | 0.9830 | 0.9885 | 0.95 |
| 100,000 | 0.9746 | 0.9598 | 0.95 |

Both cost gates pass and the independent audit reproduces every metric from all 1,536 raw records, verifies their full histories/telemetry, and checks all 84 actual file identities plus original/archive equality. Independent audit SHA-256: `d09e69f002d8ca8d9d83c4ef1d8c1a757e6e4c602290832e6a56ad438628fd6a`. The aggregate throughput costs are approximately 1.15% and 4.02%. These local Node measurements are not mobile/browser/device certification. [Benchmark summary](natural-runtime-bench-2026-09.json). No selective or full rerun was made.

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

[Machine-readable match evidence](natural-runtime-match-2026-09.json) preserves all per-opening paired scores, timing totals and audit limitations. Closed summary SHA-256: `95f6afd4674a39371482c2311a5fce80da5e3afb24f749639bab5c32d62fa7a2`. Independent audit SHA-256: `3fc8b20037144669e50cf07752a71ae5eec5b71401a5a0237afbcebbbf6e36b8`.

## Separate production prerequisite

PR #171 fixes canonical NNUE E4 admission within draft PR #146's training foundation. The generic production HCE/NNUE consumers still need authenticated raw transcript/exclusion validation and exact selected → accepted XOR excluded partition checks. A synthetic-fixture reproduction at foundation `a2a8eb8625cd4b56f8cefdba9f6768ef7dc9eaf2` returned exit 0 for three teacher shards despite six nonexistent exclusion/transcript paths. This pilot's dedicated audit does not resolve that production-consumer gap. No real production data were admitted by that reproduction.

## Integration and validation status

PRs [#169](https://github.com/den-run-ai/chessy/pull/169) and [#170](https://github.com/den-run-ai/chessy/pull/170) merged into main, including the historical rounding correction, unchanged WASM size guard and diagnostic repetition-aware v2 execution. Their six-check PR runs and subsequent main checks passed. [#171](https://github.com/den-run-ai/chessy/pull/171) merged only into the draft training foundation; all seven checks passed on its exact head. [#172](https://github.com/den-run-ai/chessy/pull/172) merged only into the research branch after all seven checks passed, including 90 new focused research test groups. Its merge tree equals the tested head tree.

The immutable implementation is [c716a4c74a920168a1694f355738edf9921e0d31](https://github.com/den-run-ai/chessy/tree/c716a4c74a920168a1694f355738edf9921e0d31). Source, fit and runtime contracts were published before their respective measurements. No hosted CI reruns, paid jobs, production weight changes or difficulty recalibration were used for this experiment. Resolving generic production consumer evidence (#146), formal family/estimator policy (#156), signature admission (#155) and device evidence (#84) remains necessary before any later shipping proposal. More training volume alone does not satisfy those gates.
