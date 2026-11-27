# Independent-process throughput results

**Two processes delivered 1.520× aggregate throughput; four delivered 2.050×.**
Individual searches became slower under concurrency: mean call latency rose
from 48.05 ms with one process to 55.08 ms with two and 72.14 ms with four.
This is useful evidence for batching independent searches. It does not speed up
one search tree or establish a faster response for a single chess move.

All nine registered blocks completed once, with no failures, retries, missing
jobs, or signature differences. The 648 measured search signatures exactly
matched the audited cost screen. Each worker-count setting performed the same
216 searches and 7,776,000 returned nodes: 72 distinct development roots,
36,000 nodes each, repeated in three blocks. The fixed model and implementation
were the cost-selected **full model, WASM SIMD, fused evaluator**. No game
outcomes, fresh opening-bank positions, teacher labels, alternative models, or
new fitting were used. The registration, raw inventory, and exact numeric
results are in [PARALLEL-REGISTRATION.json](PARALLEL-REGISTRATION.json) and
[PARALLEL-RESULTS.json](PARALLEL-RESULTS.json).

The [independent audit](PARALLEL-AUDIT.json) passed. A separate Python reducer
reconstructed the 216 selected cost reference rows, all 648 measured jobs and
signatures, all 21 worker identities and 672 warmups, per-worker phase balance,
and every published timing/resource summary. It imported no producer reducer
and ran no engine or benchmark.

## Throughput and latency

| Independent processes | Aggregate nodes/s | Throughput versus one | Mean search call | Median search call | p95 search call | Mean latency versus one |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 744,252 | 1.000× | 48.05 ms | 48.14 ms | 75.33 ms | 1.000× |
| 2 | 1,130,897 | 1.520× | 55.08 ms | 50.41 ms | 106.37 ms | 1.146× |
| 4 | 1,525,671 | 2.050× | 72.14 ms | 60.53 ms | 134.57 ms | 1.501× |

Aggregate throughput divides all returned nodes by the sum of the three batch
wall times for that worker count. It includes GO dispatch, OS scheduling, IPC,
and result serialization. Individual call latency is measured by the existing
frozen host around the synchronous WASM search call. These are different
timers; aggregate throughput is not computed by summing individual durations.
Startup, compilation, parsing, and the fixed authored warmups precede both
measured intervals. [PARALLEL-CONFIG.json](PARALLEL-CONFIG.json) defines the
work, order, affinity, and timing rules.

The three single-process blocks were relatively close: 0.736–0.754 million
nodes/s. The two-process blocks ranged from 0.806 to 1.458 million nodes/s, and
four-process blocks from 1.219 to 1.747 million. Every block, including the
slower concurrent blocks, is retained in the aggregate. Three repeats on one
host do not establish a stable hardware scaling law or a confidence interval.

## Memory and CPU accounting

| Independent processes | Maximum sum of worker peak RSS | Fixed WASM linear memory total | Measured worker CPU time | Worker CPU seconds per batch wall second |
| --- | ---: | ---: | ---: | ---: |
| 1 | 75.70 MiB | 32 MiB | 10.312 s | 0.987 |
| 2 | 155.51 MiB | 64 MiB | 11.843 s | 1.722 |
| 4 | 304.01 MiB | 128 MiB | 15.545 s | 3.050 |

Peak RSS is Linux's process-lifetime high-water value, including loading and
warmup. Summing different workers' peaks gives an upper bound; the peaks need
not occur simultaneously. These worker totals exclude coordinator memory and
include the Node host, module, search state, and metadata. Fixed WASM linear
memory is reported separately. The 16,712-byte coefficient payload is only a
small part of each complete process. Worker CPU time covers the measured job
loop; dispatch and reply serialization also contribute to the separate batch
wall timer. Raw per-worker values and warmup responses are retained in the
nine block receipts inventoried by [PARALLEL-RESULTS.json](PARALLEL-RESULTS.json).

The host was an Intel Xeon Platinum 8573C with Node 24.22.3 and V8
13.6.233.17-node.63. Workers were pinned to CPUs 0, 0–1, or 0–3, and the
coordinator to CPU 8. Every process used the same optimizing-only flags as
the cost and game studies: `--no-liftoff --no-wasm-lazy-compilation`.

The environment exposed nine affinity slots but no cgroup mount, quota, or
throttling files. Its CPU-time quota therefore remains unknown. The observed
nonlinear scaling and block variability cannot be attributed specifically to
quota throttling, CPU frequency, cache contention, or another host effect from
these measurements alone.

## Scope

The experiment uses isolated processes and independent WASM instances, with
deterministic round-robin job assignment. It tests batch throughput under that
specific workload. It does not add workers to the production application,
parallelize a search tree, estimate playing strength, or predict scaling on a
mobile browser. A user waiting for one move still receives a single-search
latency, which increased in this concurrent workload.

The source and input registration was frozen before the first timed job. The
script executed verified Node/taskset/script descriptors, checked every worker's
module, model, rules, flags, and affinity, and rechecked retained executable and
snapshot bytes before completion publication. Seven contract tests and an
independent source review passed before registration; no engine ran in those
contract tests. [PARALLEL.md](PARALLEL.md) contains reproduction commands and the
complete interpretation limits.
