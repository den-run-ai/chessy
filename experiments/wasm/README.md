# Chessy Rust/WASM engine

[Home](../../README.md) · [Development](../../docs/DEVELOPMENT.md) ·
[Architecture](../../docs/ARCHITECTURE.md)

This directory contains the production engine used by Play and coaching.
Rust owns search, evaluation, move generation, make/unmake, repetition handling,
and exact-root analysis. JavaScript owns the independent rules layer, legal
move/PV validation, SAN formatting, UI, storage, and worker lifecycle. Search
runs only in Web Workers; there is no JavaScript search fallback.

[Build](#reproducible-build) · [Tests](#tests) ·
[Size limits](#size-limits) · [ABI reference](#raw-abi-version-2) ·
[Workers](#worker-and-failure-model) · [Research](#research-and-historical-evidence)

## Reproducible build

Run commands from the repository root with these pinned tools installed:

| Tool | Required version |
| --- | --- |
| Rust and Cargo | 1.97.1 |
| Rust target | `wasm32-unknown-unknown` |
| Binaryen | 131 |

The required rustc commit is
`8bab26f4f68e0e26f0bb7960be334d5b520ea452`. [build.sh](build.sh)
checks the versions and rejects ambient `RUSTFLAGS` or
`CARGO_ENCODED_RUSTFLAGS`. [Cargo.lock](Cargo.lock) has no third-party packages.

```sh
./experiments/wasm/build.sh
cmp experiments/wasm/dist/chessy-ai-fast.wasm assets/chessy-ai-fast.wasm
```

| Output under `experiments/wasm/dist/` | Build |
| --- | --- |
| `chessy-ai-fast.wasm` | Cargo `release`, then `wasm-opt -O3 --converge`; production asset |
| `chessy-ai-small.wasm` | Cargo `small`, then `wasm-opt -Oz --converge`; comparison build |

Both builds use `panic=abort`, one codegen unit, stripped symbols, and a
one-MiB stack. Initial and maximum memory are fixed at 405 pages
(26,542,080 bytes); linking fails if fixed storage exceeds that limit. There
is no SIMD, threading, WASI, libc, allocator, garbage collector, `wasm-bindgen`,
or per-node allocation.

[CI](../../.github/workflows/test.yml) runs Rust tests, rebuilds with the pinned
tools, and compares the fast module byte for byte with the committed asset.
A production engine change also needs a coherent app release and the evidence
required by the [agent guide](../../CLAUDE.md#rustwasm-rules).

## Tests

```sh
(cd experiments/wasm && cargo test --locked --offline)
node test/wasm-asset.test.js
node test/wasm-size.test.js
node test/wasm-signatures.test.js
node test/analysis-core.test.js
node test/ai-tactics.js
```

Rust tests cover search invariants, repetition, exact roots, shared budgets,
PV export, and malformed ABI input. The immutable
[r69 signature fixture](../../test/fixtures/wasm-r69-signatures.json) records
the accepted ABI-v1 behavior across 18 mirrored positions: move, score,
completed/attempted depth, nodes, quiescence nodes, cutoffs, re-searches, and
stop reason. See [signature rotation](SIGNATURE-ROTATION.md) before proposing
a new behavioral baseline.

### Size limits

[wasm-size.test.js](../../test/wasm-size.test.js) enforces these download limits:

| Measure | Current ceiling | Historical shipped measurement |
| --- | ---: | ---: |
| Raw WASM | 40 KiB (40,960 bytes) | 37,172 bytes |
| Brotli quality 11 | 20 KiB (20,480 bytes) | 17,690 bytes |

Authoritative compression uses Node 22.23.2 / Brotli 1.1.0, matching the
successful PR #169 engine job. CI verifies both versions; an encoder change
requires a reviewed baseline comparison. On another local runtime, use:

```sh
node test/wasm-size.test.js --diagnostic
```

That command reports a non-authoritative measurement. Passing the size gate
leaves source reproduction, signatures, strength/cost admission, fixed memory,
and physical-device requirements in force.

A reviewed size exception must set all three variables on this test's CI step:

| Variable | Requirement |
| --- | --- |
| `CHESSY_WASM_MAX_RAW_BYTES` | Exact positive safe-integer byte ceiling, at least the default |
| `CHESSY_WASM_MAX_BROTLI_BYTES` | Exact positive safe-integer byte ceiling, at least the default |
| `CHESSY_WASM_SIZE_OVERRIDE_REASON` | Concrete rationale of at least 20 characters |

At least one ceiling must increase. Partial, malformed, unexplained, or
non-increasing overrides fail. Record the benchmark evidence and tradeoff in
the same PR; do not set the override through a repository secret or broad
workflow environment.

## Raw ABI, version 2

The module has one import:

```text
env.now_ms() -> f64
```

Required exports:

```text
memory
input_ptr() -> u32
history_ptr() -> u32
result_ptr() -> u32
pv_ptr() -> u32
pv_len() -> u32

load_position(fenLength: u32) -> i32
load_history(historyLength: u32) -> i32

search(maxDepth: u32, nodeLimit: u32, timeMs: u32, quiesce: u32) -> i32
analysis_begin(nodeLimit: u32, quiesce: u32) -> i32
analysis_root(packedMove: u32, totalDepth: u32, pvLen: u32) -> i32

evaluate_loaded() -> i32
fixed_search(depth: u32, nodeLimit: u32, quiesce: u32) -> i32
```

JavaScript copies UTF-8 FEN bytes to the 1,024-byte input buffer.
`load_position()` clears stale repetition history. It then copies
newline-delimited repetition identities to the 64-KiB history buffer, one FEN
line per occurrence, and calls `load_history()`. The fixed table accepts up to
768 occurrences; counts above three for one position are unnecessary. Before
transport, the loader losslessly drops positions with a different pawn
placement or piece count from the root. Those positions precede an irreversible
pawn move or capture and can never recur. Every relevant position is therefore
inside the live game's sub-100-ply halfmove window, independent of how long the
aggregate saved-game map has grown.

Normal `search()` is the only Play entry point. A root that already occurred
three times returns `game-over`; a child whose loaded count is at least two
scores as a path-independent draw. Search-path cycles retain the engine's
separate path-dependent repetition treatment.

Zero `nodeLimit` or `timeMs` means unlimited. `maxDepth` is limited to 111 so
the 128-ply fixed storage also covers the 16-ply quiescence ceiling.

### Exact-root analysis

`analysis_begin()` starts one phase with shared TT, heuristics, counters, and
node budget. `analysis_root()` validates and forces one legal root, evaluates
it under a full window at `totalDepth >= 1`, and exports a legal packed-move PV
whose first move is that root. Counters are cumulative across roots in the
phase.

Analysis status codes:

| Code | Meaning |
| ---: | --- |
| 0 | complete exact root |
| 1 | position/analysis not initialized |
| 2 | fixed transposition table saturated |
| 3 | invalid move/depth or rejected re-entry |
| 4 | shared node budget exhausted |

Status 4 preserves cumulative counters and attempted depth but exposes no PV.
A budget-aborted root is never exact. Timed deep analysis may keep a completed
shallower iteration; without one, the overall result is partial.

### Result record

Every search writes this 64-byte little-endian result:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | ABI version, exactly `2` |
| 4 | `u32` | struct size, exactly `64` |
| 8 | `u32` | move: from bits 0–5, to bits 6–11, promotion bits 12–14 |
| 12 | `i32` | score from White's point of view |
| 16 | `u32` | last fully completed depth |
| 20 | `u32` | attempted depth, or `0xffffffff` |
| 24 | `u64` | nodes |
| 32 | `u64` | quiescence nodes |
| 40 | `u64` | cutoffs |
| 48 | `u64` | PVS/aspiration re-searches |
| 56 | `u32` | stop-reason code |
| 60 | `u32` | reserved, zero |

Move `0xffffffff` means no move. Promotion codes are 0 none, 1 queen, 2 rook,
3 bishop, and 4 knight. Stop reasons are 0 unknown, 1 max-depth, 2 time-limit,
3 node-limit, 4 mate, and 5 game-over. The JS loader rejects foreign ABI
versions, result sizes, reserved bits, invalid promotions, invalid stop codes,
out-of-bounds pointers, and counters outside JavaScript's safe-integer range.

## Worker and failure model

Play and coaching each own a dedicated Worker and instantiate one module per
worker. Play retries a failed load/search once in a fresh worker with the exact
unchanged request and position. A second failure leaves a visible manual Retry
action and preserves the position.

The [analysis contract](../../assets/analysis-core.js) has two search profiles:

- Quick requests use a fixed-node scan, verify every legal root at its completed
  depth, then run a separate one-ply-shallower phase for stability.
- Deep requests scan for up to 16 seconds with uncapped nodes, then spend at most
  16 million nodes in one phase verifying every legal root at depths 1, 2, 3,
  and onward. The scan depth caps verification, with a minimum cap of depth 3.

Deep results report the deepest fully verified iteration; the preceding
iteration supplies stability. A deeper scan that prefers a move ranked
strictly below the verified best marks that best move unstable. If even depth 1
cannot finish, the result is partial and may retain only the scan's best move.
JavaScript validates packed moves through the rules engine before producing
SAN or a stored PV. Node budgets cap work; device speed still affects elapsed
time and completed depth.

## Research and historical evidence

Use the [evaluation guide](../../eval/README.md) for current admission status.
Historical measurements retain their original ceilings, verdicts, and scope.

| Reference | Purpose |
| --- | --- |
| [Chatarunga review](CHATARUNGA-REVIEW.md) | Reference paper, performance priorities, and follow-up prototypes |
| [Compact hashing](compact-hash/README.md) | Isolated hashing-cost experiment |
| [Pawn-rank masks](pawn-ranks/README.md) | Isolated evaluator-cost experiment |
| [Search-cost admission proposal](SEARCH-COST-ADMISSION-PROPOSAL.md) | Evidence still needed for behavior-preserving cost changes |
| [Original feasibility results](RESULTS.md) | Historical measurements from before the production cutover |

Compact hashing and pawn masks exceeded the former raw-size ceiling. Their
recorded sizes fit today's limits; the independent
[pinned-encoder CI check](https://github.com/den-run-ai/chessy/actions/runs/45940247899/job/140312676492)
confirmed 17,937 and 17,739 Brotli bytes respectively. This does not replace
their remaining admission evidence or rewrite their historical verdicts.

Developer comparisons use [bench.js](bench.js), an ordinary-search loader that
accepts ABI v1 and v2 through their shared `input_ptr`, `load_position`,
four-argument `search`, and 64-byte result record. It exposes no history or
analysis operations. Production remains ABI-v2-only.

The historical [WASM efficiency workflow](../../.github/workflows/wasm-efficiency.yml)
is maintainer-label-gated and compares exact modules across that compatibility
boundary. It is not a routine test or a new-candidate dispatch path; see the
[evaluation protocols](../../eval/README.md) for its limits and successors.

The earlier mobile feasibility workflow was retired after the owner waived
its Android memory/thermal acceptance gates for the production cutover. The
fixed-memory ceiling, pinned build, Chromium/WebKit suites, offline-cache tests,
and functional correctness gates remain active.
