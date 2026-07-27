# Verified guarded null-move experiment — rejected

Status: **REJECTED — DO NOT MERGE OR CHERRY-PICK**

This branch is an archival implementation and measurement record for the
verified guarded null-move item in #72 and #113. It is independent of the
rejected LMR branch in #122 and does not revive #55.

## Frozen baseline

- Accepted main: `ff820848454d30f7c22bb94914250ed6214e30ba`
- Search bytes are the accepted #116 engine; the later #118 merge changed
  coaching archive behavior and release metadata, not `assets/ai.js`.
- Candidate is Play-only. Deterministic coaching analysis explicitly disables
  null move in both its scan and deep/shallow verification contexts.

## Candidate

- Entry null-window nodes only; the entry window is captured before TT
  tightening.
- Quiescent Play search only, depth at least 5, fixed reduction `R=2`.
- Never in check or near mate bounds.
- Side to move must own non-pawn material and the board must contain at least
  four non-pawn, non-king pieces.
- Static evaluation must support the cutoff by at least 64 cp.
- The synthetic pass flips the turn, clears en passant, advances the clocks,
  and cannot approach the 50-move boundary within its reduced search plus
  quiescence horizon.
- Synthetic subtrees cannot probe/store TT, inspect/push repetition paths, or
  update killer/history heuristics.
- Every null trigger is checked by searching the real position at `depth - 1`
  with null move disabled. Only a real verified bound cuts off; the returned
  value is clamped to the alpha/beta boundary.
- Probe, trigger, verified-cutoff, rejected-verification and node-attribution
  counters are exposed for the experiment.

Those counters are intentionally raw `think()`/benchmark evidence only. They
were not added to the durable saved-game telemetry schema because the candidate
failed before retention.

## Safety discovery

The first version used static support without a margin. It failed immediately
on the tracked Master tactical-defence position:

```text
r3r1k1/1ppq1pp1/1b2n3/3pPN1Q/1P5B/3B3P/P5P1/2R4K b - - 0 27
depth 5, window [-100, -99]
baseline:  -99 (correct fail-high; full-window truth -65)
candidate: -100 (false fail-low/cutoff)
```

The synthetic depth-2 probe returned `-159` and the real depth-4 verifier
returned `-194`, so reduced verification confirmed the wrong side of the
depth-5 bound. The mirrored position failed symmetrically.

A 100 cp static-confidence margin excluded the whole known-unsafe interval but
was vacuous in the active family screen. A single bounded 64 cp ablation was
then tried: the unsafe interval ends 58 cp beyond static evaluation, so 64 cp
retains a 6 cp nominal buffer. Recomputed guard geometry found no unsafe
confirmed-cutoff interval across all 18 tracked orientations or the 77
material-eligible positions in `eval-v1`.

That result is only a measured guard, not a proof of general soundness; the
candidate still requires the normal tactics and strength gates if it ever
becomes performant.

## Gates

### Focused correctness

`node test/ai-null-move.js`

- 38/38
- Covers depth, in-check, pawn/zugzwang material, exact 50-move horizon,
  tactical static-confidence, both score directions, mandatory verification,
  synthetic repetition/TT isolation, abort unwinding, input immutability and
  all coaching-analysis opt-out seams.

Broader checks remained green:

- Engine: 132/132
- Tactics: 120/120
- Master incident: 13/13
- Analysis core: 32/32
- Analysis service: 57/57
- Telemetry: 34/34

### Depth 5 no-op gate

Against the frozen baseline over all 18 mirrored positions:

- Candidate nodes: 1,757,641
- Baseline nodes: 1,757,641
- Re-searches: 362 each
- Null activity: 0/0/0/0
- Move, score, completed-depth and full-tree divergences: 0
- Every position node ratio: 1.0000

This is expected: the first eligible interior node is reached during the root
depth-6 iteration.

### First active depth-6 gate

The 100 cp variant produced zero probes through both Ruy, Dragon and KID
orientations plus Kiwipete, so it was rejected as vacuous.

The 64 cp ablation was then compared deterministically on the hard middlegames:

| Family | Candidate nodes | Baseline nodes | Ratio | Null P/T/C/R | Semantic divergence |
|---|---:|---:|---:|---:|---:|
| KID | 460,612 | 460,612 | 1.0000 | 0/0/0/0 | 0 |
| Dragon | 687,216 | 688,597 | 0.9980 | 1/1/1/0 | 0 |
| Kiwipete | 755,192 | 755,192 | 1.0000 | 0/0/0/0 | 0 |

`P/T/C/R` means probes / triggers / verified cutoffs / rejected
verifications.

The predeclared activity gate required material reduction with verified
cutoffs in at least three hard families. Two of the three targeted
middlegames were exact no-ops, and the only active family saved about 0.20% of
nodes. The conjunctive gate was already impossible, so the remaining full
depth-6 orientations were intentionally not spent.

## Disposition

The candidate is rejected at its first active performance gate. The following
were intentionally skipped:

- paired multi-repetition NPS timing;
- five-second desktop and physical-mobile completed-depth screens;
- GC and soak testing;
- the 800-game opening-clustered non-inferiority gate.

Do not lower the 64 cp margin or move activation to depth 4 merely to manufacture
activity: that would remove the measured tactical guard or make verification
shallower. A future revisit needs a materially different safety mechanism or a
faster/deeper search representation, then must restart from the focused
tactical witness and the full first active gate.
