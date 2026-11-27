# Do static decision gains survive quiescence and search?

We compared each evaluator on the same 78 held-out games, one root per game, choosing among 246 preselected alternatives. At each depth each alternative received its own fresh 10,000-node budget and full game history in the production exact-root ABI. Each completed search used quiescence. All four evaluators completed every alternative at depth 1. At depth 3, HCE and the fitted model completed all alternatives on 76 roots each, and the full and unscaled no-pawn models on 75 each. The following comparisons use the 75 roots completed by all four. These fixed-depth tests measure decisions among the supplied moves.

| Evaluator | Static regret, SF11 | Depth-3 regret, SF11 | Depth-3 regret, Chatarunga | Depth-3 choices losing ≥150 cp, SF11 / Chatarunga |
|---|---:|---:|---:|---:|
| HCE | 347.05 cp | 23.69 cp | 15.55 cp | 3 / 2 |
| Full | 289.95 cp | 26.09 cp | 16.12 cp | 3 / 2 |
| No-pawn | 307.88 cp | 18.29 cp | 16.28 cp | 2 / 2 |
| Fitted no-pawn (12/16) | 323.13 cp | 18.36 cp | 16.44 cp | 2 / 2 |

The full model lowered static regret by 57 cp against Stockfish 11, yet its depth-3 regret exceeded HCE's by 2.40 cp (paired 95% interval −1.55 to +7.08). The fitted model's depth-3 difference from HCE was −5.33 cp by Stockfish 11 (−18.36 to +2.00) and +0.89 cp by Chatarunga (−2.80 to +5.00). At depth 1 the fitted model had 53.54 cp of regret against Stockfish 11 and HCE had 43.05 cp (difference +10.49, interval −5.36 to +37.05). These metrics condition on the alternatives, completion under the node cap, and the chosen teachers.

## Which moves changed?

At depth 3 the fitted and HCE models chose the same move in 72 of 75 cases. The other three are the entire source of their difference. A positive number in the table means the fitted move lost more according to that teacher. Root identities are prefixes of the full hashes in the recorded searches.

| Root | HCE choice | Fitted choice | Fitted minus HCE regret, Stockfish 11 / Chatarunga |
|---|---|---|---:|
| `047f4c0e` | 39…Be2 | 39…Re2 | −459 / +113 cp |
| `03cc149b` | 18.Ng3 | 18.Na3 | +9 / −82 cp |
| `0d34d914` | 16.Nc2 | 16.Bb1 | +50 / +36 cp |

The largest depth-1 regression by Stockfish 11 was `0959f402`, where HCE chose 26.Qb8+ and the fitted model chose 26.Qd6+. Both teachers preferred Qb8+, by 876 cp and 548 cp respectively. The position is `3kr2r/p6p/1pq2p1b/2pp2pP/8/2PPnNQ1/PP1N3B/1K2R2R w - - 0 26`. It is now an exposed development example.

## Reproduction

Run from the repository root with the four production ABI-v2 WASM artifacts bound by the report. The first two are the base and candidate from the original production game campaign. The final two come from the no-pawn build at 16/16 and 12/16. The new output paths must be unused. The command replays every root from its source history, verifies each WASM's direct static scores against the fitted data, checks legal returned PVs, and saves each call and the complete report.

```sh
taskset -c 5 python -m tools.eval_robustness.search_decisions \
  /path/to/production-campaign/backend/base.wasm \
  /path/to/production-campaign/backend/candidate.wasm \
  /path/to/runtime-n16/candidate.wasm /path/to/runtime-n12/candidate.wasm \
  /tmp/search-decisions.jsonl.gz /tmp/search-decisions.json
```

[Predeclared protocol](search-decisions-protocol.json) · [All 1,968 calls](search-decisions-raw.jsonl.gz) · [Metrics, coverage, and identities](search-decisions-results.json)
