# Qsearch cost diagnostic v1

This research compares the unchanged shipped HCE/search against two isolated
behavior-preserving candidates. It does not change production Rust, WASM,
evaluation, move ordering, level budgets, or immutable r69 signatures.

1. `checks`: before making a quiet move at the first quiescence ply, rule out
   impossible checks using conservative from/to geometry. Captures, all four
   promotions, castling, aligned origins that may uncover a sliding attack,
   existing enemy checks, and missing/stale king metadata retain the original
   path. Every surviving quiet move still uses original make/check/unmake.
2. `tactical`: additionally generate captures and promotions directly below the
   first quiescence ply. A legal tactical move suffices to rule out stalemate;
   if there is none, probe all moves in the unused next-ply arena. Checked nodes,
   the 50-move boundary and the quiescence depth ceiling preserve full generation.
   The arena probe is below QMAX and therefore remains within fixed storage.

Both preserve pseudo-move order before the existing stable sorter. The proposed
speed gain is less generation/filtering and fewer temporary make/unmake probes,
not less tactical coverage. In-check nodes still search all legal evasions.

## Frozen development screen

Generate standalone research source copies with `tools/search/qsearch-cost.js`.
Each records production-source, template, and emitted-source hashes. Build with
the repository's pinned Rust 1.97.1/Binaryen 131 script. Run the added native
candidate-set and full returned-search-field differential tests first.

The preregistered fixed-node benchmark uses the existing exposed 18-position
corpus (nine mirrored families), node limits 10,000/36,000/230,000, maximum
search depth 111, quiescence enabled, no time limit, and four repetitions.
Warm each engine with two rounds of every position at 10,000 nodes. Rotate the
engine order by position and repetition. Require exact returned move, score,
depths, nodes, quiescence nodes, cutoffs, re-searches, and stop reason at every
position and budget, including aborts. Keep individual rows and report module
size/memory as well as all per-position changes. Do not use timings captured
while another experiment competes for CPU.

If both variants preserve exact signatures, select the candidate with the best
geometric mean of paired reference/candidate elapsed-time ratios for the Master
screen; report every family and both ablations regardless of the result. If
neither beats the reference on this development screen, stop without a Master
screen. This rule does not authorize production adoption or a strength claim.

Register the selected raw-module hashes before the Master screen. The Master
screen uses the same 18 exposed positions, maximum depth 30, no node cap,
5,000 ms per move, and two balanced reference/candidate pairs. Report throughput,
completed depth, move changes, actual elapsed time and deadline overshoot. This
is a desktop Node/V8 development diagnostic. It is neither a match nor an Elo
measurement, and does not satisfy physical-device admission or #175 strength
admission. Do not selectively rerun a slower position or a valid miss.

Paid compute: $0. The remaining $30 is untouched.

## Master configuration correction before execution

An independent review identified that the shipped Master preset limits depth to
30, whereas the initial research plan used the ABI ceiling111. Before Master
registration or execution, its maximum depth is corrected to30 to match the
shipped preset. The completed fixed-node screen retains its originally registered
111 ceiling; no fixed-node results are rerun or relabeled.

## Completion validation

The current runner accepts exactly three distinct modules in fixed mode
(reference, prefilter, prefilter+tactical), and exactly two in Master mode
(reference, selected candidate). It validates the complete immutable mode
settings and corpus before loading engines, authenticates every module first,
and requires all ordered row identities before completion. The executed
historical runners and evidence remain separately preserved as documented in
REPORT.md; this validation correction does not rerun or relabel those results.
