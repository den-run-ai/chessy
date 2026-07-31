# Minimal Rust/WASM experiment results

Run date: 2026-07-28

> Historical feasibility record. The production cutover described in
> [`README.md`](./README.md) happened later; statements below about what still
> needed approval describe the state on this run date.

## Verdict

**RUST PORT PASS — advance the unchanged worker/mobile protocol.**

Rust preserves the exact accepted search, reduces the fast binary, and is
faster than the frozen Zig module on every mirrored benchmark family in the
same-process comparison. This removes the main evidence-based objections to
using Rust as the long-lived implementation language.

This is still an isolated backend experiment, not production GO. The stacked
probe must rerun browser/mobile targets against the Rust bytes, and physical
ARM, thermal, battery, memory-pressure, watchdog, and offline-delivery gates
remain outside hosted CI.

## Frozen input and toolchain

- Baseline: `ff820848454d30f7c22bb94914250ed6214e30ba` (accepted #116
  search core plus later non-play-engine changes).
- Reference Zig source: PR #124 commit
  `250238ab4f146568288acade6e1942e9833a5070`, Zig 0.16.0.
- Reference Zig module: exact #124 fast build, SHA-256
  `99203e1f79be3057b77d6cbcc55abcc9a0c38e4d9da9689373d28b654ce922cd`.
- Rust: 1.97.1 (`8bab26f4f`), `wasm32-unknown-unknown`, `no_std`.
- Binaryen: 131.
- Fast: Cargo `release`, fat LTO, then `wasm-opt -O3 --converge`.
- Small: Cargo `opt-level=z`, fat LTO, then `wasm-opt -Oz --converge`.
- No dependencies, allocator, `wasm-bindgen`, WASI, SIMD, threads, libc, GC,
  or per-node allocation.
- Exact initial/maximum linear memory: 26,542,080 bytes (405 pages).

## Correctness and reproducibility

| Gate | Result |
| --- | ---: |
| Rust unit tests | 5/5 |
| JavaScript fixed-depth parity | 18/18 through depth 5 |
| JavaScript 5,000-node abort parity | 18/18 |
| Decoder/boundary/reset assertions | 6/6 |
| Direct Rust/Zig depth-6 differential | 18/18 |
| Direct Rust/Zig 100,000-node abort differential | 18/18 |
| Castling/promotion/en-passant/pinned-EP/endgame witnesses | 16/16 |
| Two clean fast/small builds | byte-identical raw and optimized output |

Every search differential matches move, score, completed and attempted depth,
nodes, qnodes, cutoffs, re-searches, and stop reason. The deeper Rust/Zig screen
covers about 7.67 million nodes per module on workloads beyond the original
JavaScript depth-5 proof.

The optimized fast module SHA-256 is
`dab3d6025d507b2c93218616f3871cb7c13d7542e848ea741a750485b5cef6db`.
Generated binaries remain excluded from git.

The final module imports only `env.now_ms` and exports only `memory`,
`input_ptr`, `result_ptr`, `load_position`, and `search`. Memory begins and
ends at 26,542,080 bytes; `memory.grow(1)` is rejected.

## Binary size

Brotli uses quality 11, matching the existing harness.

| Variant | Rust raw | Rust Brotli | Zig #124 raw | Zig #124 Brotli |
| --- | ---: | ---: | ---: | ---: |
| Fast | **32,083 B** | **16,165 B** | 35,256 B | 16,704 B |
| Small | 22,742 B | 14,293 B | **22,416 B** | **14,060 B** |

Rust fast is 3,173 bytes (9.00%) smaller raw and 539 bytes (3.23%) smaller
compressed than Zig fast. Rust small is effectively tied with Zig's floor:
326 bytes raw and 233 bytes Brotli larger.

The Rust small build is not the recommended runtime artifact. In an
order-balanced direct comparison it delivered only 0.4882x the fast build's
geomean NPS. Spending 1,872 additional compressed bytes on fast therefore buys
about 2.05x throughput. The experiment retains small as a download floor and
uses fast for all runtime gates.

## Depth-5 host throughput

Host: Linux x86_64 (kernel 6.12.13), Node 24.14.0. Command:

```sh
node experiments/wasm/bench.js --depth 5 --reps 2 --min-ms 100 --require-go
```

Method: full-depth warm-up, two AB/BA repetitions, short-search batching to at
least 100 ms per side, and exact-tree comparison before timing is accepted.

| Metric | Rust result |
| --- | ---: |
| Exact search parity | 18/18 |
| Geometric-mean paired NPS versus JavaScript | **27.3268x** |
| Worst / p10 mirrored-family ratio | **19.7760x** (promotion race) |
| Slower families | 0/9 |
| Fast instantiation | 0.51 ms |
| First measured depth-5 search | 44.36 ms |
| Initial/final linear memory | 26,542,080 B |

The frozen Zig binary measured 24.6485x geomean and 17.1208x worst family in
the earlier same-host rerun. A direct, interleaved Rust/Zig benchmark removes
the changing JavaScript denominator:

```sh
node experiments/wasm/bench.js \
  --baseline-wasm /path/to/pr-124/chessy-ai-fast.wasm \
  --depth 5 --reps 2 --min-ms 100
```

| Direct Rust/Zig metric | Result |
| --- | ---: |
| Exact parity | 18/18 |
| Rust/Zig geomean NPS | **1.0759x** |
| Worst mirrored family | **1.0268x** (tactical defence) |
| Rust-slower families | 0/9 |

This is a host/Node/V8 language comparison, not a mobile speed claim. Its value
is that Rust does not trade away the proven feasibility margin.

## Five-second diagnostic

On Kiwipete:

| Engine | Completed depth | Attempted depth | Nodes |
| --- | ---: | ---: | ---: |
| Rust/WASM | 7 | 8 | 6,132,735 |
| JavaScript | 4 | 5 | 171,007 |

Both hit the five-second deadline. This is time-to-depth evidence on one host,
not strength, physical-device, or thermal evidence.

## Codebase and production scope

The port contains about 2,900 Rust source lines for rules, evaluation, search,
and the raw ABI, plus build, test, benchmark, and documentation code.
Production JavaScript, PWA caching, and worker behavior remain unchanged.

A production backend still needs:

- complete repetition-history input and PV/provenance output;
- worker prewarming, timeout/cancellation, fallback, and stale-result handling;
- service-worker precaching, atomic update tests, and correct
  `application/wasm` delivery;
- TT/memory sizing for the declared minimum phone;
- physical-device cold/warm latency, p10/tail, 30-minute thermal behavior,
  battery use, jetsam/memory pressure, watchdog behavior, and offline reload;
- a separately gated strength/calibration decision before replacing the
  shipped JavaScript engine.

The failed SEE experiment #121 is orthogonal: it changed move ordering, while
this port preserves the accepted #116 tree exactly. NNUE also remains a
separate evaluator experiment and must not be combined with the runtime
language decision.

## Next gate

Stack the already-validated Web Worker/mobile-target harness on this Rust
module and rerun its complete matrix. Preserve the browser protocol and report
fresh Rust results; do not copy Zig's run. If that stays green, Rust becomes the
default implementation candidate for the physical-device and production
design work.

## Hosted Web Worker/mobile-target matrix

The stacked mobile probe ran the Rust module from source in GitHub Actions at
commit `b17fc19a89400aa66f1898873992ecf12b57c90f`. The canonical code-only run is
[30324384519](https://github.com/den-run-ai/chessy/actions/runs/30324384519);
all build, probe, and aggregate jobs passed on its first attempt.

| Target | Depth 1-5 parity | Fixed-node abort | NPS geomean | Worst family | Slower families |
| --- | ---: | ---: | ---: | ---: | ---: |
| Android Chrome | 90/90 | 18/18 | **7.6121x** | 6.3048x | 0/9 |
| Chromium | 90/90 | 18/18 | **7.3286x** | 6.9119x | 0/9 |
| Chromium, 4x CPU throttle | 90/90 | 18/18 | **7.5811x** | 6.8070x | 0/9 |
| iOS Safari | 90/90 | 18/18 | **9.8122x** | 8.4589x | 0/9 |
| Node host | 90/90 | 18/18 | **24.5234x** | 17.8642x | 0/9 |
| Playwright WebKit | 90/90 | 18/18 | **9.4631x** | 8.4359x | 0/9 |

Across the matrix, exact parity passed 540/540 searches and fixed-node abort
parity passed 108/108 searches, with no slower mirrored family. Every target
reported the expected 26,542,080-byte (25.31 MiB) linear-memory reservation.
The fast module was 32,083 bytes raw and 16,165 bytes Brotli; the optimized
module SHA-256 was
`dab3d6025d507b2c93218616f3871cb7c13d7542e848ea741a750485b5cef6db`,
matching the feasibility build. The workflow also rebuilt in a separate target
directory and byte-compared every raw and optimized output.

For the four hard five-second positions, Rust/WASM completed depth 7 in all 24
target-position cells. JavaScript completed depth 4-6, so Rust was never
shallower. The browser ratios remain in the same broad range as the Zig mobile
probe, but the separate hosted runs are not a controlled Rust-versus-Zig speed
comparison.

This clears the hosted browser-engine gate, not the physical-device gate.
Android used an x86_64 KVM emulator and iOS used an arm64 simulator. Real
midrange Android and iPhone hardware still must establish ARM wall time,
30-minute thermal behavior, battery use, jetsam/memory pressure, and watchdog
behavior before production approval.
