# Pawn-rank masks: isolated evaluator cost prototype

This experiment replaces repeated enemy-pawn scans in the existing passed-pawn
feature with per-file rank masks. It changes no production source, deployed
module, search signature fixture, evaluation weight, service worker, or release.
The generated fast module is **37,272 bytes**, **100 bytes above** the current
37,172-byte raw-size ceiling. That is an unresolved release blocker regardless
of the development timing result.

The experiment follows the small, verified optimization loop in the
[Chatarunga review](../CHATARUNGA-REVIEW.md) and the remaining cost work in
[#84](https://github.com/den-run-ai/chessy/issues/84). It is independent of the
quiet-check prefilter in [#183](https://github.com/den-run-ai/chessy/pull/183),
incremental hashing in [#184](https://github.com/den-run-ai/chessy/pull/184), and
the negative bucketed-TT diagnostic in
[#192](https://github.com/den-run-ai/chessy/pull/192). It does not combine those
candidates or use their results as evidence for this one.

## Local invariant

The original evaluator gathers pawn squares, then scans every opposing pawn for
each own pawn. A pawn is passed exactly when there is no opposing pawn ahead of
it on its file or either adjacent file. The candidate adds sixteen bytes of
local rank masks while gathering the same pawn squares: one eight-bit mask for
each color and file. A union of up to three masks describes exactly the relevant
opposing pawn rows. Masking rows below the pawn for White, or shifting away
rows through the pawn for Black, tests the same predicate.

The masks are rebuilt inside each evaluation. No make/unmake cache, persistent
state, move ordering, feature order, weight, floating-point operation, rounding,
search counter, draw handling, or mate normalization changes. The use of a
32-bit intermediate makes the edge rows safe, including a Black pawn on row 7
where the shift count is eight. This is a local equivalence argument; finite
tests are not a proof of universal search equivalence or chess strength.

`candidate.js` patches only the exact evaluator hash declared in `source.json`.
`tests.rs` embeds the retained original evaluator under `cfg(test)` for direct
comparison. The pinned native build passes all 11 tests, including:

- 3,782 exhaustive single-pawn-pair arrangements, including edge rows.
- 5,060 sampled positions from 64 seeded legal walks.
- 1,024 dense synthetic pawn boards for repeated and adjacent file occupancy.
- 87 legal special-move edges, checking evaluation after make and unmake and
  exact board restoration (castling, legal/pinned en passant, and promotion).

The compiled baseline reproduces the shipped module exactly. Baseline and
candidate each pass all 144 immutable r69 search signatures. All fields of each
returned result and a separately bounded exact-root/PV probe also agree between
the two engines for all 144 cases. Of those exact-root probes, 142 complete and
two reach their declared 5,000-node limit; the incomplete results and PV state
also match. Each module passes the retained independent
JavaScript full-window oracle's 174 score, legal-PV, budget, terminal-state,
special-move, and repetition checks.

## Predeclared development protocol

`protocol.json` fixes one candidate and all exposed development positions
before measurement. No holdout data, self-play training, formal match, or paid
compute is involved. The timing scope is one local Node/WASM process, not a
browser, device, strength, or release-admission result.

- Eighteen positions: all nine exposed benchmark families and their color
  mirrors, with fixed opening/middlegame/endgame labels.
- Fixed budgets of 10,000, 36,000, and 230,000 nodes, quiescence enabled,
  maximum depth 111, no clock limit.
- Two warmup rounds at 10,000 nodes for every position and engine.
- Four paired repetitions at every position and budget: 216 pairs / 432 timed
  observations. Candidate/reference order reverses within every position and
  budget, with two observations in each order.
- Every pair must preserve the complete returned signature, including node
  and quiescence counts, cutoffs, re-searches, depth, score, move, and stop reason.
  Early stops remain in the report; the report distinguishes actual node
  counts from declared limits.
- Each paired ratio is baseline elapsed time divided by candidate elapsed
  time. The position ratio is the median of its four pairs. Each budget summary
  is the geometric mean of the eighteen position ratios. Phase summaries are
  medians of the position ratios within the named phase.
- A conditional Master diagnostic runs only if the 230,000-node summary is at
  least 1.02 and every phase median is at least 1.00. These are descriptive
  routing thresholds, not statistical acceptance criteria. If reached, only
  the preselected Ruy Lopez and Lucena positions receive two balanced paired
  eight-second searches each (64 seconds total). Every result remains recorded;
  no tuning or additional timing follows the observation.

Raw and Brotli quality-11 module sizes are recorded with Node/Brotli/zlib
versions. Neither a favorable compressed-size result nor faster elapsed time
waives the raw-size ceiling. The device evidence and cost-admission work tracked
in #84/#175 remains separate.

## Reproduce

Use a fresh absolute output path outside the checkout. The two tool arguments
are local installations of the already pinned Rust 1.97.1 toolchain and
Binaryen 131. No download or system install is performed by these scripts.

```sh
node experiments/wasm/pawn-ranks/probe.test.js
node experiments/wasm/pawn-ranks/prepare.js /absolute/new-pawn-ranks-run
node experiments/wasm/pawn-ranks/build.js /absolute/new-pawn-ranks-run /absolute/rust-install /absolute/binaryen-install
node experiments/wasm/pawn-ranks/validate.js /absolute/new-pawn-ranks-run
node experiments/wasm/pawn-ranks/check-evidence.js /absolute/new-pawn-ranks-run
```

These commands are the correctness-only CI path; they do not rerun timing.
`check-evidence.js` additionally compares the freshly built candidate's hash
and full correctness observations against the published measurement, checks
the nine measured implementation identities, and recomputes the recorded
descriptive summary. It is a post-run verifier, outside the measured snapshot.
The
bounded local diagnostic is a separate, explicit command:

```sh
node experiments/wasm/pawn-ranks/measure.js /absolute/new-pawn-ranks-run
```

`prepare.js` reads the pinned Git commit, checks the complete four-file Rust
inventory and all eight source/build hashes, and copies only those retained
bytes. Generated files remain outside the repository. Builds use fresh target
and Cargo directories, reject ambient parent Cargo configurations, sanitize
compiler flags/wrappers, and execute the unchanged build script. The baseline
must reproduce the committed binary before validation or measurement.

The measurement command copies its nine implementation/data files into a
read-only snapshot and executes that snapshot. Before correctness and timing it
writes an exclusive registration containing protocol, implementation hashes,
source identities, module hashes, tool identities, and host versions. It tests
and measures the same retained module buffers, checks identities again after
the run, and preserves raw observations and failures. Output paths are
exclusive: an existing run cannot be silently overwritten. This is local
reproducibility and drift detection, not an externally attested security
boundary against another process running as the same account.

## Recorded outcome

The single predeclared diagnostic completed successfully; all raw observations,
source/module identities, tool versions, correctness results, and build logs
are retained under [`results/run-v1/`](results/run-v1/). All **216 timed pairs**
preserved identical complete search results, and every search consumed its
declared node budget. The size and performance results are mixed:

| Fixed node budget | Geometric mean elapsed ratio (baseline/candidate) | Candidate elapsed reduction derived from that ratio |
| --- | ---: | ---: |
| 10,000 | 1.004321 | 0.43% |
| 36,000 | 1.039490 | 3.80% |
| 230,000 | 1.012753 | 1.26% |

At 230,000 nodes the opening phase median ratio is **1.040429**, middlegame
**1.028969**, and endgame **0.984906**. The endgame result corresponds to about
**1.53% longer elapsed time**. The 230,000-node geometric mean fell below the
predeclared 1.02 routing threshold and the endgame median fell below 1.00, so the
conditional Master diagnostic was **skipped as specified**. No alternative
candidate, protocol, or run was selected after observing these results.

The fast module grew from **37,172 to 37,272 raw bytes (+100)**. Diagnostic
Brotli quality-11 size grew from **17,690 to 17,739 bytes (+49)** under **Node
24.22.3 / Brotli 1.2.1 / zlib 1.3.2.1-motley-285e94b**. The existing raw-size
ceiling fails. This Node 24 compressed-size observation does not replace the
authoritative Node 22.23.2 / Brotli 1.1.0 production size gate.

The measured candidate SHA-256 is
`277e408a9da0f71616cfefbc6edfa5cb80f419b70e729145543eecb5db6f53f4`.
The baseline SHA-256 is
`57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f`.
This is a small, mixed local cost result with unresolved size and device gates;
it provides no Elo estimate or release-admission claim. **No production
activation is proposed.**
