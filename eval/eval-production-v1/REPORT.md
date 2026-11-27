# Production-compatible evaluation and the strength–time tradeoff

**HCE remains the production default. No tested time budget established an
advantage for the richer evaluator.** All 128 complete games and 13,590 searched
plies passed the retained closed-ledger audit. The candidate scored 32.81%,
42.19%, 51.56%, and 32.81% at 10, 25, 100, and 400 ms respectively. The sole
above-parity point estimate, at 100 ms, has a wide interval including parity.
No crossing or confirmation budget was established. The evaluator nevertheless
now builds against the production ABI and passes actual Chromium and WebKit
Play Worker contracts. [Prospective protocol](PLAN.md),
[complete audited results](GAME-RESULTS.json).

The deployment question is whether better evaluation compensates for the
search work it costs **within the same time budget**. A cheaper evaluator may
search deeper or wider and make better moves. Conversely, a richer evaluator
may need less search to resolve a position. Neither static prediction error,
fixed-node wins, nor nodes per second answers that question alone.

## What is ready for production integration

The builder captures production commit
`2cf89b6e2ff7c7f2f11c2bf39e4c9b7bc99d28e0` (r85), preserves its search and move
generation sources, and embeds the unchanged selected full model as immutable
tables. HCE and residual calculations share board-mask extraction; their
integer interpolation still rounds separately. HCE-only and learned evaluation
are separate compiler instantiations. Research model upload, batch-position
buffers, runtime evaluator switching, and the full-board evaluation cache are
absent from these WASM artifacts. The full coefficient payload remains 16,712
bytes. [Build and export contract](../../tools/eval_pipeline/BUILD.md).

The original 405-page memory allocation could not fit even the specialized
HCE, exceeding the linker requirement by 220 bytes. Candidate builds therefore
explicitly reserve one additional 64 KiB page: 26,607,616 bytes instead of
26,542,080. A memory-matched original HCE supplies the comparison control. The
stack and transposition table are not reduced, and memory remains fixed with
growth disabled. This is an experimental allocation; shipped assets are
unchanged. The selected sparse SIMD module is 58,487 raw bytes, versus 37,210
for original HCE. Coefficient compression alone is not a download-size or
startup claim. [Artifact definitions and memory tests](../../tools/eval_pipeline/BUILD.md).

The real ABI-v2 interface preserves seeded Play, repetition history, fixed
search, exact-root coaching, cumulative analysis budgets, White-perspective
scores, and PV export. The final full build passed 77 static-position checks,
408 repeated search executions, exact-root checks on 15 legal roots per
variant, and special-move/history/error contracts. The original control must
reproduce the shipped WASM byte for byte. See the
[actual-module contract](../../test/training/eval-pipeline-abi.test.mjs) and
[native parity tests](../../test/training/eval-pipeline-runtime.test.py).

## The completed cost study favors original HCE

The main study measured all six implementations on 72 exposed development
positions, equally divided among opening, middlegame, and endgame, at 10,000
and 36,000 nodes with three replicates: **2,592 search observations**. The
registered schedule rotated implementation order, reversed root order, warmed
all instances, and ran one host on CPU 0 after fitting/build work ended. It
used Node 22.23.2 with eager optimized WASM compilation, Rust 1.97.1, and
Binaryen 131. These are desktop Node measurements, not browser-device latency.
[Registration](COST-REGISTRATION.json).

| Implementation | Geometric mean engine-call time | Throughput relative to memory-matched original HCE |
| --- | ---: | ---: |
| Original HCE, original memory | 14.326 ms | 99.47% |
| Original HCE, matched memory | 14.250 ms | 100.00% |
| Shared HCE, scalar | 15.227 ms | 93.58% |
| Shared HCE, SIMD | 14.422 ms | 98.81% |
| Full learned evaluator, scalar | 16.779 ms | 84.92% |
| Full learned evaluator, SIMD | 15.960 ms | 89.29% |

All observations reached their exact node cap. Same-evaluator signatures
matched across implementations and replicates. The registered 0.5% tie rule
selected **memory-matched original HCE** and **sparse SIMD**. The new HCE
kernel did **not** improve measured HCE latency. The selected full evaluator
has 10.71% lower NPS, equivalently about 12.00% more elapsed time for this
fixed work. Its relative NPS is 85.67% in openings, 88.27% in middlegames, and
94.13% in endgames. [Results](COST-RESULTS.json).

An independent calculation reconstructed the complete schedule, exact node
caps, signatures, selections, and ratios from the closed ledger. This confirms
the reported measurements, without turning a descriptive implementation
ranking into a statistically stable winner claim. The earlier v2 throughput
ratio used a different experimental execution path and baseline; it is not a
paired before/after measurement of this production build.
[Independent audit](COST-INDEPENDENT-AUDIT.json).

## Refitting smaller architectures recovered useful quality

The earlier sparsification screen removed fitted coefficients without
refitting the survivors. This study registered two different experiments:
remove pawn context and refit the remaining families, or remove ray
interactions and refit. Both used all 799,145 authenticated training rows,
the original bounded convex objective and family weights, zero initialization,
and the fixed L1/L2 settings. Neither holdout nor OOD labels were opened.
Validation uses the already exposed 100,164-position development set, including
row-weighted and family-balanced guards.
[Complete refit results and protocol](REFIT-RESULTS.json).

| Integer evaluator | Validation CE | MAE / RMSE, CP | Retained full CE gain over HCE | Runtime coefficient bytes |
| --- | ---: | ---: | ---: | ---: |
| HCE | 0.679371 | 134.78 / 220.02 | — | — |
| Original full model | 0.674071 | 124.89 / 199.41 | 100% | 16,712 |
| Refit without pawn context | 0.674225 | 125.30 / 200.03 | 97.09% | 13,640 |
| Refit without ray interactions | 0.675041 | 126.43 / 203.37 | 81.70% | 15,360 |

Both optimizations converged numerically and passed the registered integer
quality guards. Family-balanced retained gains were 97.33% and 82.00%.
The exported models contain 2,460 and 2,315 nonzero integer coefficients.
Integer export remains outside the convex optimization; no global integer
optimality is claimed. An independent native extractor reproduced all
100,164 validation scores for each refit: **200,328 exact comparisons**.
[Refit results](REFIT-RESULTS.json),
[native parity audit](REFIT-NATIVE-PARITY.json).

Separate compiler flags eliminate the omitted learned tables and their
feature work. Necessary HCE pawn analysis and sliding geometry remain. A
second registered cost screen used 36 roots, 36,000 nodes, three replicates,
and six implementations: **648 observations**. Against the full-model
reference in that same screen, the SIMD refits improved whole-search NPS by
**1.66% without pawn context** and **1.72% without rays**. Their NPS relative
to HCE was 91.65% and 91.70%. Scalar versions were slower than the full SIMD
reference. All measured searches reached their exact node cap; same-model
scalar/SIMD signatures matched. [Refit cost results](REFIT-COST-RESULTS.json).

A small speed gain could matter at a fixed deadline. This study did not
register a 5% speed threshold, so the older screen's threshold cannot be
retroactively used to reject these refits. The present measurements also do
not prove that a 1–2% gain is stable or offsets the change in evaluation.
Each refit needs a separately registered equal-time campaign. Neither was
substituted into the already frozen full-model game comparison.

## Complete equal-time game results

The frozen comparison used the selected HCE/full implementations with no node
ceiling, maximum depth 30, and root seed zero. Sixteen opening pairs and both
candidate colors supplied 32 complete games at each budget. Openings were
selected prospectively by hash from the exposed 64-opening v2 bank, with budget
and first-color order interleaved. There was no resignation, score adjudication,
selective retry, or partial-outcome selection. Natural termination took
precedence over the 180 searched-ply cap. [Configuration](GAME-CONFIG.json),
[registration](GAME-REGISTRATION.json), [sealed completion](GAME-COMPLETION.json).

| Time per move | Candidate wins / draws / losses | Candidate score | Nominal simultaneous 95% interval | Cap draws |
| --- | ---: | ---: | ---: | ---: |
| 10 ms | 8 / 5 / 19 | 32.81% | 18.18–43.75% | 4 |
| 25 ms | 11 / 5 / 16 | 42.19% | 27.27–49.07% | 4 |
| 100 ms | 12 / 9 / 11 | 51.56% | 29.55–68.12% | 6 |
| 400 ms | 9 / 3 / 20 | 32.81% | 11.92–48.21% | 3 |

Draws count as half. The descriptive bands favor HCE at 10, 25, and 400 ms;
100 ms is inconclusive. The point estimate rises above parity and then falls
below it again. This supplies no supported crossover bracket, no interpolated
threshold, and no evidence that granting more time necessarily favors this
model. No setting meets the registered rule for proceeding to confirmation.
[Results and exact intervals](GAME-RESULTS.json).

![Relative Elo at the four registered budgets, with nominal simultaneous intervals](strength-time-frontier.png)

[SVG figure](strength-time-frontier.svg) · [figure provenance](strength-time-frontier.json).
Relative Elo is a score transformation for this exact opponent and budget,
not a calibrated human rating or a fitted curve.

The sixteen pairs belong to **ten coarse opening families**, one holding five
pairs. The bootstrap preserves both colors and all budgets within each family
draw, with an opening-weighted mean despite unequal family sizes. It uses
10,000 resamples and Bonferroni percentile intervals over the four controls.
These wide, approximate intervals describe exposed development data; they
neither guarantee coverage nor establish fresh source-game isolation.
[Prospective independent review](GAME-PROTOCOL-INDEPENDENT-AUDIT.json).

The retained auditor replayed all 128 games, 13,590 searched moves, complete
histories, and PGNs using Python chess rules and checked full JavaScript replay.
It reran no searches. All seventeen capped draws remain in the results.
[Normalized records](games.jsonl), [PGNs](games.pgn),
[canonical audit](GAME-RESULTS.json). A separate verifier checked all 14,009
raw events, reproduced outcomes and intervals, and freshly replayed 16,734
opening-plus-game plies through production JavaScript without loading WASM.
[Independent audit](GAME-INDEPENDENT-AUDIT.json).

### Realized timing and actual product limits

All four registered timing checks passed. Candidate/HCE time-limit-stop
medians differed by at most 0.31%. The table shows candidate / HCE values:

| Budget | Time-limit median, ms | Time-limit p99, ms | Full-request p99, ms | Mean completed depth |
| --- | ---: | ---: | ---: | ---: |
| 10 ms | 10.706 / 10.673 | 12.379 / 12.191 | 16.456 / 16.204 | 3.73 / 3.77 |
| 25 ms | 25.707 / 25.681 | 28.287 / 27.321 | 31.137 / 29.919 | 4.45 / 4.51 |
| 100 ms | 100.722 / 100.685 | 102.526 / 103.109 | 106.869 / 107.906 | 5.78 / 5.97 |
| 400 ms | 400.739 / 400.716 | 402.600 / 402.418 | 405.788 / 407.493 | 6.63 / 6.69 |

The complete results retain all-stop and full-request distributions, node
counts, and stop fractions. Game averages describe different encountered
positions; matched-root, fixed-node measurements describe whole-search cost
on controlled workloads. Different evaluators can still traverse different
trees, so those ratios are not a pure evaluation-kernel microbenchmark. Passing the
registered median/p99 predicate is not a hard deadline guarantee: deadline
checks occur every 1,024 nodes, and the predicate does not itself enforce an
absolute lower duration or all-stop/full-request limits.
No time-limit stop undershot its requested duration. Rare maxima still
included a 225.282 ms HCE full request and a 51.046 ms candidate engine call
at the 10 ms control. The ledger does not establish the cause of those
outliers; representative device measurements and tail-latency requirements
remain separate activation checks. [Timing results](GAME-RESULTS.json),
[independent distributions](GAME-INDEPENDENT-AUDIT.json),
[predicate review](GAME-PROTOCOL-INDEPENDENT-AUDIT.json).

This pure-time grid does not confirm an actual product preset. Shipped
Easy/Medium/Hard/Expert use 10k/10k/36k/230k node caps with a 5-second deadline;
Easy also limits depth to two. Master uses 8 seconds, maximum depth 111, and
no node cap. `forClock` can shorten these deadlines according to the remaining
clock and increment. The 10–400 ms study provides no Master-strength claim;
future confirmation must bind the intended preset/clock policy and devices.
[Current preset source](../../assets/level-presets.js).

## History motivates a time grid, not a universal crossover

The remembered natural-game pilot did score 42.50% at 50 ms and 58.75% at
200 ms, but it used a different compact evaluator, only twenty opening pairs,
and intervals that both included parity. The separate NNUE H128 study scored
51.20% at 50 ms and 49.83% at 200 ms, also inconclusively. Earlier HCE
level/time studies show why more search can help; their different opponents,
budgets, and hosts do not calibrate milliseconds to universal Elo.
[Historical evidence and exact sources](HISTORY.md).

Relative Elo is `400 * log10(score / (1 - score))`, with the score interval
transformed as well. The analyzer assumes neither monotonicity nor a crossing,
and no point-estimate transition activates a model.
[Analyzer](../../tools/eval_pipeline/frontier.py).

## Browser correctness and the remaining activation conditions

Actual Chromium and WebKit candidate Worker checks passed in
[CI run 46022918601](https://github.com/den-run-ai/chessy/actions/runs/46022918601)
for commit `637ce8d82fc9ca5dafd48f27a1179427ff44f8bd` on
[PR #202](https://github.com/den-run-ai/chessy/pull/202). These checks cover
seeded Node/browser signatures, full-prefix history, legal moves, request
identity/ordering, warm reuse, and structured fetch/compile/search failures.
All six CI-built modules are byte-identical to the local game build. Retained
receipts identify Chromium 149.0.7827.55, WebKit 26.5, and Playwright 1.61.1.
Cold/warm timings are descriptive correctness probes, not latency estimates.
[CI receipt summary](ci/SUMMARY.json), [Worker contract](WORKER.md).

The current Worker keeps its first WASM promise, including a failed promise.
Changing `wasmUrl` on a warm Worker does not change its model. Any future
budget-based policy must select or recreate a correctly identified Worker
before the search, keep one evaluator throughout that search, and preserve
release/model/cache identity. Activation still requires fresh strength
confirmation at relevant budgets, representative browser/mobile timing and
memory checks, coherent offline release assets, coaching score-scale checks,
and a reversible HCE fallback. No default or runtime policy changes here.
[Integration requirements](../../tools/eval_pipeline/BUILD.md#production-activation-contracts).

## Reproduction, retained identities, and limits

[Pipeline commands](../../tools/eval_pipeline/README.md) cover preparation,
cost registration/execution/audit, complete games, and audited plots.
[Build instructions](../../tools/eval_pipeline/BUILD.md) describe pinned tools,
explicit memory, strict refit import, and exact artifact reproduction.
Execute each campaign's retained source snapshot and use new exclusive output
directories; do not overwrite failures or reinterpret old observations.

| Identity | SHA-256 |
| --- | --- |
| Full model | `4d6f94bd3b13e77604c087b9cd41bd4f7f0a119cc6b3d57d381ca8bf6d6d9304` |
| Original data manifest | `16676c7aca9ea410b8c0518594fb78527668d00f6b3f343fe6c5c6f70883723e` |
| Original packed manifest | `06da0458290bbede70b5ea1a2ffc7ca57cefa5af9ff6c3ea38d2eefc7ea8a13a` |
| Refit without pawn context | `222e0157eefd08009477ecdc04986406844e29e7927c96f9662fd038eccfddf2` |
| Refit without ray interactions | `c14d4bf4bffa1be3034a2b1151c393615a654699236207b4901aefd2643ad872` |
| Main cost ledger | `36d08d277d9930eb3e2135a0fa9dd4e622e9d045a7cdafc54172320374d91524` |

The thin evidence delivery is not a self-contained training dataset. Refitting
or strict refit import requires restoring authenticated original train and
validation inputs and reconstructing any omitted packed arrays to their
original hashes. The new restoration helper was exercised on a separate thin
copy: all 18 omitted files were restored and all 49 inventory identities
verified; both independent model imports passed. It opens no holdout data and
does not refit. [Restoration verification](REFIT-RESTORATION-VERIFIED.json).
The earlier 456,904,369-byte data archive has SHA-256
`d921612ff1c062a635092def504a1505460ffdb7c47774752e8dd53c72d3a638`;
its inventory, source identities, licensing, and restoration instructions are
in [DATA-ARCHIVES.json](../sparse-pesto-v1/DATA-ARCHIVES.json),
[DATA-MANIFEST.json](../sparse-pesto-v1/DATA-MANIFEST.json), and
[REPRODUCTION.md](../sparse-pesto-v1/REPRODUCTION.md).

The original evaluation dump lacks source-game IDs, and the validation/opening
banks have been exposed during development. Hash verification and legal replay
do not repair those limitations. Production strength remains a separate
empirical requirement.
