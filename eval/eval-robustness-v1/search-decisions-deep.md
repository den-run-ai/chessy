# Deeper adjudication of four exposed choices

The largest apparent gain for the fitted evaluator in the depth-3 Stockfish 11 decision screen reversed on a deeper search. Both engines preferred HCE's 39…Be2 when given more work. Both also confirmed the depth-1 regression where the fitted model chose 26.Qd6+ over 26.Qb8+.

| Root | HCE move | Fitted move | Stockfish 11 preference | Chatarunga preference |
|---|---|---|---|---|
| `047f4c0e` | 39…Be2 | 39…Re2 | **Be2**, 1,272 cp | **Be2**, 417 cp |
| `03cc149b` | 18.Ng3 | 18.Na3 | **Na3**, 28 cp | **Na3**, 91 cp |
| `0d34d914` | 16.Nc2 | 16.Bb1 | **Nc2**, 72 cp | **Bb1**, 64 cp |
| `0959f402` | 26.Qb8+ | 26.Qd6+ | **Qb8+**, 926 cp | **Qb8+**, 591 cp |

Each teacher received a fresh process, one thread, 16 MiB hash, the complete source-game move history, and one million requested nodes per child. The two Stockfish 11 comparisons in the first two rows needed the registered fallback because a final node-limited score was bounded. Both moves in each comparison received fresh fixed-depth-17 searches. All final scores used above were unbounded numeric centipawn reports with legal PVs matching the engine's final reply. The 20 searches reported 23,292,822 nodes in total, including Chatarunga's overshoot of the requested count. The saved records include the primary bounded reports and their preceding updates.

The 39…Be2 and 39…Re2 scores both favor Black. These large gaps compare the engines' numeric evaluations of winning positions. Across the four roots, the deeper engines favored HCE twice, favored the fitted model once and split once. The selection deliberately includes three changed depth-3 choices and the largest adverse depth-1 example from the original screen. It supplies individual regression cases and leaves the original population summaries intact.

[Protocol](search-decisions-deep-protocol.json) · [Per-move scores, nodes, depths and PVs](search-decisions-deep-results.json) · [Search records](search-decisions-deep-records.jsonl.gz)

## Reproduce

From the repository root, supply the Stockfish 11 and Chatarunga 2.0 executables identified by SHA-256 in the protocol. Use fresh output paths.

```sh
taskset -c 5 python -m tools.eval_robustness.search_decisions_deep \
  /path/to/stockfish11 /path/to/chatarunga \
  /tmp/search-decisions-deep.jsonl.gz /tmp/search-decisions-deep.json
```
