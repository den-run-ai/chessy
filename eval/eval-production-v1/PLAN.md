# Production-compatible evaluator and equal-time frontier

Status: prospective development study. HCE remains the deployed default.

## Decision being tested

At a fixed wall-clock budget, a cheaper evaluator can reach a deeper or wider
search and play better. A richer evaluator is useful only where its information
gain outweighs that lost search. Fixed-node outcomes and teacher-score accuracy
do not answer this deployment question. We will compare the complete-game
strength/time frontier directly. A crossover is allowed to be absent,
nonmonotonic, phase-dependent, or unresolved.

The historical 50/200 ms studies are recorded in [HISTORY.md](HISTORY.md). They
motivate a new time grid; their engines, hosts, openings, and uncertainty do not
provide an activation threshold for the present model.

## Frozen comparison

The production source is `2cf89b6e2ff7c7f2f11c2bf39e4c9b7bc99d28e0` (r85).
The full model is the unchanged PR #200 selected integer model, SHA-256
`4d6f94bd3b13e77604c087b9cd41bd4f7f0a119cc6b3d57d381ca8bf6d6d9304`.
The historical experiment directories, shipped assets, production loader,
search, transposition table, deadline policy, and release identity are not
modified by this study. Source and model bytes are retained in each build.

The new evaluator paths specialize HCE and full sparse evaluation at build
time, combine occupancy/color/pawn mask extraction, and embed the unchanged
16,712-byte narrow tables. They remove the research cache, model upload, and
batch-score buffers. HCE and residual interpolation retain separate integer
rounding. All paths must pass independent original-score comparisons and
fixed-node search equivalence within their respective evaluator groups.

The exact r85 control must reproduce the shipped 37,210-byte WASM. The fixed
405-page allocation cannot hold the new evaluator: even fused HCE exceeds its
linker requirement by 220 bytes. Experimental modules explicitly use one
additional 64 KiB page (406 pages, 26,607,616 bytes). A memory-matched original
HCE control is included. No stack or TT capacity is reduced. This memory change
is a declared future release consideration, not a deployed modification.

## Cost selection before games

Run one complete registered cost grid on all 72 already exposed v2 development
positions (24 opening, 24 middlegame, 24 endgame), 10,000 and 36,000 nodes, and
three replicates. Include the original control, memory-matched original HCE,
fused HCE scalar/SIMD, and sparse scalar/SIMD. That is 2,592 observations.
Rotate/reverse variant order and reverse root order by replicate. Warm all six
instances identically before measurements. Retain every raw request/response.

Select HCE from memory-matched original/scalar/SIMD and the unchanged full model
from scalar/SIMD using minimum geometric mean engine-call latency. A difference
within 0.5% prefers original, then scalar, then SIMD. This is descriptive runtime
selection on a development grid, not a claim that a tiny winner is statistically
stable. Report whole-search NPS ratios and phase results. A signature mismatch
invalidates selection. Do not infer game strength from this screen.

Use pinned Node 22.23.2, Rust 1.97.1, and Binaryen 131. Node uses
`--no-liftoff --no-wasm-lazy-compilation`, as in the previous optimized-runtime
study. All measurements run sequentially on the first available CPU with no
concurrent fitting, builds, or label generation. Record CPU affinity, executable
hashes, V8 version, available cgroup metadata, and missing quota visibility.

## Complete-game frontier

The development grid is **10, 25, 100, and 400 ms per move**, with no node ceiling,
maximum depth 30, root seed zero, and the same quiescence/search implementation.
Each engine receives the same time per move within a game. Sixteen opening pairs
and both candidate colors give **128 complete games** across the four budgets.

Choose sixteen openings before outcomes by the lowest SHA-256 of
`chessy-eval-production-v1-time-frontier-20261127` + NUL + `sourceGameId` from the
existing 64-opening v2 bank. Use these same openings at every budget. This bank
has already been used in development; it is **not a fresh confirmation set**.
Group intervals by the bank's coarser `ply4Family` identity, retaining both colors
and all budgets together. Full legal opening prefixes and source-game identities
are mandatory. There is no result-directed selection or replacement.

Interleave budgets by opening: rotate the time-control order by opening ordinal,
then run both colors, alternating first color by opening ordinal. Bind the exact
schedule to the complete immutable configuration and both module hashes.
After identical warmup (four cycles, the four v2 warmup FENs, 10,000 nodes),
run one persistent Node host with two independent module instances. Compilation,
initialization, warmup, and Python/JS transport are measured/retained separately
from the engine call. Record per-search elapsed time, request round-trip time,
nodes, qnodes, completed/attempted depth, cutoffs, re-searches, stop reason,
selected legal move, and complete repetition history.

Play to checkmate or a current-position rules draw. No score adjudication or
resignation is permitted. A declared cap of 180 searched plies after the opening
produces a separately counted draw. Natural terminal states take precedence at
the cap. Independent Python and production JavaScript rules must agree on the
complete move history and terminal result. Reconstruct PGNs and every recorded
search request in a closed-ledger audit before analysis.

Report progress counts without aggregating partial outcomes. No optional
stopping, selective reruns, repeated deterministic games treated as independent,
or recovery that discards a failed campaign. Infrastructure failure preserves
all outputs and requires a separately identified complete campaign.

## Interpretation and admission

Draws count as half. Report each time control's wins/draws/losses, score, capped
draw count, paired cluster-bootstrap intervals, and relative logistic Elo
transforms. Use the same cluster draws across all four budgets, seed 20261127,
10,000 samples, and approximate Bonferroni-adjusted 95% simultaneous bands.
These intervals describe this development screen. They do not create independent
source-game isolation from the original corpus or calibrate a human rating.

Also report realized-time distributions, overshoot, time-limited fractions,
completed depth, NPS, and node counts. Different encountered positions make game
averages descriptive; matched-root cost data explain runtime separately. The
quality of a completed move at its actual deadline is the primary outcome.

The analyzer never enables production. A possible crossing identifies a
hypothesis for a new, independently registered confirmation campaign with fresh
source-game openings, relevant browser/mobile devices, representative Play time
controls, and enough pairs to resolve the predeclared minimum useful gain.
No threshold is interpolated from a noisy point-estimate crossing. The evaluator
must remain stable within a search; any future selection happens at a request
boundary and binds module/model, device profile, and time policy identities.

Any eventual activation must separately pass release identity/cache coherence,
Worker integration, history/seeded/exact-root contracts, coaching score-scale
checks, startup/memory/device latency, and a reversible HCE fallback. A gain at
400 ms does not authorize activation at 10 or 25 ms.

## Cheaper architectures

In parallel with correctness engineering, a separately registered fit study will
refit the surviving coefficients after removing pawn-context or ray interactions.
It uses the authenticated original train/validation roles and the original convex
objective, family balancing, bounds, and integer export. It does not open holdout
labels or change the full-model comparison above. The earlier sparsification
screen deleted coefficients without refitting. An actual architecture reduction
must also remove executable feature work and pass integer validation/runtime
guards before it can enter a separate equal-time campaign.

All proposed gains remain hypotheses until measured. Preserve negative results,
source snapshots, complete raw evidence, and reproduction commands.
