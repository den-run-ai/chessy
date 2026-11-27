# Searched-edge board hash diagnostic

Status: both frozen runtime grids completed once. The prototype preserved every
fixed-node signature and improved median throughput on this exposed host screen.

The original measured HCE baseline rebuilds its board Zobrist hash during search. This isolated
prototype caches only the board piece-square pair, updating actual searched
edges after legality succeeds. It preserves the original separate raw EP
transposition key and legal EP repetition key. It does not update HCE totals,
change transposition-table replacement, or change production code or assets.

The existing pinned Rust 1.97.1 / Binaryen 131 build produced candidate SHA-256
`509a1d8e1c3fe1c05c31e57923c8127d35094bd68a704fc241cc4e8444b8fa9e`
(38,359 bytes), versus the original baseline module
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
node tools/search/check-historical-build.js hash /tmp/chessy-hash-candidate
```

Use the repository-pinned Rust and Binaryen paths when running the build. CI
runs the native oracle and differential search tests, rebuilds all four fast/small
raw/optimized WASM outputs, and compares them with the original execution
snapshot. It performs no timing experiment or production asset changes.

Pre-execution evidence hardening: the first registration and snapshot, retained
as `*-unexecuted-v1.json`, were never executed. The replacement adds one explicit
final observation-count assertion and freezes an independent summary that checks
raw signatures, the complete position/budget inventory and registration hash.
The candidate and experiment rules are unchanged. The active fixed registration
SHA-256 is `7501340b2a0d8e82e43999ab572aefbdf418d5d7cc6c69f3b789899150aaa39a`.

## Fixed-node runtime result

One host-exclusive run completed all 432 observations (18 exposed positions,
three node budgets, four repetitions, two modules). Every move, score, depth,
node and quiescence count, cutoff, re-search and stop field matched exactly.
All 39,744,000 requested measured nodes were searched. The independent Python
arithmetic audit reproduced the complete inventory, signatures and paired
medians (`fixed-independent-audit.json`). Raw observations and the executing
registration are in `fixed-results.json`; descriptive pair ratios are in
`fixed-summary.json`.

| Nodes per search | Median of 72 paired NPS ratios | Opening median | Middlegame median | Endgame median |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 1.0287 (+2.87%) | 1.0068 | 0.9842 | 1.1279 |
| 36,000 | 1.0455 (+4.55%) | 1.1263 | 1.0016 | 1.0913 |
| 230,000 | 1.0739 (+7.39%) | 1.0618 | 1.0670 | 1.1011 |

The **230,000-node group's** median of 72 paired ratios exceeds 1.03 and its
three phase medians all exceed .98, so the prospectively registered Master
comparison proceeds. The smaller budgets show uneven phase effects; the
10,000-node middlegame median is slower. These descriptive repeated-position
measurements do not establish Elo or a gain on every chess position.

The modules used equal 26,542,080-byte linear memories. On this Node 24.19.0
runtime, Brotli sizes were 17,690 bytes for baseline and 18,114 for candidate
(+424); these are research measurements, not a production size-gate verdict.

## Five-second Master runtime result

The conditional run completed all 72 observations (36 paired comparisons),
with every search stopping on its five-second time limit. Median paired
candidate/reference NPS was **1.08999 (+9.00%)**; median paired node count was
**1.09006 (+9.01%)**. Phase median NPS ratios were opening **1.06859**,
middlegame **1.05214**, and endgame **1.16749**. These are medians of the frozen
paired ratios, not geometric means or strength estimates.

Completed depth was deeper in **3/36** candidate pairs, the same in **32/36**,
and shallower in **1/36**. The chosen move matched in **34/36** pairs. Changes
were confined to the tactical-defence benchmark family:

| Position / repetition | Baseline move / depth | Candidate move / depth |
| --- | --- | --- |
| Tactical defence / 0 | g7g6 / 6 | e6f8 / 7 |
| Tactical defence, mirrored / 1 | e3f1 / 7 | g2g3 / 6 |

Maximum observed search wall time beyond 5,000 ms was **3.024 ms** for baseline
and **3.349 ms** for candidate. Both modules retained equal linear-memory size.
Independent Python arithmetic reproduced the pairing, medians, depth counts,
move changes and maximum overshoots (`master-independent-audit.json`). The full
raw data and executing registration are in `master-results.json`.

This supports continued development of the one incremental-board-hash candidate.
It does not establish a strength gain, equivalence on all chess positions,
physical-device behavior, additive gains with the separate quiescence prototype,
or release admission. At measurement time the candidate was 38,359 raw bytes,
1,187 bytes above the then-current 37,172-byte raw ceiling. That historical size
miss remains unchanged. The original Node 24 Brotli difference is diagnostic only.
Production code/assets remain unchanged by this research archive. Pure-cost
admission still needs the separate equivalence/runtime policy tracked in #175,
and physical-device evidence remains open in #84. No additional candidate,
fit, threshold search or timing rerun was performed. Paid compute: **$0**.

## Current size policy comparison

The repository now permits 40 KiB raw (40,960 bytes) and 20 KiB Brotli-11
(20,480 bytes). The original 38,359-byte candidate fits the current raw ceiling
with 2,601 bytes to spare. The correctness-only CI reproduction separately
computes and checks its compressed size under the size gate's pinned
Node 22.23.2 / Brotli 1.1.0 encoder. Its `currentPolicyComparison` output records
both observed sizes and ceilings. This new comparison does not rewrite the
historical measurements or their original size verdict, and does not authorize
production activation, physical-device claims, or a strength claim.

## Reusable loader hardening after measurement

The completed measurements executed the retained read-only 21-file snapshot
listed in `execution-snapshot.json`; their original schema-v1 registrations and
results remain unchanged. `pre-capture-hash-bench.source.json` preserves the exact measured runner bytes
as base64 data with their original SHA-256. The archive contains no executable
entrypoint; CI checks direct Node invocation and importing it load only data,
while interpreting a renamed copy as JavaScript fails. Decoding is for source inspection and hashing, not execution.

The reusable runner now applies the independently reviewed qsearch pattern:
capture runner, benchmark, signature fixture and capability-helper bytes once;
compile the captured runner; and authenticate the registration before evaluating
the retained benchmark. The adapter runs in a separate null-prototype realm
with string code generation disabled. Its only modules are narrow `fs`, `path`,
`zlib` and `perf_hooks` shims. Fixture reads use retained text; clock, UTF-8 and
compression operations exchange serialized values. No host function, object,
module loader or process object is exposed to adapter code. Fresh
registrations/results use schema v3. Synthetic tests replace cached modules,
runner/benchmark/fixture path contents, and first failing observations without
executing WASM. The original measurements were not rerun or reassigned to this
new loader. Their medians and routing decision are unchanged.

The source generator also captures and compiles its own bytes with both Rust
templates before deriving the source receipt. Synthetic replacement tests prove
that an earlier Node load cannot be credited to newer generator bytes and that
post-capture changes fail before an output tree is created. The eight original
Rust/build inputs now come from immutable Git commit
`dbf67181ab5d4e1c690617c14fe160b061191adb`, with replacements disabled and each
original SHA-256 checked. Current production search, ABI and asset changes do
not rebaseline this historical candidate. The fresh source receipt uses schema
v2 and records current generator hashes; its generated inventory must equal the
unchanged historical receipt. New reproduction reports are not measured-run
receipts. These local capability and provenance checks are not an OS sandbox.

New experiments use a persistent per-account ledger under
`~/.local/state/chessy-research/den-run-ai/chessy`. Its identity covers the protocol,
mode, unordered pair of module hashes, ordered FEN corpus, options, warmup and
order. Position labels and phase metadata do not create a new experiment. Paths,
timestamps, runtime metadata and implementation comments do not grant another
attempt. Registration rejects a spent identity; execution atomically creates and
fsyncs the ledger before engine instantiation, and never deletes it, including
after failure. The output lock remains a secondary protection; only its owner
may publish a failure record. A different registration losing the same prefix
cannot create or replace the winner's evidence. Synthetic tests
exercise concurrent starts, copied registrations, relocated module files,
comment-only runner copies and failed-attempt retries without running WASM.

The two exact completed scientific recipes (modules, ordered FEN corpus,
options, warmup and mode) are explicitly retired in the reusable runner, so an
empty new ledger cannot reopen these historical measurements. A different
future scientific recipe is not automatically retired by these entries. The ledger protects cooperating runs on this host/account with a
trusted filesystem; another host/account or owner deletion is outside that local
guarantee. It is not a distributed or adversary-proof strength-admission ledger.
Original read-only snapshots and reported results remain unchanged.

CI also reads the actual committed 504 observation rows and both original
registrations. It recomputes the complete summaries, fixed-node parity and
routing rule, Master depth/move/stop/overshoot totals, and checks their links to
the independent audits, source receipt and execution snapshot. Mutation tests
reject changed raw data, summary arithmetic, audit totals and cross-file hashes.
The complete 21-file execution-snapshot bytes are pinned, including every raw
and small WASM output and the measured summary implementation. Each path and
hash has a negative case. Fresh rebuild validation also rejects changed build
inputs, outputs, and coherently changed generated-source receipt claims.
These are arithmetic and preservation checks; they perform no engine searches,
new timing measurements or physical-device validation.
