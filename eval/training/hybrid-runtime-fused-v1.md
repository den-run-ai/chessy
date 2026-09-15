# Exact-score hybrid runtime mechanism comparison

This follow-up keeps the selected `smooth-6-12` gate, frozen H8 weights and
expanded HCE unchanged. It addresses the phase prescan and duplicated HCE work
identified in the first fitted runtime diagnostic. It neither fits nor selects
a model, opens a holdout, changes earlier evidence, or authorizes production.
The existing timed development matches retain their exact original modules.

Freeze exactly three mechanisms before measuring any of their costs:

1. **Original:** reproduce the first hybrid module byte for byte, including its
   phase prescan and separate HCE passes.
2. **Cached phase:** add one raw `i16` material-phase field to `Position`, update
   it at every board write, and remove only the hybrid phase prescan. Retain the
   independent shipped/expanded/neural board calculations.
3. **Cached phase plus shared HCE work:** use the same phase cache and one HCE
   board/feature walk. In the transition, keep separate shipped/expanded integer
   sums but share mobility, pawn structure, king shield and mop-up extraction.
   Round both HCE tapers before the exact White-POV blend. Outside the transition,
   select the relevant HCE constants and skip the unused neural/second lane.

The phase cache stays **unclamped** during every mutation. Destination-first
queen moves temporarily duplicate the queen; clamping at 24 would corrupt
ordinary moves. Clamp only when evaluating. The guarded transformer must cover
all sixteen board assignments: seven make, eight unmake, one FEN parse. FEN
parsing can represent raw phase 256, so a byte is insufficient. Keep `Undo`
unchanged, without a global mutable evaluation cache or a neural accumulator.

Native tests must independently reconstruct raw phase from the board and
compare complete scores with the original evaluator after every transition,
including legal generation and en-passant probes. Traverse the original
authored depth-two fixture tree, retaining all special-move coverage. Additional
tests must cover raw phase above 24, a 64-queen parser fixture (phase 256, not a
search position), ordinary queen movement, and promotion transitions. Compare
`Position` and `Undo` byte sizes explicitly. Test-only scalar reference code
must be absent from non-test WASM.

Require all three native builds and pinned Rust/Binaryen WASM builds before the
first measurement. The original fast WASM must reproduce its prior hash
`18c69302d9aaecc0078a5b398e68789f24adb66e525c99f8bc9ac9ddc60e9493`.
All 501 previously authored complete-evaluation cases must match the original
exactly for both mechanisms. Preserve source, dependency, original receipt and
module digests, raw records, numerical checks and failed evidence.

The single concurrent timing plan reuses the original twelve phase-balanced
authored fixtures, four repetitions, 1,000/10,000 static evaluation calls,
4,096/16,384 node searches, and 40 ms searches. Rotate
`[shipped, original, cached, fused]` by `(position+repetition)%4`. Exactly 768
records are required. Both optimized mechanisms must reproduce every complete
original fixed-node search result, including move, score, depth, node counters,
stop reason and PV. Timed search results need not match because throughput can
change. Run after the first equal-time game experiment finishes and while the
host is otherwise idle. This mechanism runner does not itself run games.

Before timing, freeze the following implementation-selection rule. A mechanism
is eligible only with exact complete evaluation on all 501 fixtures and all 96
fixed-node search signatures, at least a 5% median paired NPS improvement over
the concurrent original at 16,384 nodes, and no opening/middlegame/endgame
stratum with more than a 5% median paired NPS regression. Select the eligible
mechanism with the smallest absolute median elapsed time across its 48
16,384-node records; exact ties prefer cached phase. Select none if neither qualifies.
If one qualifies, a separately registered **200-game, 20 ms** diagnostic arm
against shipped HCE may run for that implementation only. This rule is
independent of the original 400-game outcomes. Those original scores do not
automatically apply to a faster implementation under equal time.

This is one bounded two-mechanism comparison, not an open optimization loop.
Do not change mechanism definitions or this selection rule after seeing their costs, selectively rerun
timings, omit regressions, or infer universal runtime saturation. A later
optimization needs its own exact-score protocol. Identical tested scores and
fixed-node search signatures establish diagnostic semantic equivalence; they
do not create a formal Elo gain or satisfy the physical-device gate.

Research outputs stay outside Git, retain the one-page memory allowance, and
preserve parameter licensing constraints. Planned local CPU spend is $0.

```sh
node test/training/hybrid-runtime-fused.test.js
node tools/training/hybrid-runtime-fused.js prepare /tmp/private-hybrid-mechanisms /tmp/prior-private-hybrid
# Native test and pinned build.sh for original, cached, fused; all before timing.
node tools/training/hybrid-runtime-fused.js measure /tmp/private-hybrid-mechanisms MECHANISM-COST.json
```
