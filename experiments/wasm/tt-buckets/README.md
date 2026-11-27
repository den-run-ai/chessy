# Bounded transposition-table prototype

This experiment implements one Chatarunga-inspired candidate outside Chessy's
production source tree. It is not a production engine change, signature
activation, strength result, or release recommendation.

## Frozen candidate and input

`source.json` pins all eight production Rust/build files and the shipped module
at `dfbb97809d4cb103310a1a5d4b09043c6d4492ef`. Preparation reads that immutable
Git object, verifies the exact source inventory and every digest, and patches
only a retained copy. The production sources, module, active signatures and
release token remain unchanged.

The candidate divides the existing 1,048,576-entry, 24-byte-entry table into
262,144 buckets of four entries. Lookup and replacement inspect at most four
slots. An existing `h1` is always overwritten as before; callers still verify
`h2` before trusting a hit. A new key fills the first unused slot or replaces
the shallowest entry, with ties resolved by the first slot. Occupancy no longer
stops search. Generation resets, mate normalization, exact-depth probe rules,
repetition/50-move exclusions, score types, fixed memory, build flags and the
rest of search remain unchanged. No parameter search or alternative candidate
is permitted within this diagnostic.

The design is informed by Chatarunga's four-way replacement table, inspected at
[`4f389446`](https://github.com/deedy/chess-chatarunga/blob/4f389446c685e011bcc2550c682e26bdb9f7a96b/src/search.rs).
This is an independent adaptation of the table policy; it does not import
Chatarunga code, atomics, threading, allocation, model weights or score layout.

## Predeclared checks and measurement

`protocol.json` is written before any timing and is included in the run's
registration digest. The runner stops before timing if correctness fails.

1. Run the existing Rust unit tests plus collision, all-four-slot/last-bucket,
   same-`h1`/different-`h2`, mate normalization, replacement, full occupancy,
   generation wrap and independent node-budget tests.
2. Build both source snapshots through the unchanged pinned build script. The
   baseline must reproduce the shipped bytes. Both use Rust 1.97.1 and
   Binaryen 131; compiler, linker and memory settings are unchanged.
3. Compare both modules with an independent shallow JavaScript legal-move
   oracle at depths 0–3. Only static leaf evaluation is supplied by a separate
   baseline module. Also compare completed full-window depth-4 scores with
   quiescence on all 12 mirrored public benchmark positions, legal exact-root
   scores/PVs on special-move positions, and exact node-budget boundaries.
4. After one 5,000-node warmup per engine/position, run exactly two 250,000-node
   searches per engine on each of the 12 positions. Alternate baseline-first
   and candidate-first order. Record every move, score, depth, counter, stop
   reason, saturation flag and elapsed time. Report paired elapsed ratios and
   their geometric mean; different nodes/moves/depths remain visible.
5. Run one 8-second uncapped search per engine on the unmirrored Ruy Lopez and
   King's Indian positions, alternating order. This probes Master-budget
   headroom; no extra runs are added if neither engine fills its table.

The full local budget is 48 bounded-node searches and four 8-second pressure
searches, plus warmups and correctness checks. There is one registered attempt:
failed, mixed or negative outcomes are retained; no selective reruns, tuning,
strength inference or holdout access. A completed run is not evidence of
performance on supported phones. Any production change still needs reviewed
candidate evidence, honest signature rotation, size/performance checks and
the applicable prospective admission protocol.

## Reproduce

Install the repository's pinned toolchain in a separate directory. Run:

```sh
node experiments/wasm/tt-buckets/probe.test.js
node experiments/wasm/tt-buckets/probe.js run /absolute/new/output-directory \
  /absolute/rust-install /absolute/binaryen-version_131
```

The output directory must not exist. It owns immutable source/implementation
snapshots, registration, build logs and generated binaries. The final report
records all source, implementation, protocol, tool and module identities.
Generated files belong in scratch, never `assets/` or the production source
tree. The final summary is published only after the complete declared run.

For CI, prepare and rebuild the two snapshots, then run only
`node experiments/wasm/tt-buckets/validate.js /absolute/built/output-directory`.
That adapter verifies the recorded implementation and both compiled module
digests, then repeats correctness checks without rerunning the timing study.
The pinned base Git commit must be locally available even on a shallow checkout.
Snapshots are retained, read-only local files, not an external attestation or
protection from another process with access to the same account.

## Recorded outcome: do not activate

The [complete report](results/run-v1/report.json),
[registration](results/run-v1/measurement-registration.json),
[build logs](results/run-v1/), and exact measured implementation are retained.
The seven implementation files remain byte-identical to their recorded hashes;
`validate.js` checks that binding, so no second executable copy is needed.
There was one completed registered measurement; no parameter was tuned and no
timing was repeated after its result. Before measurement registration, two
runner preflight defects were corrected: matching Binaryen's version suffix
and selecting the retained child's argument index. Neither preflight executed
engine correctness checks or timed searches.

| Check | Recorded result |
| --- | --- |
| Baseline/candidate native Rust tests | 7/7 and 9/9 |
| Independent shallow-score comparisons | 144/144 |
| Completed depth-4 quiescent score comparisons | 12/12 |
| Exact roots with independent scores and legal PV replay | 140/140 |
| Exact versus one-node-short budget boundaries | 4/4 |
| Fixed memory | 26,542,080 bytes for both |
| Optimized module size | 37,172 → 37,192 bytes, +20 bytes |
| Fixed-node paired elapsed ratio, baseline/candidate | 0.960575; candidate took **4.10% longer** |

All 24 paired fixed-node measurements consumed exactly 250,000 nodes and kept
the same completed depth and selected move. This candidate did not demonstrate
an efficiency gain in that workload. The 8-second searches also kept the same
move, score and completed depth: Ruy Lopez reached depth 8 with 5,935,103 versus
6,116,351 nodes; King's Indian reached depth 7 with 7,033,855 versus 6,926,335
nodes (baseline versus candidate). Neither baseline search saturated its table,
so those measurements did not demonstrate a practical saturation benefit.

The collision/full-occupancy unit tests verify that the candidate can continue
after its table fills, but that mechanism alone does not justify shipping it.
The +20-byte module also exceeds the current raw-size ratchet. Retain the
production engine. This negative diagnostic is useful evidence for a future,
separately declared candidate; it is not an Elo result or permission to relax
any release or strength gate.
