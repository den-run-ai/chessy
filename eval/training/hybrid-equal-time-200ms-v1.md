# One bounded 200 ms hybrid follow-up

The preceding 200-game fixed-node experiment finished exactly 50.0% (72 wins,
56 draws, 72 losses), selecting its prospectively frozen promising/runtime branch.
This separate experiment uses the unchanged hybrid and shipped modules at 200 ms
per move: ten times the earlier 20 ms diagnostic and still below Master’s five seconds.
It is development evidence, not a strength-admission or Master-rating test.

Before games, freeze the separate protocol, implementation snapshot, original
runtime/model receipts, exact fixed-node summary and independent audit, raw WASMs,
20 selected exposed openings and 40 complete tasks. Selection hashes
`chessy.hybrid-200ms-diagnostic.v1|2026-09-15|INDEX` with SHA-256 over UTF-8 for
original exposed indices 0–99; the 20 lowest digests in digest order are selected.
Both colors are played, alternating initial color by original-index parity.
No outcomes enter selection. Warmup indices 0–3 refer to slots in that selected
list; eight 10,000-node warmup searches are excluded from game scores.

The game schedule is 40 games, 200 ms/move, nodeLimit 0, maxDepth 30, quiescence enabled,
and at most 180 searched plies. Only one game/search runs at a time. The maximum
requested game-search workload is 24 minutes, plus warmup/capture overhead; a
35-minute total watchdog and 30-second search watchdog fail closed. The protocol
forbids selective reruns, interim stopping, post-hoc extension and automatic retries.
It must start after other dedicated engine benchmarks/builds finish.

The adapter imports the unchanged fixed-node runner's generic play/search/audit
helpers and the existing parent-retained capture/acknowledgment/archive machinery.
The inherited invalid-search raw record schema is preserved with its full actual
requested budget; protocol/registration/raw-manifest/summary and independent audit
have separately named 200 ms schemas. Invalid search output is retained before hard
failure. Compression and audit start only after the timed child stops. The final
archive contains exactly 41 members (warmup plus 40 games), each matched to its original
capture receipt; mutable live files never replace the retained archive.

Both JS and independent python-chess replay verify legal history, repetitions,
termination, module identity, time 200/node 0 requests, stop reasons, and elapsed
records. A claimed time-limit with observed elapsed below 200 ms is rejected.
Overruns above 400 ms are counted and reported. Independent replay does not remeasure
the clock or certify device performance. The descriptive lower bound uses 20 paired
opening means, df 19 and the reviewed JS table value 1.729; no test verdict is inferred
from that bound. The 20-opening subset differs from previous 200-game populations,
so cross-study score changes cannot be interpreted as a causal budget effect.

```sh
node test/training/hybrid-equal-time-200ms-v1.test.js
python3 test/training/hybrid-equal-time-200ms-audit.test.py
node tools/training/hybrid-equal-time-200ms-v1.js register \
  --original-registration ORIGINAL.json --original-registration-sha256 ORIGINAL_SHA \
  --precursor-summary FIXED_NODE_SUMMARY.json --precursor-audit FIXED_NODE_AUDIT.json \
  --output NEW_ROOT/registration.json
node tools/training/hybrid-equal-time-200ms-v1.js run \
  --registration NEW_ROOT/registration.json --registration-sha256 REGISTRATION_SHA \
  --output NEW_ROOT/run
python3 tools/training/audit-hybrid-equal-time-200ms-v1.py \
  --execution-repo FROZEN_REPO --registration NEW_ROOT/registration.json \
  --registration-sha256 REGISTRATION_SHA --run-dir NEW_ROOT/run \
  --output NEW_ROOT/independent-audit.json
```

Paid compute is $0. No model fitting, new data labels, holdout access, evaluator
changes, formal strength testing or subsequent experiment is authorized by this
protocol. The existing$30 ceiling is not consumed by this CPU diagnostic.
