# Independent-process throughput protocol

This diagnostic measures how many independent fixed-node searches one host can
finish with one, two, or four Node/WASM processes. Each process has its own
module instance, linear memory, search state, and evaluator. It does not split
one search tree across cores and does not activate production threads.

The implementation and model come from the completed, independently audited
cost screen: the selected WASM target and variant, with the unchanged full
model. The frozen cost selection is SIMD/fused. The protocol does not read the
fresh opening bank or game outcomes. The source inputs and their exact hashes
are declared in [PARALLEL-CONFIG.json](PARALLEL-CONFIG.json).

## Work and timing

Every worker-count setting receives the same total work: the 72 frozen cost
roots at 36,000 nodes, repeated in three balanced-order blocks. This produces
216 searches per setting and 648 measured searches overall. There are 72
distinct roots. Root order and round-robin assignment are fixed before timing;
each worker receives equal job and phase counts.

A fresh process performs the same 32 authored warmup searches as the cost
screen and loads all measured roots before a READY/GO barrier. The Node flags
are `--no-liftoff --no-wasm-lazy-compilation`. Every measured search uses the
existing frozen host, fixed node budget, maximum depth 30, and empty root history
used by the cost screen. This history setting is specific to static root
comparisons; the separate game adapter replays complete legal histories.

Two measurements answer different questions:

- **Aggregate throughput:** actual returned nodes divided by coordinator batch
  wall time. This timer includes GO dispatch, scheduling, IPC, and result
  serialization, and ends when every DONE response arrives.
- **Per-search latency:** time inside each synchronous WASM search call, measured
  by the frozen host. The report gives mean, median, p95, minimum, and maximum.

Compilation, loading, parsing, and warmup are outside both measured intervals.
All search outputs must match the selected cost screen's signatures exactly.
One missing, duplicated, changed, or failed job invalidates the study; the
harness preserves the failed output and has no retry mode.

Workers are pinned to the first one, two, or four available CPU slots, and the
coordinator to the last distinct available slot. The report records CPU model,
affinity, worker CPU time, and exposed cgroup metadata. If cgroup quota and
throttling files are unavailable, the quota remains unknown. Available CPU
affinity is not proof of a corresponding CPU-time entitlement.

Memory reporting includes each worker's RSS before and after the measured block,
its process-lifetime peak RSS, and its fixed WASM linear memory. The sum of
individual worker peak RSS values is an upper bound: those peaks need not occur
at the same instant, and include compilation/warmup. Coordinator memory is not
included in worker memory totals. Coefficient payload alone is much smaller than
the complete process and linear memory allocations.

## Freeze and execute

Run the focused contract test when the exclusive measurement slot is free:

```sh
node test/training/sparse-v2-parallel.test.mjs
```

Prepare a new exclusive registration. Preparation hashes and consumes the same
retained input bytes and performs no engine calls:

```sh
node tools/sparse_eval_v2/parallel.mjs prepare \
  eval/sparse-pesto-v2/PARALLEL-CONFIG.json \
  /workspace/library-files/chessy-sparse-v2-work/cost-registration-v1/manifest.json \
  /workspace/library-files/chessy-sparse-v2-work/cost-results-v1/results.json \
  /workspace/library-files/chessy-sparse-v2-work/cost-audit-v1/audit.json \
  /workspace/library-files/chessy-sparse-v2-work/parallel-registration-v1
```

The returned manifest SHA256 is a required execution argument. Use the copied
`parallel.mjs` in the registration and the Node executable recorded there.
Replace `MANIFEST_SHA256` with the returned hash; do not reuse an output prefix:

```sh
/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /workspace/library-files/chessy-sparse-v2-work/parallel-registration-v1/parallel.mjs run \
  /workspace/library-files/chessy-sparse-v2-work/parallel-registration-v1/manifest.json \
  MANIFEST_SHA256 \
  /workspace/library-files/chessy-sparse-v2-work/parallel-results-v1
```

Do not execute while another benchmark, game campaign, build, or audit has the
exclusive CPU slot. The complete game campaign and independent outcome audit
must release it first. Sources, configuration, selected module/model, host,
rules, reference signatures, and verified executable identities are frozen
before the first timing. Read-only registration files are rechecked before
completion publication. The nine blocks and all 648 raw observations are kept;
`results.json` is written last.

The result is a descriptive throughput study on one host. It neither establishes
playing strength nor predicts browser-device scaling or faster latency for an
individual chess move. No confidence interval or quota-independent hardware
claim is inferred from three repeats.
