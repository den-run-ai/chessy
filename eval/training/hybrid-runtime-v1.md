# Private fitted hybrid runtime diagnostic

This is a separate research runtime experiment, authorized for the hybrid
screen. Earlier offline recipes remain unchanged. This experiment cannot admit
a production evaluator, consume the sealed test, choose a gate using runtime
scores, recalibrate levels, or establish playing strength. Fitted parameters and
generated Rust/WASM remain outside Git; their original licensing/provenance
constraints persist.

The gate is selected by the separately frozen offline screen before this
experiment measures costs. The fixed options are hard fallbacks at phase 4, 6,
or 8 and linear transitions 2–8, 4–10, or 6–12. Phase is
`min(24, N+B+2R+4Q)` across both colors. The neural evaluator is **shipped HCE
plus the frozen H8 correction**. The hybrid blends its complete rounded score
with complete rounded expanded HCE. It must never add that learned correction
directly to expanded HCE. Linear mixing rounds White-POV scores with
`floor((w*neural+(den-w)*expanded+den/2)/den)`.

Implementation: a material-phase board scan selects the endpoint/transition;
the neural path accumulates H8 features inside the shipped HCE board loop.
Expanded HCE is skipped above the transition, neural evaluation is skipped in
the fallback, and both full HCE evaluations run inside the transition. This
measures an actual implementable hybrid, including its prescan and transition
cost. There is no incremental neural cache or production engine mutation.

The controls are shipped WASM, a compiled expanded-HCE-only copy, and a
compiled frozen-H8-only copy. The same pinned Rust 1.97.1 and Binaryen 131 build
is used for all copies. First reproduce shipped fast WASM byte for byte. Each
research copy retains the earlier explicit one-page memory allowance: 26,607,616
bytes versus shipped 26,542,080. This does not satisfy the production memory cap.

Before timing, all three generated crates must pass their native tests. The
tests compare fused neural evaluation with full refresh, check both-turn
evaluation, legal generation, make/unmake restoration, captures, both colors of
en passant and all castling sides, and both colors of four promotion types with
and without capture. A depth-two authored tree must exercise every move class
and cross the selected phase boundary. Exact JS affine HCE plus the independent
BigInt neural oracle then check complete compiled scores on 501 authored root
and legal one-ply positions. Endpoint passthrough and negative half ties are
also tested separately. Generated-source and dependency hashes must reproduce
before measuring, and the complete parity receipt is saved before timing.

The fixed cost plan has twelve exposed authored fixtures, four each in
opening (phase 24), middlegame (phase 10 or 14), and endgame (phase 0, 2, or 4).
These coarse phase strata are balanced; this is not a representative sample of
natural games and does not balance exact phase values or all transition bands.
Fixture JSON SHA-256 is
`605b1488480d06dd741da5bafb503e6a4d073d4f1df57e40c0d1ba32b97e6aab`.

Every fixture receives four repetitions. Rotate the four engine variants by
`(position+repetition)%4`, so each is first once. Each record includes:

- 1,000 evaluation warmups and 10,000 measured evaluations;
- search at 4,096 and 16,384 nodes, maximum depth 111, quiescence enabled;
- search at 40 ms with no node cap, maximum depth 111, quiescence enabled.

Exactly 768 measurement rows are required; do not omit failures or replace
selected configurations. Preserve source, module and model hashes, actual
visited nodes, qnodes, completed depth, stop reason, timing, per-stage paired
ratios, full raw records, memory and raw/Brotli module sizes. V8 costs and timed
search depths are diagnostic; physical-device testing and separately registered
equal-time game matches remain distinct gates.

Commands:

```sh
node test/training/hybrid-runtime.test.js
node tools/training/hybrid-runtime.js prepare /tmp/private-hybrid INPUTS.json
# Run pinned cargo test and build.sh in each generated expanded/neural/hybrid.
node tools/training/hybrid-runtime.js measure /tmp/private-hybrid COST.json
```

`INPUTS.json` uses `chessy.hybrid-runtime-input.v1`, explicit research flags,
the selected gate object, externally digested `model`, `metadata` and
`expandedSelection` files, and an independently pinned
`expandedWeightsSha256`. The preparer creates a fresh private directory and
refuses any output below a Git checkout. No fitted numbers enter this protocol
or committed tests. CPU compute is local; planned paid spend is $0.
