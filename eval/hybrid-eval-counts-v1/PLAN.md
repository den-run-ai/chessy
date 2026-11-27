# One counts-only hybrid attribution diagnostic

Research only; $0 paid compute. No optimization, fitted parameter change,
training, formal holdout access, strength claim, or production change.
This is separate from the fixed-node match's skipped failure-review branch.

Freeze this rule before selecting positions: use the completed fixed-node
archive SHA-256 `05f6d2059ff492c364d6e28965b165c2b783df7199735b9809713e85e751b516`
and all 24,467 recorded searched moves from its 200 games. Exclude only warmup
and non-move records. Assign each move its original task ID and searched-ply
index. Rank ascending hexadecimal SHA-256 of UTF-8
`chessy.hybrid-eval-counts.v1|2026-09-15|TASK_ID|PLY`, breaking hypothetical
digest ties by task ID then numeric ply. Select the first 24. Do not filter on
outcome, score, phase, move quality, position duplication, or elapsed time.
Retain exact original FEN and history/request context; verify complete source
inventory and source archive identity before selection. Publish selected row
identities and digests before execution. The archive is already development
evidence; this creates no fresh validation or test partition.

For each selected request, search the unchanged original hybrid and one
observer copy with exactly 16,384 nodes, time limit 0, maximum depth 30,
quiescence enabled and original repetition history. Run once each, alternating
module order by selected-row index. Total requested nodes: 786,432 across 48
searches; early mate/terminal completion is retained. No measured warmup or
extra search. A separate parent process enforces a hard 60-second workload
watchdog. Any failure leaves incomplete evidence and forbids rerunning this
attempt. No selection or extension after observing counts.

The observer inserts only a counter after the original hybrid's existing
phase prescan. Count actual complete-evaluation calls at each clamped phase
0 through 24. Preserve all evaluator math, endpoint dispatch and search code.
The observer exposes reset/read exports; counters reset before each request.
Generated fitted source and model bytes remain private. Record source input,
emitted source, compiled module and executing dependency hashes before running.
Independent review must precede execution and publication. CPU build/search
must wait for the ongoing equal-time and hash screens to finish.

Require exact returned move, score, completed/attempted depth, nodes, qnodes,
cutoffs, re-searches and stop reason between original and observer for every
row. Compare original search outputs with the archived request only for rows
originally played by the hybrid. Requests originally played by shipped HCE
retain their full context, but require original-hybrid/observer parity only.
Keep the first failing raw observation; incomplete/parity-failed runs cannot
produce a complete count report. Before execution validate the observer's
counter reset, phase mapping and unchanged source transformations.

Report each root's 25-bin counts and aggregate evaluation fractions for
expanded-only phases 0–6, blended phases 7–11 and neural-only phases 12–24.
These count endpoint/component invocations, not CPU time or feature-loop work.
Root selection is uniform over recorded moves; longer games contribute more
rows. Twenty-four roots and their correlated search trees are a small exposed
sample, not a natural-game population estimate. Counter writes and changed
code layout add observer cost. No observer NPS, wall-time shares, inferred
speedup, or multiplication of counts by earlier static timings is permitted.
The earlier static phase costs remain separate evidence.
