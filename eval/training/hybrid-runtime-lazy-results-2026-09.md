# Search-local lazy H8 runtime results

The single lazy accumulator prototype preserved the frozen hybrid scores but
**failed the registered overall throughput gate**: median paired 16K NPS improved
3.70% over the concurrent original, below the required 5%. Every phase guard
passed. No implementation was selected and the separately registered conditional
200-game match was skipped. There was no timing retry or implementation change
after observing costs.

The [runtime plan](hybrid-runtime-lazy-v1.md) and
[conditional match plan](hybrid-match-lazy-v1.json) were frozen together in local
commit `b4e4e26` and published as
[`8ce1c03`](https://github.com/den-run-ai/chessy/commit/8ce1c034a073d3518394dce521b8d23b626a1b10).
Reviewed source was frozen in local commit `9d01299` and published as
[`1f61789`](https://github.com/den-run-ai/chessy/commit/1f61789e1a21c5be1bf7f9493956f6a2e005ffd7)
before any tests, compilation or costs. Current game outcomes did not determine
this experiment's trigger or decision rule.

| Phase stratum | Lazy 16K NPS vs original | Lazy 40 ms NPS vs original |
|---|---:|---:|
| All positions | +3.70% | +2.22% |
| Opening | +9.67% | +8.38% |
| Middlegame | +5.95% | +2.22% |
| Endgame | −1.13% | −4.44% |

These are medians of paired observations; the overall median is not the mean
of the three stratum medians. The separate 4K diagnostic improved overall NPS
5.45%, but that was not the registered selection metric. No alternative metric
was substituted. Both 4K and 16K comparisons retained all 48 pairs, including
four early completions; actual visited nodes were used.

| Module | Fast WASM bytes | Brotli bytes | Linear memory bytes |
|---|---:|---:|---:|
| Shipped HCE | 37,172 | 17,690 | 26,542,080 |
| Concurrent original hybrid | 58,085 | 28,857 | 26,607,616 |
| Lazy hybrid | 60,771 | 30,280 | 26,607,616 |

The candidate added 2,686 raw / 1,423 Brotli bytes over the original. `Position`
remained 74 bytes and `Undo` 10 bytes; its local 128-frame cache occupied 9,216
bytes per active public search. Stack high-water usage was not measured. Loaded
static evaluation became 18.86% slower than original overall: this entrypoint
creates a fresh cache for every call, unlike recursive search. All costs include
the implemented allocation/initialization and bookkeeping.

The implementation records moves only on accepted searched edges and constructs
raw White/Black accumulators only when neural evaluation is needed. It leaves
temporary legality/check/EP probes and PV traversal untouched, and skips neural
materialization in the expanded-only phase. Reversing the first evaluated leaf
back through its actual path makes unevaluated ancestors reusable; subsequent
evaluations apply deltas from the nearest valid ancestor. No model, gate, HCE
parameters or rounding changed.

Validation passed on the first execution:

- The original module reproduced SHA-256
  `18c69302d9aaecc0078a5b398e68789f24adb66e525c99f8bc9ac9ddc60e9493` exactly.
  Lazy SHA-256 was
  `39e229d2f3a7774836a98a3fc3cd5bad3bb2ca3beb39b204bd8b9eb9e41eae15`.
- Original and lazy native crates passed 10 and 19 tests. Independent raw
  accumulator reconstruction and complete-score checks covered 13,919 authored
  path positions and all 25 required move classes, both turns, skipped ancestors,
  promotion reactivation, stale sibling frames and the final legal cache slot.
- Native original/candidate search comparisons exercised 469 PVS re-searches,
  32,271 quiescence nodes and 89 budget aborts, plus fixed-depth and forced-root
  entrypoints. Position restoration and exact returned fields passed.
- Both compiled modules matched all 501 independent affine-HCE/BigInt-neural
  complete-score references. All 96 returned fixed-node search result pairs
  matched exactly. The API returns no PV; PV equality was explicitly excluded
  prospectively and is not claimed.
- The single quiet-host run retained all 576 registered records, source/native/
  build receipts, toolchain executable hashes, module hashes and the canonical
  attempt ledger. Raw JSON and gzip bytes were published atomically with a
  hash envelope after timing. The [aggregate receipt](hybrid-runtime-lazy-results-2026-09.json)
  binds the retained evidence without publishing trained weights or dataset rows.
- Independent audit passed: it rechecked 1,503 actual compiled scores across
  the 501 positions, authenticated all 576 rows, reproduced every summary and
  the ineligible decision, and compared all 96 stored fixed-node pairs. It ran
  no searches or timing retries.

This closes the separately registered lazy prototype. The completed
[phase-cache/shared-HCE study](hybrid-runtime-fused-results-2026-09.md) remains
unchanged: neither prior candidate was eligible. Lazy accumulation shows a
useful opening/middlegame effect, but none of these three bounded candidates
passes its overall gate. This does not establish universal runtime saturation;
it supports stopping this engineering screen without additional unregistered
tuning or consuming the paid-compute allowance.

These are one-host V8 diagnostics on 12 authored fixtures, not physical-device
or production admission. In this concurrent run original/lazy 16K NPS remained
18.34%/13.53% below shipped HCE; results from separate timing runs are not pooled.
Paid compute was $0. No weights, labels, production code, shipped WASM or
production memory limit changed, and no strength claim follows from these costs.
