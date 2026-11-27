# Sparse PeSTO v2: runtime and playing-strength study

## Decision

The full model has an exact, substantially smaller runtime. On the registered
workload, WASM SIMD with shared HCE/residual evaluation is selected for games;
no additional pruning recipe satisfies both the quality and speed requirements.
The completed, independently replayed games **do not demonstrate an equal-time
playing-strength improvement**. At 25 ms per move the full model scores 44.14%;
at equal 10k nodes it scores 54.69%. Both descriptive 95% intervals include 50%.
Keep HCE as the production default and retain this evaluator as research. The
exact runtime work is useful, but faster inference and better teacher-score
accuracy have not established better timed play.

This study answers the owner's follow-up on native versus WASM overhead,
precision, sparsification, cache behavior, vectorization, parallelism and actual
matched-game performance. It is a separate, bounded development experiment.
The v1 fit, holdout/OOD observations and rejected LP edits remain unchanged.

## Exact implementation changes

The original 17,280-coefficient representation and selected full weights are
fixed. The new implementation changes how the same function is computed:

- **Lossless narrow tables.** Full-model coefficients and all derived lookup
  sums fit signed eight-bit values. Combined PST/own-king terms range from
  −105 to 117; all bounds are checked at load time. MG/EG values are adjacent
  in memory. Coefficient payload falls from 64,544 to **16,712 bytes**, a
  **74.1% reduction**. Including four feature-family flags gives 16,716 bytes.
  These figures exclude HCE/geometry constants, search state and optional cache.
- **Shared evaluation work.** One board analysis supplies material phase, pawn
  masks, occupied pieces, knight occupancy and adjacent occupied-ray geometry
  for both HCE and the residual. Sliding mobility and ray interactions reuse
  geometric work. The two phase interpolations retain separate integer
  division: combining their numerators would sometimes change a score.
- **Verified caching.** The optional 1,024-entry cache verifies all 64 board
  bytes and both king squares after its hash lookup. It clears per search;
  model changes cannot reuse entries. Collisions cannot substitute another
  board's evaluation. The cache structure occupies **73,752 bytes**; these research binaries reserve
  it even when compact or fused evaluation is selected.
- **Explicit SIMD.** SSE2 and WASM SIMD128 identify occupied squares with
  byte comparisons and bit masks, then feed the same ordered piece iteration.
  The WASM SIMD build also permits compiler vectorization. Disassembly checks
  confirm actual emitted SIMD; scalar WASM contains none. Native “scalar” means
  the explicit helper is disabled, not that compiler auto-vectorization is
  forbidden.

The flat, compact layout keeps related lookups close together and removes
repeated extraction work. No recursive cache-oblivious algorithm is claimed;
with this table size, that would be a different implementation requiring its
own measurement. Parameter sparsity alone does not remove the cost of finding
active board features.

The separate original king model needs a minimum fused value of −134. Its
explicit wide build stores only the fused table in 16 bits, giving 22,856
coefficient bytes. No model is silently clipped to fit the narrow build.

Implementation and numeric contracts: [NATIVE.md](../../tools/sparse_eval_v2/NATIVE.md),
[core.rs](../../tools/sparse_eval_v2/core.rs),
[simd.rs](../../tools/sparse_eval_v2/simd.rs), and
[WASM adapter](../../tools/sparse_eval_v2/wasm.rs).

## Native Rust and WASM cost

The prospective [cost configuration](COST-CONFIG.json) selected 72 validation
positions without teacher labels: 24 per phase, distinct structural families,
excluding all 24 previous timing roots. Every combination ran at 10,000 and
36,000 nodes, three balanced replicates, with the same fixed warm-up. One
measured process ran at a time, pinned to CPU 0. Compilation, parsing, process
startup and warm-up were outside engine timers.

The grid contains 10,368 full-model search observations and 72 static
observations. The subsequent declared pruning grid contributes 1,512 more
search observations. The independent audit reconstructs all **147 raw
invocations and 11,880 search rows**, including signed static checksums,
ordering, executable/module/model identities, complete grids, exact search
signatures and both selection decisions. It executes no engine and reads no
teacher labels. [Results](COST-RESULTS.json), [audit](COST-AUDIT.json),
[registration](COST-REGISTRATION.json).

The table pools the two node budgets using geometric means. HCE-relative NPS
is paired on the same root, budget, replicate and compiled target; it is not a
comparison of evaluations with different requested work.

| Execution target | Implementation | Candidate million nodes/s | NPS / paired HCE |
| --- | --- | ---: | ---: |
| native-scalar | compact | 0.852 | 0.790× |
| native-scalar | fused | 0.949 | 0.867× |
| native-scalar | cached | 0.938 | 0.882× |
| native-simd | compact | 0.867 | 0.819× |
| native-simd | fused | 0.944 | 0.911× |
| native-simd | cached | 0.955 | 0.928× |
| wasm-scalar | compact | 0.680 | 0.783× |
| wasm-scalar | fused | 0.728 | 0.871× |
| wasm-scalar | cached | 0.744 | 0.893× |
| wasm-simd | compact | 0.709 | 0.793× |
| wasm-simd | fused | 0.798 | 0.921× |
| wasm-simd | cached | 0.773 | 0.934× |

The declared WASM selection minimizes full-candidate elapsed time across both
budgets, roots and replicates. It selects **SIMD/fused**, approximately **17.3%
faster** than scalar/compact on this same grid. Native's descriptive winner is
**SIMD/cached**, approximately **12.1% faster** than native scalar/compact.
Native scalar/fused is only about 0.6% slower than that native winner; this is
not evidence of a robust native cache or SIMD advantage across machines.

The winning full models retain approximately **92.1% of HCE throughput in
WASM** and **92.8% natively**. Thus the residual evaluation cost exists on both
paths. The selected native configuration is about 19.7% faster than the
selected WASM configuration on this host, but this is a portable-native versus
V8 build comparison, not an inherent Rust-versus-WASM performance constant.

The cache records roughly **21.4% hits at 10k nodes and 17.5% at 36k** in the
WASM grid. Even so, WASM SIMD/cached is about 3.2% slower in full-candidate
elapsed time than SIMD/fused. Hashing, full-key verification and added memory
traffic have a cost. Repeated static-position benchmarks are explicitly
labelled warm-cache microbenchmarks and never select the runtime.

The original v1 timings remain historical evidence on their original 24 roots.
This study does not relabel them as a direct matched old-versus-new trial.
The compact/fused/cached comparisons above use the same newly frozen roots,
models, compiler settings and complete search-signature checks.

### Execution scope

The source baseline is the pinned **r84** engine/evaluator/search from
`5e3558378deab8ba21f648cc2cca98195b1beced`. The current application is a separate
release; these results do not silently rebaseline its root ordering or policy.
Rust is pinned to 1.97.1/LLVM 22.1.6, Binaryen to 131, and the measured host to
Node 24.22.3/V8 13.6. Native uses portable x86-64 code generation. WASM uses
fixed 32 MiB memory and optimized compilation before measurements, with
`--no-liftoff --no-wasm-lazy-compilation`.

The VM exposes a Xeon Platinum 8573C and nine CPU affinity slots. Cgroup quota
and throttling files are unavailable; absence of those files does not prove
an unlimited quota. This is one desktop Node/V8 host. Cold startup, browser UI,
WebKit, physical phones and production integration are not measured here.

## Further sparsification and lower precision

Nine recipes were frozen before validation scoring. The quality guard requires
at least 75% of the full model's CE gain over HCE, at least 0.5% CE improvement
over HCE, MAE/RMSE within 3% of full, and no phase worse than HCE in CE. Eligible
recipes then use the selected full WASM target/implementation on the predeclared 36-root
subset of the 72 cost roots (first 12 per phase), for three 36k-node replicates. A model needs **at least 5% paired
actual NPS gain** to enter optional game testing. Neither old holdout nor OOD
performance selects these recipes. [Configuration](PRUNING-CONFIG.json),
[quality results](pruning/results.json), [pre-game selection](GAME-SELECTION.json).

| Recipe | Nonzero coefficients | Validation CE | Quality guard | NPS / optimized full |
| --- | ---: | ---: | --- | ---: |
| full | 2,621 | 0.674071 | Pass | 1.000× |
| drop-abs1 | 2,406 | 0.674084 | Pass | 0.934× |
| drop-abs2 | 2,206 | 0.674128 | Pass | 1.009× |
| drop-abs4 | 1,823 | 0.674335 | Pass | 1.017× |
| drop-rays | 2,131 | 0.675846 | Fail | Not admitted to timing |
| drop-pawn | 2,443 | 0.674577 | Pass | 1.019× |
| drop-pawn-rays | 1,953 | 0.676314 | Fail | Not admitted to timing |
| q4-per-phase-family | 1,737 | 0.674418 | Pass | 0.999× |
| king-original | 2,118 | 0.675298 | Pass | 1.042× |

**No alternative clears both guards.** The original king model is closest at
4.24% faster, below the frozen 5% threshold, while retaining only 76.8% of the
full CE gain. Removing pawn-context terms gains about 1.88% speed and gives up
about 9.5% of the CE gain. Ray-family removal fails the quality guard, so it is
not timed or promoted into games.

The four-bit recipe rounds each MG/EG feature family to signed codes in
[−7,7] with its own integer scale. It retains about 93.5% of the full CE gain
but gives no speed benefit in this screen. Its reconstructed coefficients run
in the ordinary narrow tables; **packed-int4 inference is not implemented or
claimed**. Zeroing small coefficients also leaves most extraction work intact.
The selected game model therefore retains all original full-model weights.

## Correctness and failed infrastructure evidence

Native verification compares **1,201,968 exact score triples** over all 100,164
validation FENs and 12 build/variant configurations, plus 1,152 old/new fixed-node
search signatures. The later native wrapper revision changes warm-up/order
controls only; numeric sources stay identical and its focused contract test
passes. [Native parity](NATIVE-PARITY.json).

The WASM tests independently compare the Python feature model across authored,
generated and color-reflected positions and eight model recipes. They check
narrow/wide range handling, invalid-load state, exact scalar/SIMD outputs,
full-history repetition, castling, en passant, promotion, legal returned moves,
and optimized-flags CLI readiness. The complete cost grid additionally requires
identical full-model search signatures across both execution targets, every
variant and every replicate.

A pre-game CLI readiness smoke exposed a host startup failure: the old host
returned no output before accepting any search or game-bank position. The
adapter now resolves its canonical entry path, awaits CLI completion and
compiles/instantiates WASM eagerly outside timers. The corrected INFO and
HCE/candidate search contract passes. The original failure, original host
source and successful check remain retained. This was an infrastructure fix
before comparative observations, not a replay of game outcomes.
[Failure](HOST-PREFLIGHT-FAILURE.json), [successful check](HOST-PREFLIGHT.json).

## Complete-game screen

The [game protocol](GAME-PROTOCOL.md), [configuration](GAME-CONFIG.json),
[opening bank](GAME-BANK.json), [selection](GAME-SELECTION.json), and
[registration](GAME-REGISTRATION.json) were frozen before game output.
There are 64 natural source games with distinct endpoint families/clusters and
distinct ply-8 structural families, plus 37 coarser ply-4 groups for sensitivity.
Selected endpoints exclude every known primary-corpus family/cluster and the
prior OOD pool; all 4,096 prior OOD source games are excluded as well. The
primary evaluation dump lacks source-game IDs, so primary game-level separation
cannot be established. Each opening is
played with both candidate colors, without repeating deterministic games as
independent observations.

The full model faces HCE in 128 games at 25 ms per move and 128 at 10,000 nodes
per move. Both use the selected WASM module and unchanged search, with complete
legal history from the starting position on every request. There is no score
adjudication or resignation. Real endings take precedence over a 180-ply
post-opening cap. All 256 scheduled games must complete before outcome analysis.

All **256 games, 25,816 searched plies and 256 PGNs** passed the frozen independent
raw-ledger and JavaScript-rules replay. No searches were rerun. The producer used
python-chess; the independent outcome checker used the pinned Chessy JavaScript
rules engine and reconstructed every legal move, terminal condition, game result and
candidate point total. It does not rerun centipawn evaluation.
[Audited results](GAME-RESULTS.json), [complete campaign receipt](GAME-COMPLETION.json),
[game records](game-records.jsonl), [independent replay](game-rules-replay.jsonl).

Candidate results, counting a draw as half a point:

| Budget | Wins / draws / losses | Candidate score | Paired-opening 95% interval | Coarser-group 95% interval | Ply-cap draws |
| --- | --- | ---: | ---: | ---: | ---: |
| 25 ms per move | 44 / 25 / 59 | 44.14% | 36.70–51.58% | 37.36–50.92% | 19 |
| 10,000 nodes per move | 63 / 14 / 51 | 54.69% | 47.57–61.80% | 47.61–61.77% | 7 |

The intervals use **64 paired-opening scores**, not 128 independent games.
The sensitivity calculation groups those pairs into **37 coarser opening
families**, with at most 11 pairs in one group. Structural grouping does not
prove independence of named opening systems. These are descriptive development
intervals; this small screen does not qualify as the repository's formal
admission campaign, and no Elo conversion is made.

The equal-time point estimate favors HCE, and the interval does not establish
that the sparse evaluator is stronger. It also does not establish a two-sided
95% inferiority conclusion. At equal nodes the point estimate favors the sparse
model, but that interval includes 50% too. The two profiles use different work
levels—10k fixed nodes versus roughly 23k–24k nodes in a 25 ms move—so their
10.55-point score difference cannot be attributed entirely to the measured
runtime penalty.

### Actual budgets and work during games

The predeclared realized-time audit passes. Among time-limit stops, median
candidate search time is **25.5505 ms**, versus **25.5048 ms** for HCE, a ratio
of **1.00179**. The corresponding p99 times are **28.3805 and 28.2543 ms**,
well within the frozen 50 ms p99 bound. Total engine search time is 165.386 s
versus 164.975 s. This is not an apparent strength difference caused by giving
one engine materially more clock time.

Across equal-time game moves, candidate mean completed depth is **4.178**, versus
**4.267** for HCE. It searches 153,549,938 nodes over 6,649 moves, versus
162,827,369 over 6,654 HCE moves: about **23,094 versus 24,471 nodes per request**.
Those telemetry averages are descriptive because the engines encounter different
positions; the matched-root cost grid is the controlled throughput comparison.
The full-history verification harness has median request wall times around
31 ms for both engines; the 25 ms clock measures the engine call, not all
harness validation and IPC.

At fixed nodes, total actual node counts are closely matched (60,306,955 versus
60,278,686), with early mate/depth exits accounting for budgets below 10k.
Mean completed depth is 3.455 versus 3.511. Search depth alone is not a strength
metric because evaluation changes the visited tree and quiescence workload.

Nineteen equal-time draws and seven fixed-node draws reach the frozen 180-ply
cap. They remain draws in all statistics; no favorable continuations or
adjudications were added after observing outcomes. This horizon and the modest
number of opening families limit the conclusion.

## Independent-search parallelism

The separate, prospectively fixed [parallel protocol](PARALLEL.md) uses the same
selected full-model WASM SIMD/fused implementation. Each worker-count setting
executes 216 fixed-node searches: 72 distinct cost roots, three balanced-order
blocks, 36k nodes per search. All 648 outputs match the earlier cost signatures.
The independent Python audit reconstructs every job, identity, warm-up and
summary without running an engine. [Results](PARALLEL-RESULTS.md),
[raw result receipt](PARALLEL-RESULTS.json), [audit](PARALLEL-AUDIT.json).

| Processes | Aggregate nodes/s | Throughput / one process | Mean search latency | p95 latency | Peak worker RSS upper bound |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 744,252 | 1.000× | 48.05 ms | 75.33 ms | 75.70 MiB |
| 2 | 1,130,897 | 1.520× | 55.08 ms | 106.37 ms | 155.51 MiB |
| 4 | 1,525,671 | 2.050× | 72.14 ms | 134.57 ms | 304.01 MiB |

This improves **batch throughput**, while individual calls take longer. It
helps independent analysis or data-generation jobs; it does not accelerate one
move's search tree. Concurrent blocks varied materially, and CPU quota is not
observable. Four processes are not evidence of four CPU-equivalents of
entitlement. RSS sums are upper bounds from process-lifetime peaks, not
simultaneous memory samples; fixed WASM linear memory is 32 MiB per process.

## What this establishes and what to do next

The runtime hypothesis succeeds: exact compact coefficients, shared extraction
and vectorization remove a substantial portion of the larger evaluator's cost
on both native and WASM. The game-strength hypothesis is **not established**.
Neither a larger parameter table nor improved held-out teacher prediction is
sufficient evidence that alpha-beta search will choose better moves at a fixed
clock budget.

Retain the full weights for further work. The declared pruning experiments do
not justify giving up predictive quality for their observed speed changes.
Use SIMD/fused for the measured WASM research path, and keep native's near-tied
choices explicit rather than claiming a universal cache winner.

A subsequent model experiment should emphasize fresh search-leaf and
within-position move-ranking data, preserve value calibration for the search's
selective pruning, and freeze both its training/validation boundaries and game
campaign before results. Pairwise logistic losses over fixed feature differences
can remain convex; actually optimizing playing strength through changing search
is a separate problem. An exact incremental evaluator is also a plausible next
runtime experiment, especially for unchanged king buckets and local pawn/ray
updates, but its speed and correctness are not demonstrated by this study.

A larger fresh game campaign at intended production budgets and browser/device
measurements are needed before promotion. The completed games here are now
exposed development evidence and must not be reused as a fresh acceptance test.

## Validation and retained evidence

The final local suite passes **43 Python tests and seven Node contract checks**,
with four Rust unit contracts exercised within the native suite and no skipped
cases. The new tests are wired into the existing CI jobs. [Test receipt](TESTS.json).
A packaging-only cleanup normalizes the generated constants file to one final
newline and updates its generator accordingly; values and logic are unchanged.
The exact measured versions are retained in the source inventory, and the
authenticated generation check passes after normalization.
The measurement itself is additionally checked by independent cost, complete-game
and parallel-result auditors. No benchmark or game was rerun to get a preferred
number. All declared settings and negative results remain in the evidence.

[Source inventory](source-snapshots/SOURCES.json) resolves every recorded stage
implementation to exact repository bytes, including older native-wrapper,
failed-host and generated instrumentation versions. [Evidence copies](EVIDENCE-COPIES.json)
records exact hashes of compact receipts copied into this directory.

Raw observations, full game exchanges, PGNs, parity outputs and measured binaries
are retained separately. [DATA-ARCHIVES.json](DATA-ARCHIVES.json) records the
companion bundle's exact identity and download location. Repository-backed files
are referenced by exact Git blob and SHA-256 instead of being duplicated in that
bundle. The restore tool verifies the compressed archive and every reconstructed
file in a new directory, without executing experiments.

```sh
python tools/sparse_eval_v2/bundle.py restore \
  --repo /path/to/chessy \
  --archive /path/to/chessy_sparse_pesto_v2_evidence.tar.zst \
  --archive-sha256 SHA256_FROM_DATA_ARCHIVES_JSON \
  --output /path/to/new/evidence-directory
```

This restores the retained bytes; it does not rewrite original host paths in
historical command and executable receipts. Untouched historical audit commands
expect their recorded execution-path namespace. New measurements on another
host are separate observations, with that host's toolchain and paths recorded.
The source builders and CLI contracts are documented in
[NATIVE.md](../../tools/sparse_eval_v2/NATIVE.md),
[WASM.md](../../tools/sparse_eval_v2/WASM.md), [PARALLEL.md](PARALLEL.md), and
[GAME-PROTOCOL.md](GAME-PROTOCOL.md). The earlier million-position training data
remain in the [v1 archive inventory](../sparse-pesto-v1/DATA-ARCHIVES.json).
