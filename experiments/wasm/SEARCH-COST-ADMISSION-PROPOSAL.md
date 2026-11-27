# Proposal: admission of pure search-cost improvements

Status: **research proposal for separate review; no admission authority**.
Prepared against r82, commit `f65224dece688f23d00429c148715262dd3c9b79`,
before measuring the two new candidates in this refresh. The existing formal
registry stays empty, its estimator stays unchanged, and production continues
to use the reviewed engine. This document does not mark either candidate as
eligible for activation.

## The gap this would close

The [formal finite-bank contract](../../eval/match-formal/CONTRACT.md) rejects
`behavior-preserving-search-cost` campaigns. Identical fixed-node play scores
50% in each two-color pair; its current one-sided bound is below the selective
profile's 49% threshold. More games under that contract are therefore not a
practical admission route for a transformation intended to preserve the search.
Changing its class to selective search would misdescribe the candidate.

Issues [#175](https://github.com/den-run-ai/chessy/issues/175) and
[#84](https://github.com/den-run-ai/chessy/issues/84) call for a separately
reviewed equivalence/runtime policy. The proposal below defines the evidence
that policy should demand. It still requires an independently reviewed
implementation and trusted-base enforcement before any production use.

## Scope of the equivalence claim

At an identical position, full repetition history, fixed node/depth budget,
and deterministic configuration, the candidate must preserve evaluation,
legal moves, stable move ordering, TT identities/bounds, repetition handling,
mate scores, node accounting, completed iterations and exact-root/PV results.
No changed pruning, reductions, extensions, evaluation weights or replacement
policy belongs in this class.

Wall-clock termination is explicitly outside that equality: faster execution
can complete more nodes and select a different move at eight seconds. Timer
checks, responsiveness, deadline overshoot, cancellation and partial-result
semantics still need verification. A CPU gain is not an Elo claim.

Finite regression signatures are observations on their declared inputs. They
do not prove equality on every legal position. Admission should combine a
reviewed local invariant with differential execution, rather than treat either
finite games or a matching output digest as a universal proof.

## Candidate-specific invariants

### Piece-square hashing

For each original Zobrist stream, the board component is the XOR of one key
per occupied square. Replacing an old piece with a new piece on a square
updates it by XORing out the old key and XORing in the new key. Applying this
to every changed square is algebraically identical to a full board scan.
Packing the two 32-bit streams into one 64-bit value is valid only if their
bits remain disjoint and extraction reproduces both original words exactly.

The implementation review must account for captures, both castling rooks,
promotion/underpromotion, en passant's third changed square, root setup,
history loading, exact-root setup, PVS re-searches and PV reconstruction.
Turn/castling suffixes and the different TT-versus-repetition en-passant
normalization must remain unchanged. Temporary legality probes must neither
advance nor corrupt the hash supplied to the actual search edge.

### Passed-pawn rank masks

With square rank indexed 0 through 7 from Black's back rank, the original
predicate finds an opposing pawn on the same or adjacent file with a strictly
smaller rank for White, or a strictly larger rank for Black. An OR mask of
opposing pawn ranks on those files contains exactly that information. Testing
its intersection with the corresponding strict rank interval preserves the
predicate, including doubled pawns, edge files and rank boundaries.

The review must verify bit widths and shifts at both boundary ranks, retain
the strict inequality, and preserve all surrounding score arithmetic,
accumulation order, tapering and negative-tie rounding. An exhaustive test of
the bounded mask domain supports this local argument; legal walks and full
search comparisons exercise its integration.

## Proposed evidence package

| Requirement | Evidence needed before an activation proposal |
| --- | --- |
| Identity and reproduction | Exact source/base commits, generator/patch and protocol hashes, retained inputs, pinned toolchains, independently reproduced module hashes |
| Source argument | A small reviewable transformation, the local invariant, all callers/state transitions, explicit assumptions and an independent review |
| Local correctness | Exhaustive bounded-domain checks where practical; seeded legal walks, make/unmake, special moves and independently recomputed reference values |
| Search correctness | Full unchanged frozen signatures plus ordinary/fixed/exact-root comparisons, history-sensitive draws, abort boundaries and legal PV replay; retain every mismatch |
| Resource limits | Current 40 KiB raw / 20 KiB Brotli-11 download budgets with the pinned Node 22.23.2 / Brotli 1.1.0 encoder, fixed linear memory, stack bounds and unchanged offline/worker/ABI contracts; no implicit ceiling exception |
| Product runtime | A prospectively registered order-balanced schedule at current product budgets; complete rows including failures, cold/warm and total-delivery latency, completed depth and overshoot |
| Physical targets | Authentic declared iOS/WebKit and Android/Chromium observations, sustained operation, battery/thermal/pressure limits, background/foreground and retry/PWA behavior under #84 |
| Activation | Previously reviewed evidence and policy in the trusted base, followed by the separate [signature procedure](SIGNATURE-ROTATION.md), coherent release and full CI |

Before a candidate is measured for admission, freeze the supported devices,
sample inventory, runtime metric, material-gain threshold, uncertainty method,
per-device regression limits and failure treatment. Do not pick these after
seeing its measurements. The small development screens in this refresh are
for routing research only and cannot fill this admission receipt retroactively.

A counterexample invalidates the claimed local equivalence; preserve it and
either correct the implementation under a new candidate identity or reclassify
the work honestly. A size miss under the applicable policy or device failure
remains a failed prerequisite.
Do not selectively rerun valid outcomes, omit positions or widen a ceiling in
the measurement report to turn a candidate into a pass.

The separately authorized 40 KiB / 20 KiB download-budget update is a current
policy change. Historical size misses retain their original thresholds and
verdicts; comparison with the new budgets is recorded separately. It does not
supply physical-device evidence, alter this proposal's admission status or
authorize production activation.

## What remains open

This proposal does not supply physical devices, their minimum support classes,
an admitted performance schedule or a trusted receipt verifier. It does not
change #175's fresh-bank requirements for evaluation/selective-search work.
Hosted Chromium/WebKit tests, Node timings and the algebra above cannot replace
the missing physical observations. Until the policy and its enforcement are
reviewed separately, the cost prototypes remain research only.
