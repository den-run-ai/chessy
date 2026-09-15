# Synthetic NNUE compiled cost — 2026-09-15

**Fusing neural accumulation into HCE's existing piece scan substantially reduced
the observed synthetic overhead.** H4 fused lost **2.77% search throughput** at
16,384 nodes, compared with **13.69%** for a separate refresh pass. H8 fused lost
**6.77%**, compared with **23.57%** for separate refresh. These measurements use
synthetic parameters and establish neither trained-model performance nor strength.

The complete four-configuration diagnostic ran at commit
`d14a0ba8a97868fd25889d2c8bd5544ff4a90902` in
[Actions run 34919106656](https://github.com/den-run-ai/chessy/actions/runs/34919106656).
The corresponding [machine-readable aggregate summary](nnue-phase-runtime-results-2026-09.json)
retains exact values, module hashes, implementation identities and evidence limits.

## Observed cost

All ratios compare the synthetic module with the shipped HCE on the same runner.
Evaluation time measures direct WASM calls, excluding FEN loading. Search columns
show the change in paired median **nodes per second**, not elapsed time or Elo.

| Synthetic configuration | Evaluation time / HCE | NPS change, 4,096 nodes | NPS change, 16,384 nodes |
| --- | ---: | ---: | ---: |
| H4, separate refresh | 2.354× | −13.45% | −13.69% |
| H4, fused HCE scan | 1.392× | −3.79% | −2.77% |
| H8, separate refresh | 3.909× | −24.28% | −23.57% |
| H8, fused HCE scan | 1.673× | −10.29% | −6.77% |

Each cell summarizes 32 paired measurements: eight already exposed, legal
authored positions and four alternating-order repetitions. Every search pair
consumed its complete requested node budget. The standalone evaluation pass
used 10,000 calls after 1,000 warm-up calls per sample. Configurations completed
the complete fixed plan; no runs or positions were selected afterward.

| Module | Parameter bytes | WASM bytes | Growth | Brotli bytes | Growth |
| --- | ---: | ---: | ---: | ---: | ---: |
| Shipped HCE | — | 37,172 | — | 17,690 | — |
| H4, separate refresh | 6,200 | 44,030 | +6,858 | 22,893 | +5,203 |
| H4, fused HCE scan | 6,200 | 43,992 | +6,820 | 22,964 | +5,274 |
| H8, separate refresh | 12,392 | 50,672 | +13,500 | 27,740 | +10,050 |
| H8, fused HCE scan | 12,392 | 50,670 | +13,498 | 27,801 | +10,111 |

These are the optimized `fast` modules; Brotli quality is 11. Parameter storage
is not the measured module increase. H4 contains 3,094 scalar parameters and H8
contains 6,186. The same deterministic nonzero parameter bytes were used for both
implementations at each width; no trained parameter values are included here.

## Correctness and memory

The pinned Rust/Binaryen baseline rebuilt byte-for-byte, and all seven baseline
native tests passed. Each of the four neural builds passed its native parity
test and **20/20 compiled WASM evaluations** against the independent BigInt
reference, with zero mismatches. Search results passed the unchanged ABI-v2
loader. The static checks include both sides to move and the historical mop-up
fixtures; adjacent-king static fixtures were excluded from search and timing.

Every synthetic module allocated **26,607,616 bytes**, exactly one 65,536-byte
page above the shipped **26,542,080-byte** allocation. The copied research builds
retain fixed initial and maximum memory; measured allocation stayed fixed.
Production files, memory limits, loader and evaluator remain unchanged.

The earlier [run 34918841047](https://github.com/den-run-ai/chessy/actions/runs/34918841047/job/104222223638)
failed before neural timings: the H4 refresh link required 26,542,892 bytes,
812 bytes above the production cap. The extra research page was explicitly
registered before this complete timing run. That original failure remains
evidence that this implementation does not fit the existing production cap.

## Provenance and limits

This summary independently parses and checks the **complete CI job log**,
including all four source receipts and all four final measurement summaries.
The log SHA-256 is
`8975622a27ad0e1f3774676eb6510a2e35d2215bcaa76bdf26be8da6bf0bf220`.

Actions reports a completed [raw artifact upload](https://github.com/den-run-ai/chessy/actions/runs/34919106656/artifacts/10377705946)
of 143,817 bytes with ZIP SHA-256
`f110f8c4aadf3e86b04ed00e685343deb5336131aecda806f69b8a4cdd508ca9`.
It contains original per-position reports, source receipts and the four modules.
Local download returned HTTP 403, so the archive bytes, individual timing records
and recorded runtime versions have **not** been independently inspected or
reaggregated locally. The aggregate checks do not claim that stronger evidence.

This single-run diagnostic supports using fused accumulation for a future
separately admitted candidate. It does not establish confidence intervals,
physical-device performance, playing strength, Elo/time saturation or production
eligibility. Both implementations rebuild accumulators for every evaluation;
incremental make/unmake accumulation remains untested. Synthetic scores change
search trajectories, and actual trained-weight Brotli compression can differ.
No training data or sealed test split was accessed by these probes.
