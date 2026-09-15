# Searched-edge board hash diagnostic

Status: candidate frozen after correctness checks; performance has not run.

The shipped HCE rebuilds its board Zobrist hash during search. This isolated
prototype caches only the board piece-square pair, updating actual searched
edges after legality succeeds. It preserves the original separate raw EP
transposition key and legal EP repetition key. It does not update HCE totals,
change transposition-table replacement, or change production code or assets.

The existing pinned Rust 1.97.1 / Binaryen 131 build produced candidate SHA-256
`509a1d8e1c3fe1c05c31e57923c8127d35094bd68a704fc241cc4e8444b8fa9e`
(38,359 bytes), versus the unchanged shipped module
`57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f`
(37,172 bytes). This adds 1,187 raw bytes. See `source.json` and `build.log`.

Before timing, the generated native test module passed two tests covering
6,555 legal special-move edges with full-scan equality and parent restoration;
104 ordinary, 104 direct fixed, and 264 shared-budget forced-root/PV searches;
and repeated root histories. It compares every cached hash request to the
unaltered full-scan oracle and compares complete search counters and stop
semantics to the original search compiled alongside it. Source isolation tests
also passed. Independently loaded WASM modules matched all 144 existing full
ordinary/forced-root signature and PV cases (`wasm-parity.json`). These checks
used the pinned local toolchains and Node 24.19.0; their durations are not
performance evidence.

`PLAN.md` freezes the routing rule before the first timing result. The concrete
fixed registration binds one baseline, one candidate, all 18 exposed positions,
exact options, runtime, source receipt, and executing benchmark dependencies.
The host is reserved exclusively for each timed session. No evaluator or
production integration is authorized by this research result. Paid compute: $0.

Reproduce source generation and correctness with:

```sh
node test/search/hash-cost.test.js
node tools/search/hash-cost.js prepare /tmp/chessy-hash-candidate
(cd /tmp/chessy-hash-candidate && cargo test --locked --offline searched_hash_tests)
sh /tmp/chessy-hash-candidate/build.sh
```

Use the repository-pinned Rust and Binaryen paths when running the build. CI
runs the generated native oracle and differential search tests; it does not
run this optional timing experiment or alter the committed production module.

Pre-execution evidence hardening: the first registration and snapshot, retained
as `*-unexecuted-v1.json`, were never executed. The replacement adds one explicit
final observation-count assertion and freezes an independent summary that checks
raw signatures, the complete position/budget inventory and registration hash.
The candidate and experiment rules are unchanged. The active fixed registration
SHA-256 is `7501340b2a0d8e82e43999ab572aefbdf418d5d7cc6c69f3b789899150aaa39a`.
