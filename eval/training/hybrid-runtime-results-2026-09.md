# Fitted hybrid runtime results

The frozen `smooth-6-12` hybrid is numerically correct in this research
implementation, but its first compiled implementation has substantial cost.
At 16,384 nodes its median NPS was **17.82% below shipped HCE**, and its fast
module grew by **20,913 raw / 11,167 Brotli bytes**. No strength or production
admission conclusion follows from these diagnostic timings.

The committed [prospective plan](hybrid-runtime-v1.md) and
[weight-free aggregate receipt](hybrid-runtime-results-2026-09.json) bind the
frozen H8 model, expanded-HCE parameters, source and compiled modules. The gate
was selected by the separate offline experiment before costs were measured.
No parameters were fitted, no labels collected, no sealed test opened, and no
paid compute used for this runtime experiment.

| Compiled evaluator | Fast WASM bytes | Brotli bytes | 16K NPS vs shipped | 40 ms NPS vs shipped |
|---|---:|---:|---:|---:|
| Shipped HCE | 37,172 | 17,690 | baseline | baseline |
| Frozen expanded HCE | 37,470 | 17,808 | −6.07% | −5.42% |
| Frozen H8 + shipped HCE | 50,871 | 27,459 | −6.48% | −10.14% |
| Selected hybrid | 58,085 | 28,857 | −17.82% | −16.98% |

The hybrid was also 13.64% below expanded-HCE NPS at 16K nodes. Search trees
differ across evaluators, so NPS differences combine evaluator work and the
positions visited. They are not isolated instruction-cost measurements.

| Hybrid phase stratum | Root fixtures | Static-evaluation time vs shipped | 16K NPS vs shipped | 40 ms NPS vs shipped |
|---|---:|---:|---:|---:|
| Opening | 4 | 1.65× | −17.71% | −15.44% |
| Middlegame | 4 | 2.21× | −25.96% | −33.99% |
| Endgame | 4 | 1.47× | −9.51% | −13.07% |

These are paired medians over four rotated repetitions per fixture. The
middlegame fixtures contain phases 10 and 14; some lie in the blend band. Root
phase does not constrain descendant phase. At 40 ms the median completed-depth
difference was zero overall and −0.5 ply for the hybrid middlegame stratum.
Every fixed-node comparison had 44/48 pairs reaching the full budget in both
engines; remaining searches ended early. Actual visited nodes were used for all
NPS calculations. Complete search counters and timings remain in the private
raw evidence; no early completion was discarded.

Correctness and reproducibility:

- The pinned Rust 1.97.1 / Binaryen 131 rebuild of shipped fast WASM reproduced
  SHA-256 `57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f` exactly.
- Each expanded, neural and hybrid crate passed all ten native tests.
- Native traversals covered 13,898 moves, including all 25 required ordinary,
  capture, en-passant, castling and promotion classes, and 97 phase-boundary
  crossings. Fused neural values matched independent full refresh before/after
  moves; unmake restored the complete position.
- Independent JavaScript affine HCE and BigInt neural/mixing oracles exactly
  matched all three compiled complete evaluators on 501 authored root and legal
  one-ply FENs. Integer endpoints and negative half ties also passed.
- The one cost run completed all 768 registered measurement records. Source,
  dependency, module, model and receipt digests were preserved. No timing rerun
  or timing-based model selection occurred.

The hybrid preserves expanded HCE at phase ≤6, uses shipped HCE plus H8 at
phase ≥12, and blends complete rounded White-POV scores between them. Its
implementation performs a phase prescan and computes both HCEs in the blend
band. The endgame path skips neural evaluation but still pays for that prescan.
This explains plausible optimization targets; these measurements do not show
that runtime performance has saturated. Sharing HCE calculations and reducing
phase-dispatch work would require a separate frozen mechanism comparison with
exact score/search parity.

All research modules used 26,607,616 bytes of linear memory, one page above
shipped 26,542,080. The production cap remains unchanged. These are one-host V8
measurements on twelve exposed authored fixtures, not natural-game averages,
physical-device admission, or formal Elo evidence. Equal-time development
matches and the outstanding formal admission design are separate work.
