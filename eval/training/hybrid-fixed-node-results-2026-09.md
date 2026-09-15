# Hybrid fixed-node diagnostic: complete development evidence

The hybrid reached the prospectively frozen 50% research-routing threshold. Profile residual runtime costs and separately register a longer equal-time development screen before considering any training or formal strength test.

| Frozen hybrid versus shipped HCE | Games | Wins–draws–losses | Hybrid score | Descriptive opening-cluster 95% lower bound |
|---|---:|---:|---:|---:|
| Prior 20 ms/move recovery arm | 200 | 57–52–91 | 41.50% | 36.56% |
| New 16,384 nodes/move diagnostic | 200 | 72–56–72 | 50.00% | 45.58% |

Equal-node parity is consistent with runtime cost contributing to the earlier
deficit. It does not show that the previously observed 3.53% teacher-loss
improvement produces stronger move choices: this match demonstrated no playing
strength gain over shipped HCE.

The same unchanged original WASM evaluators played the same 100 exposed opening
pairs with both colors, no time cap, maximum depth 30 and the original 180 searched-
ply cap. The new node budget was registered before execution because 16,384 was
already the higher fixed-node cell in the previous runtime protocol. Mate or
maximum-depth completion can finish below the node cap. Expanded HCE remains the
previous offline/equal-time control; no additional match arm was run here.

This is a diagnostic, not a formal acceptance test or Elo estimate. Equal node
limits permit different search trees, pruning and completed depths. The two
match results also use different stopping controls, so their point-score
difference does not quantify a causal runtime penalty. The earlier held-out
teacher loss is consumed evidence and must not be reused for model selection.
The shipped evaluator, asset, difficulty budgets and ratings remain unchanged.

## Complete capture and replay

All 200 games passed JavaScript legal/history/termination/search-metadata replay
from the retained archive. Independent python-chess 1.11.2 replay verified
24,467 searched moves, 8 warmup searches and 201
archive members with zero mismatches. All live files matched their original
capture receipts. No invalid move, hidden time cap, node overrun, partial game or
changed module was accepted. No game was rerun or added, and no interim score was
inspected. Paid compute: **$0**. No training or formal holdout access occurred.

| Search termination | Shipped HCE moves | Hybrid moves |
|---|---:|---:|
| Exact 16,384-node exhaustion | 11862 | 11857 |
| Early mate | 372 | 376 |
| Maximum depth | 0 | 0 |

Game terminations: checkmate: 144, insufficient material: 4, ply-cap: 31, threefold repetition: 21.
Observed per-move wall times and NPS are retained for inspection, but other CPU
development was permitted on this host, so these numbers cannot establish a
causal speedup. Separate isolated paired runtime profiling is required.

## Provenance and next analysis

- Public preregistration commit: [`c0cbdc1`](https://github.com/den-run-ai/chessy/commit/c0cbdc1052a4cab790b412ddd9b9e32fa008ed19).
- Before-game issue record: [#105 comment](https://github.com/den-run-ai/chessy/issues/105#issuecomment-5677378998).
- Registration SHA-256: `61633ee445f4d4ed6b3e53aac6a828d88d8dadafd7eb90173075bc81f2d8a2aa`.
- Shipped WASM: `57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f`.
- Unchanged hybrid WASM: `18c69302d9aaecc0078a5b398e68789f24adb66e525c99f8bc9ac9ddc60e9493`.
- Canonical archive: 3,553,777 bytes, SHA-256 `05f6d2059ff492c364d6e28965b165c2b783df7199735b9809713e85e751b516`.
- Independent audit SHA-256: `39f206db782a82ed4b37b86bec08a1cd926e12f15f3d1216828668f477c392ba`.

The complete exact executable snapshot, raw archive, modules and source receipts
are preserved in the private evidence bundle referenced by the separate
provenance receipt. Registration and code are not reconstructed from live files.
The snapshot has 13 read-only files and was independently reviewed before games.

The conditional failure/representative sampling and deeper root-ranking analysis
remained skipped: the final score equalled 50%, while that separately frozen
branch required a score below 50%. No review sample or new ranking search was
created from these results.
