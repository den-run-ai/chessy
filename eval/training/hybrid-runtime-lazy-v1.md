# One search-local lazy H8 runtime experiment

This is a separately registered, CPU-only engineering experiment. It follows
the completed phase-cache/shared-HCE comparison, where neither implementation
passed the 5% overall throughput gate. That decision and its skipped conditional
200-game follow-up remain final. The earlier synthetic eager accumulator study
does not answer whether skipping temporary legality probes helps this fitted
hybrid. This registration does not use current recovery-game outcomes.

## Immutable evaluator and scope

Use the existing private original `smooth-6-12` hybrid source receipt and exact
H8 binary SHA-256
`3a759a37d3af0beed0dda352a05294686d286176a4dcbdfa85a3fabef0083f25`.
Expanded HCE, neural heads, rounding, phase policy and every parameter stay
unchanged. No data collection, fitting, test-label access or model selection is
part of this experiment. Do not modify production assets, core engine files,
existing runner dependencies or memory policy. Generated fitted crates remain
outside the repository; no weights or chess positions from datasets are
committed. Research modules retain the existing one-page memory allowance.

There is exactly one new implementation, `lazy`, compared concurrently with
the exact original hybrid and shipped HCE. The original module must reproduce
the previous SHA-256 byte for byte. No eager-cache alternative, further mechanism,
parameter change or timing-driven repair is allowed within this registration.

## Prospective mechanism

Keep `Position` and `Undo` unchanged. A search-owned stack records packed moves,
validity and both H8 perspective accumulators by ply. It is created separately
for each public search entry, including fixed-depth and forced-root analysis.
Only an accepted searched child invalidates its frame and records a delta;
temporary legality, quiet-check, en-passant-hash and PV traversal probes never
touch this cache. Same-child PVS re-search and search-to-quiescence handoff reuse
the same frame. Siblings invalidate their own frame before reuse; parent frames
remain valid across unmake, cutoff and abort.

Neural materialization occurs only when an actual evaluation has phase >6.
When a cached ancestor exists, apply the recorded move deltas forward. If none
exists, reconstruct the current board once and reverse the recorded path to
populate ancestor caches. This allows a promotion to reactivate neural work
after skipped low-phase ancestors without stale state. Both piece perspectives
are updated before clipping; capture, promotion, en passant and castling deltas
must match the rule engine exactly. Original phase dispatch and the separate
complete HCE calculations remain as controls; this is not another shared-HCE
variant. HCE still scans the board, but its neural additions use the cache.

Local stack allocation, validity bookkeeping and accumulator memory are part of
the candidate's measured cost. Report actual Rust layouts and full compiled
module bytes/Brotli bytes; unchanged Position size does not imply zero overhead.

## Required validation before cost eligibility

- Preserve exactly 501 complete evaluation scores from the prior authored
  compiled corpus; compare private original and independent frozen reference.
- Exhaustively traverse the existing authored two-ply special-move corpus,
  independently reconstructing raw accumulators and complete hybrid scores.
  Cover both turns, all promotions, captures, castling and en passant; verify
  legal-generation and EP probes leave state/cache valid.
- Explicitly test siblings, repeated same-ply evaluation, skipped ancestors,
  phase-reactivating promotions, root resets, budget aborts, PVS re-search and
  search-to-quiescence transitions. Compare native original and candidate
  available result fields on fixed deterministic node budgets.
- Require Position=74 bytes and Undo=10 bytes. Report search-stack bytes.
- Compare every returned fixed-node search result object for the full cost
  corpus: 12 positions × 4 rotations × 2 budgets = 96 exact pairs. These include
  moves, scores, completed/attempted depth, counters and stop reason as actually
  exposed by the current API. `engine.search()` returns no PV; PV equality is
  explicitly outside this protocol and must not be claimed.

Any failed required validation makes the candidate ineligible. Source/native
technical defects discovered before timing may receive a documented separate
fix commit and renewed review; no timing-informed implementation changes are
allowed. Publish this plan first and freeze all final source plus dependencies
before compilation or measurement. Native tests/builds wait for the ongoing
400-game timing to finish; costs wait for an independently confirmed quiet host.

## One concurrent cost grid and fixed decision

Reuse exactly the 12 exposed authored runtime fixtures, four each opening,
middlegame and endgame. Four repetitions rotate `[shipped,original,lazy]` by
`(position + repetition) % 3`; every fixture/configuration pair is retained.
Each cell runs 1,000 warmup and 10,000 measured loaded evaluations, then searches
at 4,096 nodes, 16,384 nodes and 40 ms, maxDepth=111 and quiescence enabled.
There are exactly 576 measured records. Report early completions and actual
visited nodes; do not discard them. Preserve all raw search fields, timings,
module/source/toolchain identities, plan, row order and environment versions.

The sole candidate is eligible only if all required validation passes, the
overall paired-median 16K NPS ratio versus concurrent original is at least 1.05,
and every phase stratum's paired-median ratio is at least 0.95. No alternative
aggregation or cheaper phase subset can replace this rule. Shipped comparisons,
evaluation microbenchmarks, 4K and 40 ms measurements are diagnostics only.

Create an exclusive start ledger beside the canonical original private build
before timing. A changed output directory does not create another attempt.
Retain canonical raw bytes in memory and publish the full receipt atomically
after timing, with its hash and compressed copy; preserve incomplete attempts
and do not selectively rerun cells or the grid. Failure to retain complete
authenticated evidence invalidates the experiment.

This protocol authorizes no games. Any conditional equal-time follow-up must
be separately registered before observing costs. A throughput pass is not an
Elo claim or production admission. Whether pass or fail, this closes this one
lazy prototype; future work needs a separate justified experiment. It does not
establish universal runtime saturation or require spending the $30 allowance.
