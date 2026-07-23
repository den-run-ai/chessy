# SEE (static exchange evaluation) — measured, not merged

**Status: DO NOT MERGE.** This branch (`claude/chessy-see-experiment-DONOTMERGE`)
preserves a complete, correct SEE implementation and its measurement so a future
session can return to it. It is kept off `main` because, measured against the
protocol in issue #72, **SEE gives no benefit in production for this engine
today** — the fixed-depth node savings are exactly cancelled by SEE's per-node
wall-clock cost, so the 2-second search reaches the same depth and plays the
same moves. SEE becomes worthwhile only *after* the allocation/NPS work
(make/unmake, typed arrays — roadmap Priority 3) makes nodes cheap enough to
reach the deeper, quiescence-heavy plies where its pruning pays off.

## What this branch contains

- **A correct SEE** (`assets/ai.js`, `see()` + `leastAttacker()`), exposed as
  `ChessAI.see(board, move)` and covered by 7 unit tests in
  `test/engine.test.js` (x-rays via scratch-board re-scan, en passant,
  capture-promotion including recapture by the defending king). Deliberate
  approximations, standard for SEE and harmless for ordering: pins are not
  modelled, and a pawn promoting *on a recapture* is scored as a pawn.
- **SEE move ordering**: winning/equal captures keep MVV-LVA just below the hash
  move; material-losing captures (SEE < 0) are deferred below quiet moves.
- **SEE quiescence pruning**: a losing capture on a real (non-null) window, not
  in check and not giving check, is pruned — the "poisoned capture" delta
  pruning cannot see. Disabled on the exact analysis path (`ctx.noDelta`).

## Measurements (candidate = this branch, base = tapered-eval branch)

All screening kept 121 engine + 63 tactics tests green with **0 move/score
divergences** — SEE never changed a result on the 16-position bench, only the
node count.

| Configuration | depth-5 geomean node ratio | depth-6 total nodes (4 mids) | 2 s production |
|---|---|---|---|
| SEE ordering (SEE-weighted) | 0.996 | — | — |
| SEE ordering (defer losers) only | 1.004 | — | — |
| SEE ordering (defer losers) + quiescence pruning | 1.033 (opening +53 %) | **0.884** | same depth (4–5), same moves |
| SEE quiescence pruning only | ~1.00 | 0.994 | same depth, same moves |

Key facts:

1. **The node savings are depth-dependent.** At fixed depth 6 the ordering
   variant cuts middlegame nodes 10–28 % (KID −28 %, Dragon −11 %, Kiwipete
   −10 %); at depth 5 it is net-neutral and badly regresses the opening
   (deferring losing captures below quiets costs cutoffs there).
2. **Quiescence pruning alone is negligible** (~0.6 % at depth 6) — the existing
   delta pruning already removes most of what SEE would.
3. **Production reaches only depth 4–5 in 2 s** on these middlegames. There SEE
   is net-neutral on nodes, and its per-node cost drops NPS ~15 %, so in a real
   2-second search **every variant reaches the same depth and plays the same
   moves as the base**. This is the "fixed-node matches conceal slower
   evaluations" trap called out in the #72 protocol.

## When to return to this

Revisit after roadmap Priority 3 (allocation / NPS — make/unmake, typed-array
board, set-associative TT). Once nodes are cheap enough for a 2-second search to
reach depth ≥ 6, SEE's 10–28 % middlegame node reduction should convert into
real extra depth, and SEE-gated pruning of losing captures in quiescence becomes
worthwhile. At that point, re-measure with both the fixed-node bench **and** a
production 2-second depth/NPS test, and keep SEE pruning off the deterministic
coaching-analysis path unless separately validated.
