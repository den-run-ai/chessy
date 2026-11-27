# Sparse-v2 paired development games

This is a fresh development experiment authorized for the sparse evaluator.
It does not dispatch or revise the archived v1 match, open the 400-position
formal/development v2 opening bank, or authorize a production engine change.
The executable registration will freeze literal code, model, module, opening,
schedule, and configuration identities before any scheduled game.

## Questions and fixed scope

The primary comparison is the exact optimized full sparse model against HCE
with the same **25 ms requested search deadline per move**. A second comparison
uses **10,000 nodes per move** to separate evaluation/search choices from cost.
Both comparisons use 64 fresh opening pairs, with the candidate playing each
color once: **256 mandatory games**. At most one approximate model may add
another 128 games at 25 ms, making **384 games maximum**. That optional model
must pass the separately frozen validation and cost rules and be included in
the registration before the first scheduled game. Game results cannot select
weights, implementations, or whether to include the approximation.

The game backend is the research WASM implementation running in Node. Scalar
or SIMD and the compact/fused/cached implementation are frozen after separate
correctness and cost work. This measures WASM gameplay on this host, not
browser UI overhead, a phone, or a new shipped app. Native cost is measured
separately; this experiment does not multiply the game bank by runtime modes.
The backend registration pins Node's `--no-liftoff` and
`--no-wasm-lazy-compilation` flags to match the cost-selection execution tier.
The ready handshake and independent audit require those exact flags. Module
compilation happens synchronously before readiness and outside search timing.

## Fresh opening bank

The retained, licensed January 2014 Lichess archive already has a complete
697,600-game inventory and an independent strict-SAN audit. Select from its
407,732 unlabelled, full-history natural positions. Require recorded ply
16–32, phase at least 18, a legal quiet nonterminal root, and no current
threefold/fifty-move draw. Exclude every endpoint structural family and
mirror-aware cluster in all three million-position roles; also exclude all
4,096 earlier OOD source games, families, and clusters and the historical
quarantine sources. Earlier teacher values and model results do not enter
selection. The evaluation dump has no game lineage, so game-level isolation
from that dump remains unknowable.

Rank by `SHA256("chessy.sparse-game-bank.v2.20261127" + NUL + sourceGameId)`.
Take the first 64 roots with distinct source games, endpoint families,
endpoint clusters, and structural families after eight recorded plies.
The selector retains the lowest 4,096 eligible priorities and fails if that
prefix cannot supply the entire bank. This is equivalent to the full ordered
scan when it succeeds. It replays each retained root and records its complete
UCI prefix. The bank is frozen and auditable before gameplay. Related named
opening systems may still correlate despite these grouping rules.

## Execution and full evidence

Use the pinned r84 search's deterministic legacy root order (`rootSeed=0` in
the adapter), depth ceiling 30, quiescence, and 180 searched plies after each
opening. No duplicate seed slots are counted as fresh openings. Current
checkmate, stalemate, insufficient material, threefold repetition, and
fifty-move conditions are checked before the cap. A nonterminal capped game
is a draw. There is no score-based adjudication or resignation.

Each persistent model process first receives 32 fixed authored warmup
searches: four positions, four cycles, both evaluator modes, 10,000 nodes.
Warmup is retained but excluded from game and timing summaries. Each search
request carries the complete initial-position/UCI history and exact final
FEN; the adapter independently replays it and uploads all repetition
occurrences, including the current root. The Python arbiter independently
checks legality and endings. The raw ledger retains literal requests,
responses, internal WASM time, request wall time, budgets, node/depth/stop
telemetry, and all game boundaries. Complete PGNs include the opening moves.
The auditor uses the separately pinned Chessy JavaScript rules to reconstruct
every outcome from moves, rather than trusting recorded results.

One search runs at a time. Pin the engine process to one available CPU and
record the host/runtime/affinity. Do not overlap this campaign with cost
profiling. Profiles execute in the declared order. Within a profile, openings
follow frozen index order; candidate White goes first for even indices and
candidate Black for odd indices. All candidates/profiles finish before any
summary is opened. Preserve a failed or interrupted ledger and invalidate
the campaign; never repair a favorable subset, resume, extend based on
results, or retry a valid statistical miss.

## What the result can establish

Report wins/draws/losses, candidate points, pair-score distribution, endings,
searched plies, depth/nodes, actual elapsed times, deadline overshoot, and
complete coverage. The primary descriptive 95% interval uses the 64
opening-pair means. A second interval clusters by the structural family after
four recorded plies and preserves endpoint weighting. These are diagnostic
uncertainty summaries, not proof of independence or a formal admission bound.
Do not convert this small screen to Elo.

Equal requested deadlines need a measured budget audit. Separately report
internal search time and full request overhead. For time-limit stops, require
the candidate/HCE median internal-time ratio to be within 0.9–1.1 and each
side's 99th percentile to be at most twice the requested deadline to call it
a clean realized equal-time comparison. Keep all results if this descriptive
budget check fails and explain the limitation. No outcome-based timing retry
is permitted. Stronger-play claims require the paired-game evidence; lower
teacher error or higher NPS alone cannot supply it.
