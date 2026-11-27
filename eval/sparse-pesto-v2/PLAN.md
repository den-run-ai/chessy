# Sparse PeSTO runtime and playing-strength study v2

The owner requested further optimization and actual equal-time A/B/self-play
after the v1 prototype. This is a new bounded research study, dated 2026-11-26
Pacific. V1 weights, observations, holdout results and rejected edits remain
unchanged. Production activation and Elo certification are not inferred from
this development study.

## Questions

1. How much cost comes from feature extraction, table representation, repeated
   evaluation and the execution target?
2. Can exact narrow tables, shared board scans, verified caching, SIMD or
   independent-worker parallelism reduce that cost in native Rust and WASM?
3. Does further structured sparsification or four-bit quantization preserve
   enough predictive quality to justify a faster alternative?
4. Does the selected evaluator improve complete games at equal time, and how
   does that compare with equal-node play?

## Boundaries

Use the exact pinned r84 engine/search/HCE source already retained in v1. The
learned full coefficients stay fixed for all exact runtime variants. Preserve
HCE rounding and residual rounding independently, draw history, legal moves,
shared node accounting, score perspective and all returned search fields.

Profile the existing implementation once with instrumentation before choosing
the bounded exact implementation grid. Instrumented timing is a mechanism
diagnostic, separate from comparative benchmarks. No hardware profiler is
assumed available. Exact candidates may narrow storage only after validating
every relevant coefficient/table range; no saturation or modular arithmetic
may silently change a score. Any evaluator cache must verify the complete
evaluation-relevant state on a hit, invalidate when models change and fail
closed on collisions.

The exact grid is compact tables with the original HCE call, a fused HCE and
residual scan, and the fused implementation with a bounded verified evaluator
cache. SIMD is a separate build/code variant of the same scalar function, with
actual emitted instructions inspected. Native and WASM share the numeric
implementation. No production WASM thread, allocator or memory contract is
changed. Independent worker throughput and individual-search latency are
reported separately; concurrent work never overlaps single-search timing.

## Sparsification

[PRUNING-CONFIG.json](PRUNING-CONFIG.json) freezes nine model recipes and
validation-only quality guards before reading their performance. Full stays
mandatory. At most one qualified alternative is selected using a separately
frozen WASM cost comparison before any game result. The old primary holdout
and OOD sample are not reused for selection. Previously exposed validation
results are development evidence, not an independent accuracy certification.

## Execution-target comparison

Record pinned Rust, Binaryen and Node/V8 identities and all compiler flags.
Measure in-module repeated static evaluation as well as full search, with
balanced target/candidate order, warm-up, complete raw observations and exact
numeric checks. Report native, scalar WASM and SIMD WASM independently. Node
desktop WASM does not establish WebKit, physical-iPhone or production browser
cost. A build flag is not evidence of SIMD use or a performance benefit.

Cost roots are selected without labels from validation, disjoint from game
roots. Freeze the final timing protocol and all binaries before recording
comparative observations. Choose exact runtime variants by this declared cost
screen; never use game outcomes to tune implementation or select a model.

## Complete-game development screen

The game agent freezes a distinct protocol and bank:64 natural source games,
unique endpoint and early-opening structural families, color-reversed pairs,
complete legal histories, no overlap with prior primary/OOD/quarantine
families. Primary budget25ms per move; secondary10,000nodes per move; maximum
180 additional plies and depth30. Fixed r84 root order is declared as seed0;
seed slots are not invented as independent openings.

Mandatory full/HCE comparisons use both budgets. A single qualified faster
model may additionally play HCE at the primary budget, for at most384 games.
The final model/runtime identities and profile inventory are frozen before
the first game. WASM is the primary gameplay target. No evaluation-based
resignation or adjudication is allowed. Terminal rules precede the ply cap;
capped games are disclosed separately. Preserve every game, per-move budget,
result and PGN; no outcome-based stopping, shard replacement or retries.

Report paired opening-cluster uncertainty, wins/draws/losses, cap rate, nodes,
depth and elapsed time. The smaller screen is diagnostic, not the repository's
400-opening/800-game formal admission. A negative or inconclusive complete
result remains part of the record. Model and implementation selection stop
before game outcomes are opened.

## Reproduction

Every experiment executes an immutable source snapshot. Hash and consume the
same input bytes, reserve output paths without replacement, preserve partial
failures, and publish completion metadata last. Correctness tests cover the
new trust boundaries and are wired into CI. Large raw evidence is retained
separately; source, plans, models and compact result receipts remain in Git.
