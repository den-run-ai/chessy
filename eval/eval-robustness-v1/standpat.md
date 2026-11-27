# What the evaluator sees inside search

Chessy uses a static evaluation during quiescence search when the side to move is out of check. If that score already crosses the active alpha–beta bound, the search can return immediately. A quiet-game root and a position reached during a sequence of exchanges can have quite different properties. The observer samples these actual evaluation calls.

The root bank comes from 32 exposed games on 16 openings in the earlier 25 ms study. It contains 85 nonterminal positions at prespecified offsets from the book exit. Each root gets a fresh search with full game history and a 10,000-node budget. Every instrumented native result must match its unmodified production-ABI WASM on the chosen move, score, completed depth, nodes and quiescence nodes. Every sampled native score must match the corresponding WASM static score.

For each root the observer retains up to six uniformly sampled visits, plus up to six visits within 50 cp of the cutoff. The search runs once with HCE and once with unscaled no-pawn. Each evaluator sets its own windows and visits its own tree. This matters when interpreting the sample near a cutoff. Static scores from all candidates are then compared on the same board and window within each tree.

Stockfish 11 and Chatarunga 2.0 each receive a separate OS process and a 12,000-node request per unique leaf. Repetition history before the leaf is unavailable to these teacher queries. Each teacher uses its own cp scale. A deeper teacher crossing the bound describes an opportunity to stop searching earlier, while continuing the search can still produce the right root move. These comparisons do not identify a game loss or prove that a cutoff was sound. The tables use equal root weights, retain repeated visits within a search and exclude one-sided teacher bounds from scoring.

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
