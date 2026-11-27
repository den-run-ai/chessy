# Research WASM adapter and matched measurements

The research adapter uses the same `core.rs`, generated HCE constants, SIMD
helper, and pinned r84 engine/search as the native adapter. It does not replace
the production WASM asset or change the production ABI. Its independent research
ABI is version 1; the production application continues to require its own ABI
version 2.

## Scalar and SIMD builds

`build_wasm.py` creates scalar and `simd128` modules from one authenticated source
snapshot. Rust is pinned to 1.97.1 at commit
`8bab26f4f68e0e26f0bb7960be334d5b520ea452`; Binaryen is pinned to 131. Both builds
use optimization level 3, fat LTO, one code-generation unit, and aborting panics.
The exact compile/optimization commands, tool hashes, source hashes, modules,
disassembly, and operation counts are retained in each build receipt.

```sh
python3 tools/sparse_eval_v2/build_wasm.py \
  --rustc /path/to/pinned/rustc \
  --wasm-opt /path/to/binaryen-131/bin/wasm-opt \
  --wasm-dis /path/to/binaryen-131/bin/wasm-dis \
  --output /absolute/new-build-directory
```

`--wide-fused` produces a separately identified build with a wider fused
PST/own-king table. The loader rejects coefficients or derived pairs outside
the chosen storage range; it does not clip or quantize them. See
[NATIVE.md](NATIVE.md) for the shared numeric and rounding contracts. The full
model needs 16,712 coefficient bytes and a 16,716-byte `Model`; the wide version
needs 22,856 and 22,860 bytes respectively.

The explicit SIMD helper reads four groups of sixteen piece bytes, compares
them with the empty-piece code, extracts lane bitmasks, and converts the board
orientation. Remaining evaluation and search arithmetic is shared. The build
checks that scalar WASM contains no SIMD instructions and that SIMD WASM emits
the occupancy `i8x16.bitmask` operation. This is an actual vector operation,
not a claim that the complete evaluator is vectorized or that SIMD must win.

Each module has fixed 32 MiB linear memory and a 1 MiB stack. There is no WASI,
allocator, `wasm-bindgen`, module thread, or per-node allocation. The fixed
memory also contains the search tables, batch positions, upload buffer, and
evaluation cache. Coefficient bytes are therefore only one part of memory use.
The Node host separately retains module/model/rules buffers and JavaScript
objects. `info()` reports module memory, model, coefficient, and cache sizes.

These are research build receipts for exact observed modules. Compiler commands
include their retained source paths; this script does not promise identical
module bytes when rebuilt under a different absolute source location. Numerical
parity is checked independently, and every measured binary is authenticated by
its actual byte hash. Production's separate reproducible build is unchanged.

## Node host

`wasm_runner.mjs` depends only on Node built-ins and the explicitly supplied
module, model, and rules files. It reads each input once, hashes those buffers,
and instantiates or evaluates those same bytes. The rules implementation runs
in an isolated JavaScript context. `INFO` reports the module/model/rules hashes,
Node/V8 versions, Node flags, selected variant, SIMD presence, and memory sizes.

```text
node wasm_runner.mjs info module.wasm full.i16le fused rules.js
node wasm_runner.mjs eval module.wasm full.i16le fused rules.js fens.txt
node wasm_runner.mjs bench module.wasm full.i16le fused rules.js fens.txt PASSES WARMUP_PASSES
node wasm_runner.mjs search module.wasm full.i16le fused rules.js fens.txt NODES MAX_DEPTH
node wasm_runner.mjs serve module.wasm full.i16le fused rules.js
```

The measured Node host uses `--no-liftoff --no-wasm-lazy-compilation` before the
script name. Startup uses synchronous `WebAssembly.Module` and
`WebAssembly.Instance` construction outside measured intervals. The CLI awaits
its main function and resolves its entry path before comparing module URLs.
These details fix the preserved initial preflight failure in which the
optimizing-only host exited successfully without an INFO reply. The corrected
preflight passed the actual game runner's strict parser and legal-move check
before the cost screen or games began.

The exported `WasmEvaluator` class supplies `loadPositions`, `loadHistory`,
`evaluate`, `benchmark`, `search`, `clearCache`, `cacheStats`, and `info`.
There is no hidden warmup. Static batches run their complete loop inside WASM
with opaque input/result barriers, so there is no JavaScript call per evaluated
position and the compiler cannot hoist a pure repeated evaluation out of the
loop. Cached repeated batches intentionally measure a hot-cache workload.
Runtime selection instead uses complete fixed-node search.

## Complete-history game requests

Persistent `serve` accepts `INFO\tid` or the same ten-field tab-separated SEARCH
request as the native adapter:

```text
SEARCH  id  mode  nodes  time_ms  max_depth  0  initial_fen  expected_final_fen  full_uci_history
```

Use actual tabs, `hce` or `candidate` mode, canonical six-field FENs, and the
complete space-separated UCI move sequence. Root seed is fixed to zero by the
pinned search. The host legally replays every move through JavaScript rules,
verifies the final FEN including raw en-passant and counters, and uploads every
history occurrence including the current root. A separate Python arbiter
validates actual games. Invalid replay, malformed history, or an illegal engine
move fails the request. A WASM trap ends that instance.

Search replies use White POV and include move, score, node/qnode counters,
completed/attempted depth, stop reason, cutoffs, re-searches, TT saturation,
verified-FEN status, history counts, and cache counters. `elapsed_ns` measures
the synchronous WASM call. `request_elapsed_ns` also includes legal replay and
host validation. The game runner records request wall time separately.

Static cost roots use empty prior history and are checked under that separate
contract. They must not be substituted for complete-history game requests.

## Evidence and limits

The focused `sparse-v2-wasm.test.py` suite checks independent Python score
parity across coefficient families, scalar/SIMD and narrow/wide paths; signed
rounding; stale-model invalidation; fixed memory; special-move and repetition
history; and optimized-flag CLI/symlink startup. The completed cost screen adds
exact fixed-node signatures across native and WASM targets for all selected
roots, budgets, variants, and replicates. Its independent audit reconstructs
all observations and selection decisions without running an engine.

Native builds target portable x86-64 while V8 can select instructions for the
host CPU. The native/WASM comparison is a matched numeric and search workload
on the recorded execution host, not a universal instruction-set-controlled
comparison or a mobile browser forecast. See
[the complete report](../../eval/sparse-pesto-v2/REPORT.md) for measurements and
[the parallel protocol](../../eval/sparse-pesto-v2/PARALLEL.md) for the separate
one/two/four-process throughput experiment.
