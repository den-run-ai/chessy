# Guarded LMR experiment — rejected

Status: **DO NOT MERGE / DO NOT CHERRY-PICK**

This records the post-SEE guarded late-move-reduction experiment from issue
#72. It is a new implementation on the accepted `bcb3ae8` baseline (engine
bytes from #116), not a revival of closed PR #55.

## Candidate

The candidate reduces one ply only when all of these conditions hold:

- Play search explicitly enables LMR and quiescence is on;
- the node entered with a null window, captured before TT bounds can narrow it;
- remaining depth is at least 5;
- four quiet legal moves have already been searched;
- the move is quiet, non-promoting, non-checking, non-castling, not an advanced
  pawn push, and the side to move is not in check;
- the move is not the TT move, either killer, or a positive-history move;
- the window is outside mate-score territory; and
- the remaining search plus quiescence cannot cross the 50-move boundary.

A reduced scout that improves the bound is always verified at full depth, and
the shallowest repetition dependency is preserved across both searches.
Deterministic coaching analysis opts out in both its scan and deep/shallow
contexts.

## Results

Baseline for every comparison: `bcb3ae81a1d98800f009a0e1c7a7451b95e0ec26`.

### Depth 5 — required inactive-boundary identity

All 18 mirrored positions were identical:

- 1,757,641 candidate and baseline nodes;
- 362 candidate and baseline re-searches;
- zero LMR applications; and
- zero move, score, depth, node, qnode, cutoff, or re-search divergences.

### Depth 6 — first active full-family gate

| Metric | Result |
|---|---:|
| Candidate total nodes | 5,860,277 |
| Baseline total nodes | 5,874,976 |
| Geomean node ratio | 0.9972x |
| Geomean paired NPS ratio | 0.9936x |
| Worst / p90 position node ratio | 1.0000x / 1.0000x |
| LMR applied / full-depth verified | 33 / 0 |
| Positions with any LMR activity | 2 / 18 |
| Move / score / completed-depth differences | 0 / 0 / 0 |

Only the two Ruy Lopez orientations applied reductions (18 and 15). Dragon,
KID, Kiwipete, both tactical-defence orientations, and every ending applied
none. The 0.28% geomean node reduction is far below the predeclared material
payoff needed to justify selective search.

### Bounded guard ablation

Exploratory in-memory variants (not committed) showed that fifth-legal instead
of fifth-quiet, allowing low-history moves, and both together still produced
zero activity on Dragon, KID, Kiwipete, and the tracked tactical defence.
Those depth-5 null-window nodes normally resolve through TT or their first
reply before a late move is reached.

The only credible boundary relaxation—depth 4 while retaining the other
guards—moved the tree in the wrong direction at root depth 5:

- Dragon: 1.0073x nodes (27 reductions);
- tactical defence: 1.0230x nodes (35 reductions);
- KID and Kiwipete: 1.0000x nodes (no reductions);
- no move or score differences.

## Verification

- guarded-LMR tests: 25/25;
- engine: 131/131;
- tactics: 120/120;
- frozen Master incident: 13/13; and
- telemetry: 33/33.

## Decision

Reject at the first active performance gate. Do not run the five-second,
browser/device, GC/soak, or 800-game strength gates: the candidate is too
sparse at depth 6, and the bounded depth-4 alternative increases nodes.

Advance the one-change-at-a-time roadmap to verified guarded null-move pruning.
Any future LMR work should wait for a materially different search
representation or deeper shipped search; do not tune this predicate against
the frozen benchmark families.
