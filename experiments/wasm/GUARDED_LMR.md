# Rust guarded-LMR crossover experiment

Status: experimental; do not merge into the shipped engine without completing
the benchmark and strength gates tracked in issue #113.

This candidate ports the conservative predicate archived in PR #122 into the
Rust/WASM search. It deliberately does not revive the broader PR #55 design.

## Exact predicate

A move is reduced by one ply only when all of the following hold:

- Cargo feature `guarded-lmr` and quiescence are enabled;
- the node entered with a null window, captured before TT tightening;
- remaining depth is at least 5;
- four legal quiet moves have already been searched;
- the side is not in check;
- the move is quiet, non-promoting, non-castling, non-checking, and not an
  advanced pawn push;
- the move is not the TT move, either killer, or a positive-history move;
- the entry window is outside mate-score territory; and
- the remaining main search plus bounded quiescence cannot reach the
  100-halfmove boundary.

The first search is a one-ply-reduced null-window scout. If that scout improves
the bound, the same null window is searched again at full depth before normal
PVS full-window verification is considered. The minimum repetition dependency
from every attempted scout or verification is retained.

## Isolation and telemetry

No shipped JavaScript, worker, service-worker, UI, or generated WASM asset is
changed. The 64-byte ABI v1 result record is unchanged.

An optional generic export supplies per-search experiment counters:

| Index | Meaning |
| ---: | --- |
| 0 | reduced scouts applied |
| 1 | reduced scouts followed by full-depth verification |

Unknown indexes return zero. `bench.js` detects the export when present and
remains compatible with baseline modules that do not export it.

## Validation boundary

Rust unit tests pin every guard, both pawn directions, maximizing/minimizing
null-window activity, the inactive root-depth-5 boundary, disabled behavior,
and metric reset/readout. The local environment used to prepare this branch
does not provide `rustc`; authoritative Cargo tests, candidate/baseline builds,
depth-7/8 family screens, mobile runs, and any strength gate must run in CI or
the pinned Rust build environment before a merge decision.
