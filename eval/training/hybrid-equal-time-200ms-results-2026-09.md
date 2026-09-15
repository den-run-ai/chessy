# Hybrid 200 ms follow-up: complete development evidence

The unchanged hybrid scored **46.25%** against the unchanged
shipped-HCE baseline in all 40 prospectively registered games: 13 wins,
11 draws and 16 losses. The descriptive one-sided 95% opening-cluster
lower bound was 32.84%, over 20 paired-opening means.
This small exposed-opening screen supplies no formal strength or Elo claim.
The hybrid did not meet the registered 50% research-routing threshold. The next
step is to inspect move ranking and phase transitions alongside runtime profiling
before another fit or larger model. HCE remains the shipped evaluator.

| Development experiment | Games / opening pairs | Frozen hybrid score |
|---|---:|---:|
| Original 20 ms recovery arm | 200 / 100 | 41.50% |
| 16,384 nodes, no time cap | 200 / 100 | 50.00% |
| New 200 ms screen | 40 / 20 | 46.25% |

The longer screen used 20 openings selected prospectively by the frozen SHA-256
rule, independently of outcomes. Its population differs from the earlier full
100-opening runs, so the table cannot establish a causal budget effect. The
200 ms budget is ten times the original 20 ms and closer to ordinary deeper Play
workloads, but remains far below Master's five seconds. Neither evaluator,
training weights, game rules nor opening source changed. This protocol provides no
formal admission or basis to change the shipped evaluator.

## Registered execution and independent verification

- Exactly 40 games, both colors for all 20 selected openings, 200 ms requested per move,
  nodeLimit 0, maximum depth 30, quiescence enabled and 180 searched-ply cap.
- One serial game at a time, after the quiescence Master measurements and hash
  native/build work completed; no competing benchmark or training workload.
- All 40 games passed retained-archive JavaScript replay and independent
  python-chess 1.11.2 replay. Verified 5,258 searched moves,
  eight warmup searches and 41 archive members with zero mismatches.
- Live file discrepancies: 0. No game rerun, optional stopping,
  post-hoc extension, formal holdout access, training or paid compute. Cost **$0**.
- Complete selected opening indices in order: 6, 59, 38, 86, 28, 60, 41, 58, 57, 51, 96, 83, 78, 34, 91, 14, 5, 84, 75, 74.

| Observed search metadata | Shipped HCE | Hybrid |
|---|---:|---:|
| Searched moves | 2,630 | 2,628 |
| Mean observed milliseconds | 194.837 | 194.763 |
| P95 observed milliseconds | 204.123 | 204.324 |
| Moves above 400 ms | 1 | 0 |
| Mean completed depth | 6.030 | 5.885 |

All overruns are retained. Timing/depth comparisons concern different encountered
positions, so they do not replace isolated paired runtime profiles. Game endings:
checkmate: 29, insufficient material: 2, ply-cap: 6, threefold repetition: 3.

## Provenance

The [public freeze 1099d5e](https://github.com/den-run-ai/chessy/commit/1099d5e5f2f34558b3c3b2f2294fae050f13ca5a)
and [before-game issue record](https://github.com/den-run-ai/chessy/issues/105#issuecomment-5677666569)
preceded the one-shot launch. The complete 15-file executable snapshot was read-only
and independently reviewed before execution.

- Registration SHA-256: `8610cb22228618f4a2f5da68e269b25eaf8cf2f883d251527769a618b26a5c71`.
- Shipped WASM SHA-256: `57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f`.
- Unchanged hybrid WASM SHA-256: `18c69302d9aaecc0078a5b398e68789f24adb66e525c99f8bc9ac9ddc60e9493`.
- Retained archive: 820,079 bytes, SHA-256 `d1fe0e2b2cb0586a3811df386d48110fa2859ec39fac659f518118d307b72f86`.
- Independent audit SHA-256: `508190d5fb45668eb9d023958ff3e41a9e69c55d04f3e4679fa26df921220d85`.

Full exact sources, raw captured games, frozen modules, original model/runtime
receipts, precursor evidence and original-path/hash mapping are preserved in the
private evidence bundle referenced by the separate provenance receipt. No model
bytes or large raw archive are committed to the public repository.
