# Incremental synthetic runtime study — September 2026

The eager make/unmake accumulator implementation reduced already-loaded evaluation cost but made aggregate search slower than the concurrent fused controls at H4 and H8. Keep the fused implementation as the lower-cost research reference on this fixture set. No trained model, playing-strength result or production change is represented here.

The [prospective protocol](nnue-incremental-v1.md) was published at `79eeb212ab1a183a2f0cd971220638e92bf29195` before the first timing. All four copied crates built and passed native tests, and all four compiled static preflights passed before measurement. The complete compiled study in the canonical [CI run](https://github.com/den-run-ai/chessy/actions/runs/34920728813) succeeded. Its PR checkout was merge commit `96cfd98b39b311c5e71bb651537133f506e0e192`; the complete source and dependency hashes reproduce from the retained files. The optional label was removed after completion to prevent automatic repetition.

| Synthetic configuration | Loaded eval time / HCE | NPS vs HCE, 4K nodes | NPS vs HCE, 16K nodes | WASM bytes | Brotli bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| H4 fused | 1.440× | -6.14% | -5.29% | 44,053 | 22,935 |
| H4 incremental | 1.102× | -13.10% | -11.61% | 45,704 | 23,029 |
| H8 fused | 1.738× | -13.10% | -9.18% | 50,731 | 27,819 |
| H8 incremental | 1.140× | -20.13% | -14.71% | 59,672 | 28,637 |

Ratios are medians of 32 paired observations per configuration and metric: eight original authored positions, four repeats, alternating candidate/baseline order, exact 4,096/16,384-node budgets. All searches consumed their requested budgets. Baseline WASM is 37,172 bytes / 17,690 bytes Brotli. Configuration order was fixed in advance; mechanisms were not interleaved, so drift can remain between them.

Incremental H4 adds 1,651 raw / 94 Brotli bytes over its concurrent fused control; H8 adds 8,941 / 818 bytes. Actual WASM `Position` size grows from 74 to 108 bytes for H4 and 140 for H8: +34/+66 bytes including alignment, compared with +32/+64 bytes of accumulator payload. `Undo` stays 10 bytes. The cache lives within `Position`, including the existing root global and copied positions; existing search context, transposition table, history and PV globals are unchanged. No additional mutable global cache was introduced; stack high-water usage was not measured.

Every candidate uses exactly 406 memory pages (26,607,616 bytes), one 65,536-byte page above production's unchanged 405-page cap. This retains the previously registered research allowance; it is not evidence of production memory admission. Both memory minimum and maximum were read from each binary.

Six of eight fixtures are endgames. Per-position median NPS changes at 16,384 nodes show the phase dependence:

| Position | H4 fused | H4 incremental | H8 fused | H8 incremental |
| --- | ---: | ---: | ---: | ---: |
| Initial position | -18.13% | -18.79% | -17.64% | -12.93% |
| Kiwipete | -7.80% | -8.81% | -18.82% | -16.87% |
| Lucena rook ending | -3.74% | -14.30% | +4.14% | -7.81% |
| Minor-piece ending | -4.48% | -10.70% | -0.96% | -8.07% |
| Promotion race | +4.97% | -4.08% | -2.47% | -13.43% |
| Pawn ending | -6.94% | -12.82% | -7.84% | -15.15% |
| Free rook ending | -5.40% | -9.63% | -10.28% | -16.32% |
| Boxed rook ending | -5.29% | -12.96% | -10.46% | -19.63% |

H8 incremental improves the initial-position diagnostic relative to its concurrent fused control, but its aggregate and all six endgame medians are worse. H4 incremental improves neither the initial-position median nor the aggregate. These observations do not establish a strength or Elo/time gain. Candidate-versus-HCE scores can change search trajectories; same-width fused/incremental complete search signatures matched exactly in all 64 candidate searches per width.

The direct evaluation loop measures an already loaded position and excludes FEN loading and move transitions. Eager updates run at every make/unmake, including legality probes. That explains why an evaluation microbenchmark alone cannot predict search speed; attributing this particular regression to bookkeeping, copies, instruction size or another component would require profiling. This bounded study tested one eager implementation and does not reject incremental evaluation generally.

The native tests passed seven baseline cases, four authored BigInt parity tests and both incremental transition tests. The latter independently reconstruct the unclipped accumulator, check the final residual against full refresh, require every Q/R/B/N quiet/capture promotion for both colors, cover both castling sides and en-passant colors, and verify complete Position restoration through FEN initialization, two-ply make/unmake, legal generation, en-passant probing and turn-only changes. The engine has no null-move pruning. H4/H8 closure tests took 0.93/1.68 seconds in CI; those test durations are not search measurements.

The [nine-file raw artifact](https://github.com/den-run-ai/chessy/actions/runs/34920728813/artifacts/10377519260) was downloaded and its exact ZIP SHA-256 verified as `b9ec25df16d2cbbd5b550539fcc373a5ffc8a2882c99f4ff5ab8fb572a427934` (144,929 bytes). Independent verification checked all module hashes and sizes, Brotli counts, seven dependency hashes and eight source inputs/emitted files per configuration, ABI 2, memory/layout exports, 80 static WASM/BigInt predictions, 256 evaluation checksums, the complete alternating inventory of 768 raw timing records, all aggregate/per-position ratios and exact cross-mechanism search signatures. Aggregate recomputation differed by zero. No timing or search was rerun during verification.

Benchmark runtime: Node 22.23.2, V8 12.4.254.21-node.56, Brotli 1.1.0. Verification used Node 24.19.0 / Brotli 1.2.0 and reproduced all compressed byte counts. Complete hashes, raw inventory, all per-position 4K/16K metrics and limitations are in the [machine-readable summary](nnue-incremental-results-2026-09.json).

This remains separate from the [first canonical synthetic study](nnue-phase-runtime-results-2026-09.md); no best result was selected across runs. There is one runner, no confidence interval or device replication, synthetic parameters only, and an endgame-heavy fixture set. The formal test split, shipped evaluator, production memory cap and runtime remain unchanged.
