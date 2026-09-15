# Hybrid evaluation dispatch counts

The single registered observer run completed with exact search parity.
Across 24 replay roots and 224,201 evaluation calls, the hybrid
used both endpoint evaluators for **12.78% of evaluation calls**. This measures
dispatch frequency, not component CPU time or potential speedup.

| Actual evaluation phase | Dispatch branch | Calls | Fraction |
| --- | --- | ---: | ---: |
| 0–6 | Expanded HCE endpoint | 82,259 | 36.69% |
| 7–11 | Blend of expanded HCE and shipped HCE plus H8 | 28,654 | 12.78% |
| 12–24 | Shipped HCE plus H8 endpoint | 113,288 | 50.53% |

The high-phase endpoint includes the primary shipped HCE calculation inside
the fused residual evaluator. It is not a neural-network-only computation.
The raw observer's historical `neuralOnly` label means this dispatch endpoint;
it does not separate HCE and neural instruction costs. Internal shortcuts and
feature-loop work are also outside these counters.

The [frozen selection receipt](selection-receipt.json) identifies 24 moves
chosen by salted SHA-256 from all 24,467 searched moves in the completed
fixed-node match. Selection used no outcome, score, phase or timing filter.
Each request retained its original FEN, full repetition map and search options.
Seventeen selected requests were originally played by the hybrid; seven were
originally played by shipped HCE. All 24 were searched with the original hybrid
and the observer, using 16,384 nodes, maximum depth 30, quiescence enabled and
no time limit. All **786,432 requested nodes** were consumed across 48 searches.
No warmup search, additional search, timing rerun or workload extension occurred.

The observer adds one 25-bin counter update after the existing phase prescan,
plus reset/read exports. The original eight source files were retained and
authenticated against the previously merged fitted-source receipt. The exact
observer transform was regenerated before execution; no evaluator arithmetic,
phase threshold, parameter, rounding rule or search policy changed. The pinned
build produced a 58,200-byte observer module, 115 bytes above the original.
Counter writes and changed code layout are observer overhead, so this study
reports no NPS ratio, elapsed-time comparison or wall-time shares.

All 24 original/observer pairs matched every returned move, score, completed
and attempted depth, node/qnode count, cutoff, re-search count and stop reason.
The 17 applicable original-hybrid outputs also matched their archived results.
An [independent Python audit](independent-audit.json) checked all 48 ordered records, all comparisons,
all 25 phase bins and the complete aggregate, without running any engine search.
The native counter reset/bin test passed, as did the generic fail-closed
inventory, parity, phase-endpoint and supervised-child tests wired into CI.

The sample is small and exposed. Uniform sampling over recorded moves lets
longer games contribute more roots; descendants within each search are
correlated. These fractions are not a population estimate and must not be
multiplied by earlier static-evaluation timing ratios. The separate
[static and runtime costs](../training/hybrid-runtime-results-2026-09.md),
[shared-HCE rejection](../training/hybrid-runtime-fused-results-2026-09.md), and
[lazy-accumulator rejection](../training/hybrid-runtime-lazy-results-2026-09.md)
remain unchanged. These counts do not reopen their failed gates or identify
which remaining component is the dominant runtime cost.

The [protocol](PLAN.md), [exact module registration](registration.json), and
[per-root counts and result hashes](results.json) are public. Module registration
was published in commit
[`e75e7c5`](https://github.com/den-run-ai/chessy/commit/e75e7c54ded3c3b0faadbb707b715f9e2c2747ee)
before the first search. Private fitted source, modules, full requests, raw
results and the independent audit are preserved together in the
[evidence receipt](evidence-preservation.json), with all 38 archive entries
verified against their retained hashes. No fitted source or model bytes are
published here. Paid compute: **$0**. Shipped evaluation, budgets and ratings
remain unchanged; this is no strength or admission result.

## Completed-scope retirement and execution review

After this run, PR review identified a reusable-runner gap: the parent could
hash a mutable checkout and then reopen its script pathname for the child.
Replacement and restoration between those checks could evade the final rehash.
The generator and registration entrypoints likewise did not bind the executing
CommonJS source bytes to the later pathname reads, and a directory-local
`started.json` alone could not prevent copied studies from creating new attempts.

The actual measured attempt used the retained, read-only execution snapshot
identified by the selection and evidence receipts. That snapshot, its exact
[historical runner text](../../tools/training/hybrid-eval-counts-historical-v1.js.txt)
(SHA-256 `42aa8eddbca4d1597710de4f971339d4f0523ae7f6f1c213468b51072f157aff`),
module registration, raw results and independent audit remain unchanged. No
search, build, measurement or statistical rerun was performed for this fix.
The historical text is evidence only and must never be executed.

This one-attempt v1 scope is now retired. The current module keeps only
read-only selection and result auditors. Every CLI invocation and every former
prepare, register, run, child, preflight or module-loading API fails before
inspecting its arguments or loading an engine. These unconditional guards also
cover copied runners, copied studies, fresh output paths, symlink aliases and
cached imports whose on-disk entrypoint is replaced and restored. No generic
launcher or fresh protocol was introduced. CI checks these boundaries and the
historical source hash alongside the existing count and parity checks. Any
future attribution experiment requires a separately reviewed new protocol and
an implementation that executes the same retained bytes it authenticates.
