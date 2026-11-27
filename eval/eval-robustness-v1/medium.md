# Medium without a live clock

The unscaled no-pawn model scored **52.73% on 256 replication games** against the r85 HCE control. Its opening-family paired 95% interval spans 48.24–57.32%. The smaller first screen scored 60.16%. The larger bank leaves both parity and the desired 55% score plausible.

| Game cohort | Opening pairs | Four-ply families | Candidate W/D/L | Score | Family-paired 95% interval |
|---|---:|---:|---:|---:|---:|
| First screen | 32 | 27 | 36/5/23 | 60.16% | 53.23–67.42% |
| Replication | 128 | 100 | 115/40/101 | 52.73% | 48.24–57.32% |

Each independently registered Medium cohort reused its corresponding 25 ms cohort's source games to compare budgets on the same openings. The replication excluded the first cohort's source games, ply-eight families, root clusters and root families. Both engines played both colors from each opening. Draws count as half a point, including 4 draws at the 180-ply cap in the first cohort and 21 in replication. Resampling four-ply families preserves both games in each opening pair. The intervals describe variation across the sampled openings. [First registration](medium-registration.json) · [Replication registration](medium-replication-registration.json)

The Node host called `assets/level-presets.js` for the no-clock Medium preset and passed the production WASM loader 10,000 nodes, maximum depth 30, a 5,000 ms deadline, quiescence enabled and the complete position history. Product Play sets `rootSeed` to `null` after the first 12 plies. Every sampled opening began after that point, so both engines used the ordinary unseeded search entry. The previous 25 ms study explicitly passed zero, invoking the seeded entry. The 3.52 percentage-point difference between Medium and 25 ms in replication has a paired 95% interval of −3.00 to +9.96 points and includes this difference in root ordering. [Medium options](../../assets/level-presets.js) · [Product seed policy](../../assets/app.js)

| Replication telemetry | HCE | Unscaled no-pawn |
|---|---:|---:|
| Searched plies | 11,537 | 11,545 |
| Median host request | 9.29 ms | 9.91 ms |
| 95th percentile host request | 16.57 ms | 17.78 ms |
| Mean completed depth | 3.46 | 3.40 |
| Searches without a completed first depth | 7 | 3 |
| Deadline stops | 0 | 0 |

The host used warmed WASM modules on one pinned Linux CPU per process. These move latencies cover the Node request path. The audit checked every search request, complete history, returned move, rule-based result and PGN, then replayed all games through the frozen production JavaScript rules. Restoring each archive reproduced its audit results byte for byte. [First results](medium-results.json) · [Replication results](medium-replication-results.json) · [Replication games](medium-replication.pgn)

## Restore and verify

The compact first-screen PGN omits the terminal blank line of the archived raw PGN. The first-screen audit binds the raw version. The replication audit joins the original shard PGNs and emits a single final newline.

Run the following from the repository root with python-chess and the recorded Node executable available. Verify the two archive digests before extraction. The runner uses Linux CPU affinity for timing measurements.

| Archive | Bytes | SHA-256 |
|---|---:|---|
| `chessy-robustness-medium.tar.zst` | 1,003,556 | `fc02f9edd1523cef9a6080b75ed9186ec5d7afd52050fe64fbcee8f1c2dab5cf` |
| `chessy-robustness-medium-replication.tar.zst` | 3,871,291 | `af83fd172dfe5439d9398d3fe97d7a160612bb939d016a42fa64e53de5af0804` |

```bash
mkdir medium-restored
tar -I zstd -xf chessy-robustness-medium.tar.zst -C medium-restored
tar -I zstd -xf chessy-robustness-medium-replication.tar.zst -C medium-restored
proof=eval/eval-robustness-v1
python -m unittest tools.eval_robustness.medium_test
python -m tools.eval_robustness.medium_audit medium-restored/medium-run medium-restored/first-results.json
cmp "$proof/medium-results.json" medium-restored/first-results.json
python -m tools.eval_robustness.medium_replication_audit \
  medium-restored/medium-replication "$proof/match-replication-audit.json" \
  medium-restored/replication-results.json medium-restored/replication.pgn
cmp "$proof/medium-replication-results.json" medium-restored/replication-results.json
cmp "$proof/medium-replication.pgn" medium-restored/replication.pgn
```
