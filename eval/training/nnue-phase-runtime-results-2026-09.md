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
retains exact values, module hashes, implementation identities, per-position
metrics and the verified 12-file artifact inventory.

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

The small overall median does not mean uniformly small overhead. **Six of the
eight positions are endgames**; opening and tactical positions cost more in this
sample. The raw records reproduce these per-position medians at 16,384 nodes:

| Authored position | H4 fused NPS change | H8 fused NPS change |
| --- | ---: | ---: |
| Initial position | −18.97% | −17.44% |
| Kiwipete | −11.92% | −19.77% |
| Lucena rook ending | −0.94% | +5.42% |
| Minor-piece ending | −2.72% | +1.33% |
| Promotion race | +6.77% | +0.77% |
| Pawn ending | −3.48% | −5.26% |
| Free rook ending | −2.29% | −8.16% |
| Boxed rook ending | −2.60% | −8.10% |

Positive cells do not mean neural evaluation is free or improves strength:
synthetic scores change search trajectories. This endgame-heavy median is not
a phase-balanced estimate of expected game performance.

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

This summary independently checks the **complete CI job log and recovered raw
artifact**, including all four source receipts and measurement reports.
The log SHA-256 is
`8975622a27ad0e1f3774676eb6510a2e35d2215bcaa76bdf26be8da6bf0bf220`.

The recovered [raw artifact](https://github.com/den-run-ai/chessy/actions/runs/34919106656/artifacts/10377705946)
is exactly 143,817 bytes with independently verified ZIP SHA-256
`f110f8c4aadf3e86b04ed00e685343deb5336131aecda806f69b8a4cdd508ca9`.
The first HTTP download returned 403; subsequent authorized file materialization
recovered the exact uploaded archive. All 12 extracted files match their ZIP
payloads. Independent reaggregation of **768 timing records**, 192 per
configuration, reproduces every reported median and pair count **exactly**.
The alternating-order inventory is complete, and every search consumes its
requested budget.

The local verification also checks all four WASM hashes and byte sizes, source
receipt hashes, the complete declared source/implementation inventories, and
exact regeneration of every emitted source file. It parses the actual WASM
memory minimum/maximum and ABI-v2 record, rechecks all **80 static parity
comparisons**, and validates every evaluation checksum. Local Brotli
recompression reproduces all reported compressed sizes, including the baseline.
Candidate source was regenerated for hash comparison; compilation and timing
were not repeated.

The later v4 source update automatically triggered a complete CI repeat in
[run 34919677932](https://github.com/den-run-ai/chessy/actions/runs/34919677932).
The first complete run above had already been selected and reported before
that update. The repeat's 143,884-byte archive is retained separately with
SHA-256 `116ab66d5c322f9bc701be4f6cfce84ba9da4cd885d6b86f9a72559de3d8147f`;
its timing records are not pooled with or substituted for the original study.
The trigger label was then removed to prevent further automatic repeats.

The measured CI runtime was **Node 22.23.2, V8 12.4.254.21-node.56, Brotli 1.1.0**.
The independent local verification used Node 24.19.0 and Brotli 1.2.0; this
runtime difference does not replace or extend the original timing measurements.

This single-run diagnostic supports using fused accumulation for a future
separately admitted candidate. It does not establish confidence intervals,
physical-device performance, playing strength, Elo/time saturation or production
eligibility. Both implementations rebuild accumulators for every evaluation;
incremental make/unmake accumulation remains untested. Synthetic scores change
search trajectories, and actual trained-weight Brotli compression can differ.
No training data or sealed test split was accessed by these probes.
