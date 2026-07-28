# Verified null-move Rust/WASM experiment

Status: experiment only; do not ship or copy into the production asset until
the performance and strength gates below pass.

## Hypothesis

The JavaScript experiment in PR #123 was safe with its final 64 cp guard but
inactive at the depth-5 screening boundary. The Rust/WASM port now reaches
depths 7-9 on the tracked iPhone 12 game, so the same guarded algorithm may
become active often enough to save useful mobile wall time.

This is a clean Rust port against the current WASM source. It does not
cherry-pick or reopen PR #123.

## Candidate

- Play search with quiescence only.
- Entry null-window nodes at depth 5 or deeper, with `R=2`.
- No probe in check, near a mate bound, near the fifty-move horizon, or in
  sparse/zugzwang-prone material.
- Static evaluation must clear the pruning bound by 64 cp.
- The synthetic pass subtree cannot read or write the TT, repetition path,
  killers, or history.
- Every trigger is verified by searching the real position at `depth - 1`
  with null move disabled. Only the verified bound may cut off.
- The stable 64-byte ABI is unchanged. The optional
  `experiment_metric(index)` export reports probes, triggers, verified
  cutoffs, rejected verifications, probe nodes, and verification nodes.

Focused tests cover both score directions, the tracked tactical-defence
position and its mirror, check/material/fifty-move guards, position
restoration, and budget-abort unwinding.

## Gates

1. Pinned Rust tests and reproducible fast/small WASM builds pass.
2. Compare independently with the exact current `main` source:
   - fixed depth 7 over all 18 canonical orientations;
   - depth 8 over the hard subset;
   - order-balanced five-second time-to-depth, including the iPhone game's
     depth-6/high-quiescence and depth-9 witness positions.
3. Require material activity across at least three hard families and a
   meaningful mobile depth/time or node benefit, with no catastrophic
   move/score tail.
4. If the screen passes, run the frozen candidate-vs-base match protocol.
   This is an efficiency trade, so acceptance requires a one-sided 95% score
   lower bound above 49% plus the predeclared mobile benefit.

Generated WASM files and shipped assets remain outside this branch.
