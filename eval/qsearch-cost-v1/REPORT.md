# Qsearch cost diagnostic: exact trees, modest desktop gains

The smaller quiet-check prefilter was **2.58% faster** on the frozen fixed-node
development screen. Adding direct tactical generation increased code size and
reduced the gain to **2.00%**. Every fixed-node search signature matched.
At the shipped five-second Master budget, the selected prefilter gains2.41%
throughput, with one deeper and one shallower result among36 paired trials.
Neither variant changes the shipped engine or establishes an Elo gain.

## Scope and controls

This study starts from main `d56a745`. `tools/search/qsearch-cost.js` writes
standalone source snapshots outside the repository; production engine sources,
WASM, evaluator, levels, and the r69 signature fixture are unchanged. The
`checks` candidate conservatively rejects impossible quiet checks before the
original make/check/unmake probe. `tactical` additionally generates captures and
promotions directly below the first quiescence ply, retaining full legal-move
fallback for stalemate and full-width check evasions.

The checked tactical-defense family includes the historical #89 quiet-mate
incident. Quiet checks are deliberately preserved; this is not a retry of the
rejected SEE/LMR/null-move variants. No training, teacher labels, paid compute,
new formal games, or device-certification claims are involved.

## Frozen fixed-node screen

The complete [registration](fixed-registration.json) predates execution;
[raw results](fixed-results.json) retain all 648 rows. The exact
[runner snapshot](fixed-benchmark-source.js.txt) preserves the dependency hash
from before the separately registered Master-depth correction. The exposed corpus is
18 positions from nine mirrored families, each tested at 10k/36k/230k nodes,
maxDepth111, quiescence enabled, four repetitions and rotated engine order.
The local CPU was reserved for this screen; the hybrid match began afterward.

| Variant | Geometric mean speed gain | 10k nodes | 36k nodes | 230k nodes |
| --- | ---: | ---: | ---: | ---: |
| Quiet-check prefilter | +2.58% | +0.39% | +2.99% | +4.41% |
| Prefilter + direct tactical generation | +2.00% | +0.65% | +2.65% | +2.72% |

These are equal-weight geometric means of paired reference/candidate elapsed
ratios, not Elo estimates or confidence bounds. All 648 returned signatures
match within each position/budget, including move, score, completed/attempted
depth, nodes, qnodes, cutoffs, re-searches and stop reason. The low-budget
measurements are noisier and show little gain. Completed depth never exceeds13
in this fixed-node screen, below the shipped ceiling30.

| Family (both colors; all budgets) | Prefilter speed gain | Prefilter + tactical speed gain |
| --- | ---: | ---: |
| opening (Ruy Lopez) | +5.48% | +3.76% |
| open middlegame (Dragon) | +4.14% | +4.17% |
| closed middlegame (KID) | +5.39% | +6.68% |
| tactical middlegame (Kiwipete) | +0.47% | +0.59% |
| rook ending (Lucena) | +2.42% | -3.76% |
| minor-piece ending | +4.07% | +3.07% |
| promotion race | +3.47% | +4.19% |
| pawn ending (zugzwang) | -2.49% | +1.03% |
| tactical defence (chessy202607240238) | +0.57% | -1.32% |

The direct tactical generator loses 3.76% on the rook-ending family: probing
captures first can fail to find a legal tactical witness, after which it must
also generate the full move list. The simpler prefilter loses 2.49% on the pawn
ending. These are observed family results; neither ablation is a uniform win.
The causal explanation for the direct generator is a code-based hypothesis,
not an instrumented attribution.

## Search correctness and build evidence

Both variants pass all 11 native tests. The differential suites check 25,600
seeded trajectory positions per variant, including captures, en passant,
promotion and castling positions. Across 479,197 quiet candidates, geometry
rejects 341,081 impossible-check candidates and misses none of the 27,120 actual
quiet checks; board restoration is checked throughout. Direct tactical lists
match the original capture/promotion subsequence exactly, including order.

For each variant, native returned-field comparisons cover **80 ordinary searches,
80 fixed-depth searches and 192 shared-budget forced roots**, including small
budget aborts and mate/stalemate/50-move boundaries. The initial hard-coded log
count was corrected to report these measured totals; the test-only correction
was rebuilt and its production WASM is byte-identical to the already frozen
modules. [Both compiled modules also match all 144 immutable r69 signatures](frozen-signatures.json).

The pinned Rust1.97.1/Binaryen131 build reproduces the measured module hashes.
[Source/build evidence](build-evidence.json), per-variant source receipts, native
logs and build logs are retained here. CI now runs the source-isolation and
single-read-template contracts plus both native differential suites. Generated
source is hashed from retained bytes, and preparation refuses repository paths,
symlink escapes into the repository, and existing output directories.

| Module | Raw WASM | Raw change | Diagnostic Brotli | Linear memory |
| --- | ---: | ---: | ---: | ---: |
| Shipped HCE | 37,172 B | +0 B | 17,690 B | 26,542,080 B |
| Quiet-check prefilter | 37,857 B | +685 B | 17,972 B | 26,542,080 B |
| Prefilter + direct tactical | 40,356 B | +3,184 B | 18,673 B | 26,542,080 B |

Runtime: Node24.19.0/V8 13.6.233.17-node.51, Linux x64, Intel Xeon Platinum8573C.
Brotli uses this runtime's1.2.0 encoder; it is **diagnostic**, not the repository's
pinned Node22.23.2/Brotli1.1.0 ratchet. Raw module growth is exact. Both candidates
would exceed the current production size ceiling, so a reviewed exception or a
smaller implementation would be required before any production integration.

## Master screen

The fixed-node selection rule chooses the smaller prefilter. Its
[separate Master registration](master-registration.json) freezes the exact module
hashes and uses the shipped maxDepth30, 5,000ms, no node cap, the same18 positions,
and two order-balanced pairs. An independent review corrected the initial
proposed ABI depth ceiling111 to the actual shipped ceiling30 **before this
Master registration and execution**. The fixed-node run is preserved unchanged.

All72 searches completed. Relative to shipped HCE, the prefilter's geometric
mean paired throughput changes by **+2.41%** and searched nodes by
**+2.41%**. Across36 paired trials it completes a deeper iteration in
**1**, the same depth in **34**, and a shallower iteration in **1**.
Best moves differ in **1/36** pairs. Maximum measured deadline overshoot across
both engines is **4.51ms**. These position probes do not establish
which differing move is stronger or how match Elo changes.

| Family (both colors; two pairs) | Throughput change | Deeper / same / shallower |
| --- | ---: | ---: |
| opening (Ruy Lopez) | +1.32% | 0 / 4 / 0 |
| open middlegame (Dragon) | +7.02% | 0 / 4 / 0 |
| closed middlegame (KID) | +8.06% | 0 / 4 / 0 |
| tactical middlegame (Kiwipete) | -11.69% | 0 / 3 / 1 |
| rook ending (Lucena) | +7.06% | 0 / 4 / 0 |
| minor-piece ending | +4.35% | 0 / 4 / 0 |
| promotion race | +1.41% | 0 / 4 / 0 |
| pawn ending (zugzwang) | +1.14% | 0 / 4 / 0 |
| tactical defence (chessy202607240238) | +4.52% | 1 / 3 / 0 |

[All raw timed rows](master-results.json) and [paired summary](master-summary.json)
retain the outcomes, including negative families and move changes.


## Decision and remaining gates

Retain these tools and negative/positive development findings. Do not ship either
candidate on this evidence. The direct tactical extension is not worth its
additional2,499 raw bytes over the prefilter in this implementation. The smaller
prefilter has a modest desktop gain and no net completed-depth gain in the
Master screen; physical-device runtime, source/signature
admission (#155), current size limits and fresh formal strength admission (#175)
remain separate requirements. See #84 for device evidence. No difficulty values
or external Elo labels are changed.

Paid compute: **$0**; the remaining $30 allowance is untouched.

## Post-run completion-validator correction

Review of PR#183 found that the original runner could accept a malformed plan
with empty execution inventories and label its zero-row output complete. The
retained actual runs contain all648 fixed-node and72 Master rows; their original
registration and result bytes are unchanged and now pass an independent complete
ordered-row check. No timings were rerun.

The current runner validates the exact mode-specific corpus, budgets, depth,
time, warmup, repetition count, engine order, policy flags, distinct module
identities and dependency inventory before loading any engine. Fixed mode
requires the reference and both candidates; Master requires the reference and
one candidate. It authenticates all retained module bytes before loading any,
and checks the complete ordered result inventory and fixed-node signatures
before publishing a completion receipt. Empty, missing, duplicate, reordered,
invented and malformed plans/rows are covered by negative tests. Registration
acknowledgment also uses `registered: true`, without a zero-row completion claim.

Both exact executed runner versions are retained: [fixed](fixed-benchmark-source.js.txt),
[Master](master-benchmark-source.js.txt), and their [hash mapping](runner-snapshots.json).
The hardened live runner has a different source hash and cannot silently replace
the implementation authenticated by either historical registration.

## Post-run implementation-capture correction

A second review found that the earlier runner could execute a cached benchmark
module and then hash replacement bytes at its pathname. Fresh registrations now
use schema v2: the built-in-only bootstrap captures the runner, benchmark adapter,
and adapter's eagerly loaded signature fixture before execution. It executes the
captured runner and adapter, bypasses the repository require cache, and supplies
only retained fixture bytes through the adapter's restricted filesystem reader.
Run authentication checks the registered identities before evaluating the adapter.
Registration and completion also reject persistent source-path changes.

Mutation tests cover a poisoned require cache, adapter replacement after capture,
runner replacement between Node's bootstrap read and capture, replacement of a
cached runner, changed fixture bytes, unauthenticated adapter execution, repository
imports, and uncaptured file reads. First divergent or invalid-timing rows are
retained in failure reports, verified using synthetic adapters. All tests use
JavaScript-only fixtures. The
[previous reviewed runner](pre-capture-benchmark-source.js.txt) and its
[provenance record](provenance-hardening.json) are retained; that version never ran
a timing experiment. Every original fixed/Master registration, result, and executed
runner snapshot remains unchanged. No timings were rerun or relabeled.
