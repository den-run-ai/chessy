# SEE capture ordering — rejected experiment

**Status: DO NOT MERGE / DO NOT CHERRY-PICK.**

This is the fresh ordering-only static exchange evaluation (SEE) experiment
defined after PR #116. It starts from the accepted #116 merge
`0701b584a85bc3de81e946e2a355c9b87d9bf5de`. It does not reuse PR #80's
implementation; it deliberately carries forward selected fixtures and concepts.
It is preserved only so the implementation, correctness cases, and negative
measurement remain auditable.

## Scope

- Legal least-valuable-attacker exchange sequences for capture ordering only.
- Losing captures move below quiet moves; no main-search or quiescence pruning.
- No 64-square board copy, per-call gain array, attacker object, or `m.see`
  decoration. SEE temporarily changes and restores the synchronous search board
  and reuses fixed scratch arrays.
- TT moves and promotions retain their existing priority.
- Captures with victim value at least attacker value skip SEE except where an
  opposing pawn could recapture-promote.
- Pinned recapturers and illegal king recaptures are rejected. En passant,
  x-rays, initial capture promotions, and recapture promotions are modelled.
- SEE demotion is disabled while in check, where pseudo-legal non-evasions would
  otherwise delay a legal capture evasion.

## Correctness

- `test/engine.test.js`: **153 passed**, including board restoration, defended
  and undefended captures, x-rays, en passant and its opened rook ray, initial
  and recapture promotions, an absolute pin, and legal/illegal king recaptures.
- `test/ai-tactics.js`: **120 passed** with no relaxed budget or expectation.

## Independent depth-5 screen

Command:

```text
node test/ai-bench.js \
  --base 0701b584a85bc3de81e946e2a355c9b87d9bf5de \
  --depth 5 --reps 2
```

Method: 18 positions (nine mirrored families), separate persistent
candidate/base processes, full-depth warm-up, one order-balanced AB/BA pair,
and batched timing for short positions.

| Metric | Candidate | #116 base | Candidate/base |
|---|---:|---:|---:|
| Total nodes | 1,962,508 | 1,757,641 | 1.1166 |
| Summed paired median time | 45,011.2 ms | 38,040.4 ms | 1.1833 |
| Re-searches | 359 | 362 | 0.992 |
| Geomean family node ratio | — | — | **1.0352** |
| Worst position node ratio | — | — | **1.2887** |
| p90 position node ratio | — | — | **1.2598** |
| Geomean paired NPS ratio | — | — | **0.9782** |
| Worst/p10 family NPS ratio | — | — | **0.8744** |

There were no best-move, score, or completed-depth differences. The benchmark's
12 "exact-search divergences" were expected ordering-induced node/qnode/cutoff
or re-search differences.

The family response is unstable rather than uniformly neutral:

| Family | Node ratio |
|---|---:|
| Dragon | 0.937 / 0.943 mirrored |
| KID | 0.901 / 0.910 mirrored |
| Kiwipete | **1.172 / 1.260 mirrored** |
| Tracked tactical defence | **1.289 / 1.254 mirrored** |

Three positions exceeded the predeclared 1.25x tail limit. A secondary
main-search-only/depth-guarded screen also failed to stabilize the tail:
Kiwipete remained 1.086/1.076 and the tracked tactical defence reached 1.336
before that screen was stopped.

## Decision

**Reject.** The experiment fails the required no-family-regression gate before
the more expensive stages. Depth 6, the shipped five-second/mobile screen,
allocation/soak diagnostics, and the 800-game `>49%` efficiency
non-inferiority gate were deliberately not run: passing them could not repair
the already-failed conjunctive acceptance rule.

Do not add SEE pruning or tune around the failing families on this branch. The
next independent algorithm experiment is the newly guarded LMR design in
issues #72 and #113.
