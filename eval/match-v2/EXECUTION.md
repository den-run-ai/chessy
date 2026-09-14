# V2 diagnostic execution

This implements the execution prerequisites of #156 without authorizing an
engine change or claiming 400 statistically independent families. The frozen
CC0 manifest is unchanged. No candidate match was run while developing this
code; tests construct legal, artificial repetition games and do no holdout
search. The runner, raw replay validator and manual workflow must land on
trusted main before a candidate can be measured with the workflow.

## Predeclared profiles

| Profile | Nodes per move | Descriptive endpoint lower-bound threshold |
| --- | ---: | ---: |
| `evaluator-easy` | 10,000 | strictly >50% |
| `selective-hard` | 230,000 | strictly >49% |

Both profiles use ABI v2, depth ceiling 30, quiescence, a 180-ply cap after
the opening, all 400 manifest endpoints, both candidate colors, and exactly
20 shards of 20 endpoints/40 games. No seed, opening selection, custom budget,
partial match, equal-time or resumption option exists. Terminal adjudication
takes precedence even on the 180th ply; only nonterminal capped games draw.
Mate and maximum-depth completion may legitimately stop before the node cap.

`opening-pair-student-t-lcb95-v1` is the existing one-sided Student-t lower
bound over 400 color-pair endpoint means. It is **descriptive**, because
named/structural opening correlations and absent source-game lineage need a
reviewed family policy before formal inference. The summary always emits
`formalPass: false`. A >49% Hard endpoint bound is never a strength claim or
an evaluator gate. Even after a family policy is admitted, selective-search
admission needs correctness/tactics and a demonstrated product-budget
wall-time/depth benefit. Separate source/build reproduction, WASM size,
signature rotation, browser/device and absolute-rating gates remain required.

## Provenance and raw evidence

`test/ai-match-v2.js register` freezes literal registration bytes before any
game. It binds both exact 40-character commit SHAs, SHA-256 hashes of retained
Git module bytes, canonical source-file digests and build-file digests,
trusted harness/arbiter/loader/statistics/workflow file hashes, manifest
identity, runtime, complete schedule, budget, estimator, thresholds and one
GitHub run URL/attempt. A commit hash or module hash alone is not proof that
the module was reproduced from the declared source; that is a separate gate.

Shards receive the registration digest from the trusted registration job's
output. They load only immutable raw WASM from the specified commits through
the trusted ABI-v2 loader, never candidate JavaScript or build scripts. The
exact history from opening PGN replay and all subsequent moves is passed on
every search. Each append-only raw JSONL artifact includes:

- One header bound to the external registration digest and shard slot.
- Ordered game starts, every searched FEN/history digest, legal move and
  per-move node/depth/elapsed/stop telemetry, then replayable endings.
- Invalid output before validation fails, and a failure record when an
  exception occurs. Interrupted files remain incomplete and are preserved.
- A completion footer hashing all preceding literal bytes, written only
  after all 40 games and identity revalidation. Existing output files are
  never replaced.

The aggregator reads each file once, rejects duplicate-key/noncanonical JSON,
checks the exact directory/shard/game inventory, validates all literal byte
digests against the external registration, and independently replays every
game. It recomputes repetition, termination and scores; self-reported totals
or verdicts cannot determine a result. Missing, repeated, mixed-run, malformed,
failed and truncated records are infrastructure errors. A descriptive
statistical miss is informational; it cannot trigger selective retries.

Digest authentication assumes the trusted workflow/runner environment is
honest. It does not provide signed remote attestation against a compromised
runner, malicious local operator or repository administrator. Candidate WASM
can still fail or hang; job timeouts preserve partial artifacts and invalidate
the whole run. Timing is descriptive wall time on differing game positions,
not an equal-position speedup or a minimum-device measurement.

## Running after review

Use the manual `V2 opening-pair diagnostic` workflow on the repository's
default branch with exact base/candidate commits and one profile. It resolves
the trusted harness once, pins Node 22.23.2 and action commits, registers
before searches, runs all 20 shards with fail-fast disabled, preserves raw
artifacts on failures, and aggregates only when all required jobs succeeded.
It refuses retry attempts and prior runs for the same candidate/profile.
No workflow was dispatched to validate this implementation. These matches can
consume substantial CI time, especially Hard; do not run them routinely.
Each shard has a 45-minute ceiling (900 shard-minutes worst case, plus
registration/aggregation). Before any dispatch, benchmark a separate exposed
development corpus and project total cost; do not use the untouched manifest
for timing probes. If the fixed budget cannot finish under the preregistered
timeout, revise/review the execution protocol before measuring a candidate.

Never change the candidate, base, budget, threshold, estimator, family rule or
opening list after seeing results; never combine dispatches, stop early or
remove openings. The conservative duplicate-run guard also blocks replacing
an infrastructure-invalid run automatically; any reviewed exception needs a
separately documented protocol and must preserve the invalid evidence.

Focused validation: `node test/ai-match-v2.test.js`. Its complete 800-game
fixtures contain synthetic rules-only trajectories, not measured search
results. Mutations test schedule/color mixing, missing/duplicate shards,
run/hash corruption, repetition-history loss, illegal moves, invalid search
counters, forged outcomes, cap ordering, failures and truncated completion.
