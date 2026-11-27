# What the evaluator sees inside search

Chessy uses a static evaluation during quiescence search when the side to move is out of check. If that score already crosses the active alpha–beta bound, the search can return immediately. A quiet-game root and a position reached during a sequence of exchanges can have quite different properties. The observer samples these actual evaluation calls.

The root bank comes from 32 exposed games on 16 openings in the earlier 25 ms study. It contains 85 nonterminal positions at prespecified offsets from the book exit. Each root gets a fresh search with full game history and a 10,000-node budget. Every instrumented native result must match its unmodified production-ABI WASM on the chosen move, score, completed depth, nodes and quiescence nodes. Every sampled native score must match the corresponding WASM static score.

For each root the observer retains up to six uniformly sampled visits, plus up to six visits within 50 cp of the cutoff. The search runs once with HCE and once with unscaled no-pawn. Each evaluator sets its own windows and visits its own tree. This matters when interpreting the sample near a cutoff. Static scores from all candidates are then compared on the same board and window within each tree.

Stockfish 11 and Chatarunga 2.0 each receive a separate OS process and a 12,000-node request per unique leaf. Repetition history before the leaf is unavailable to these teacher queries. Each teacher uses its own cp scale. A deeper teacher crossing the bound describes an opportunity to stop searching earlier, while continuing the search can still produce the right root move. These comparisons do not identify a game loss or prove that a cutoff was sound. The tables use equal root weights, retain repeated visits within a search and exclude one-sided teacher bounds from scoring.

## Does the result depend on which evaluator generated the tree?

Each cell gives the percentage of sampled visits where the static cutoff decision disagrees with that teacher’s search score, with each root given equal weight. The raw counts here include visits whose bound-only labels are excluded from the percentages.

| Tree | Teacher | Sample | Visits | HCE disagreement | No-pawn disagreement |
|---|---|---|---:|---:|---:|
| HCE | Stockfish 11 | Uniform visits | 510 | 23.3% | 22.6% |
| HCE | Stockfish 11 | Within 50 cp | 502 | 41.8% | 50.4% |
| HCE | Chatarunga | Uniform visits | 510 | 19.8% | 19.6% |
| HCE | Chatarunga | Within 50 cp | 502 | 42.2% | 49.8% |
| No-pawn | Stockfish 11 | Uniform visits | 510 | 21.7% | 21.7% |
| No-pawn | Stockfish 11 | Within 50 cp | 501 | 46.0% | 45.7% |
| No-pawn | Chatarunga | Uniform visits | 510 | 16.1% | 16.9% |
| No-pawn | Chatarunga | Within 50 cp | 501 | 40.4% | 42.7% |

On the HCE tree near its own cutoff, the unscaled model had roughly eight percentage points more disagreement with both teachers. The same gap largely disappeared on the learned tree, and the teachers differed on its direction. Uniform sampling in either tree showed small differences. This dependence on the sampled tree prevents attributing the game results to a general defect in stand-pat cutoffs.

[HCE tree results](standpat-hce-results.json) · [No-pawn tree results](standpat-nopawn-results.json) · [HCE sampled visits](standpat-hce-events.json.gz) · [No-pawn sampled visits](standpat-nopawn-events.json.gz)

## Reproduction

Use the r85 baseline and full-model modules from the restored #202 evidence and the no-pawn module and crate built at numerator 16. Run in a checkout of this research revision from the repository root with python-chess, Node, and Rust 1.97.1.

```sh
python -m tools.eval_robustness.standpat \
  --rustc "$RUSTC" --full "$FULL" --no-pawn "$NO_PAWN" --hce "$HCE" \
  --sf11 "$SF11" --chatarunga "$CHATARUNGA" --output /tmp/standpat-hce

python -m tools.eval_robustness.standpat \
  --rustc "$RUSTC" --full "$FULL" --no-pawn "$NO_PAWN" --hce "$HCE" \
  --sf11 "$SF11" --chatarunga "$CHATARUNGA" --no-pawn-crate "$N16_BUILD/crate" \
  --output /tmp/standpat-nopawn
```
