# Bounded generated-position / Stockfish pilot

Research only; this does not satisfy R3.0 or bypass PR #146's production
admission checks. No model or weight vector is emitted and no runtime changes.

Before fitting, the comparison is fixed to:

- 12,000 engine-legal continuations, seed 1370914, one-third each phase;
  family-hash 70/15/15 split, at most four rows per structural family.
- External Stockfish 18, one thread, 16 MiB hash, 25,000 nodes per position;
  clear hash/new game/readiness each time. Require exact CP, valid WDL,
  PV-head/bestmove agreement; exclude mate/missing scores.
- Freeze baseline calibration on train only. Compare existing 753 parameters,
  plus direct pawn attacks, plus king-bucket pawn PSTs, both cheap groups, and
  full 965-parameter R3. Positive L2 grid 0.02/0.05/0.1/0.2/0.5/1.0;
  box constraints preserve nonnegative mobility and monotone passer ladders.
- Select lambda by validation only. Report every surface, rounding, phase
  losses and descriptive family-bootstrap intervals. Test is exploratory,
  not a repeated-selection lockbox. Keep the shipped baseline regardless.

The generator reuses the checked-in MIT/CC0 eval corpus, including evaluation
fixtures. Continuations from the same seed can occur in different splits.
Structural family disjointness is therefore weaker than source-game or
source-seed disjointness. These data cannot establish generalization to the
production scorecards, natural games, Elo, or a future clean release holdout.
Random legal continuations also overrepresent tactically implausible positions.

Stockfish source: official `sf_18` tag; source zip SHA-256
`2deeca8664333eb98103fcb2019b898879255cba7e1a9f8940e7c09a8aad2038`.
Built using `make -j2 build ARCH=x86-64`; executable SHA-256
`ef2b67169e88bafb47f6f2311fe059c64f26e77344c5d507f05928d7fce25319`.
The labeller exports and verifies both embedded network hashes. Rebuilds on
other compilers may produce a different executable hash; explicitly record it.
Stockfish and its networks remain external GPL build-time tools, never game
assets. Raw labels and fitted weights are not published.

## Run

```sh
node tools/training/hce-synthetic-pilot-label.js \
  --stockfish /absolute/path/to/stockfish --summary /tmp/pilot-summary.json \
  --rows 12000 --seed 1370914 --nodes 25000 --hash-mb 16 \
  --expected-executable-sha256 ef2b67169e88bafb47f6f2311fe059c64f26e77344c5d507f05928d7fce25319 \
  --expected-evalfile-sha256 c288c895ea924429ea9092e3f36b2b3c1f00f2a3a4c759ff7e57e79e3b43e4a7 \
  --expected-evalfile-small-sha256 37f18f62d772f3107e1d6aaca3898c130c3c86f2ab63e6555fbbca20635a899d \
  --verify-networks true > /tmp/pilot.ndjson
python3 tools/training/analyze-hce-synthetic-pilot.py \
  --input /tmp/pilot.ndjson --label-summary /tmp/pilot-summary.json \
  --output /tmp/pilot-analysis.json \
  --stockfish-source-archive-sha256 2deeca8664333eb98103fcb2019b898879255cba7e1a9f8940e7c09a8aad2038
```

Requires NumPy 2.3.5 and SciPy 1.17.0. Run manually, not on every PR.
No Modal, GPU, credentials, or paid CI is required for this pilot.

## Result and decision

The original run implementation is immutable at remote commit
`f769f87903cd8ee026a1aa2472f6e81a58514298`. The two checked-in run files are
byte-for-byte copies of its compact outputs:

- `pilots/hce-synthetic-12k-25kn-label-summary.json`, SHA-256
  `2f8076471fb49cd57a87233b54d60a8b0e6406e4dcdfb28804d60550b2a0a57f`;
- `pilots/hce-synthetic-12k-25kn-analysis.json`, SHA-256
  `566ee8e8c5f11b9a573cf33ebd0fe0ee33c024615198391c0a28269224fce5f7`.

Raw generated positions, labels, networks and fitted vectors are not committed.
The review and stop decision are in
`pilots/hce-synthetic-12k-25kn-review.json`.

The teacher accepted 10,911 of 12,000 positions in 411 seconds. Lower
cross-entropy is better:

| Surface | Parameters | Validation | Test |
| --- | ---: | ---: | ---: |
| Frozen shipped evaluator | 0 fitted | 0.456182 | 0.440812 |
| Existing HCE retune | 753 | 0.441914 | 0.428055 |
| Retune + pawn attacks | 759 | 0.435484 | 0.422338 |
| Retune + king-bucket pawn PST | 945 | 0.441276 | 0.427398 |
| Cheap combined | 951 | 0.435003 | 0.421530 |
| Full R3 | 965 | 0.433983 | 0.420068 |

These numbers are useful mechanism evidence, but the parameter behavior is a
stop signal. Every surface chose the lowest lambda. Full R3 set shipped knight,
bishop and queen mobility to zero, drove four pawn-attack terms to their +96 cp
ceiling, changed 696 PST entries, and worsened test CP RMSE despite improving
the WDL objective. Five king-bucket columns had no train observation. All 102
source seeds occur across split boundaries, so position-family isolation does
not supply source-game independence.

Post-run review also found that the exploratory labeler had omitted the frozen
teacher's `seldepth >= depth` admission rule. Stockfish emitted 215 accepted
rows that fail that declared rule (154 train, 26 validation, 35 test). The
original JSON is retained unchanged rather than silently rewritten. The
follow-up labeler and analyzer reject those rows, and the fake-UCI regression
test pins the behavior. The expensive label/fit pass was not rerun because this
already-strength-limited experiment cannot become release evidence.

Decision: no evaluator, WASM, search, or level change. A next HCE experiment
needs quiet natural-game positions, source-family isolation, and the
authenticated 100k-node teacher path. Test a constrained 753-weight retune
first, then direct pawn attacks; admit larger interactions only by clean paired
ablation. An H4/H8 screen is deferred for the same data-quality reason.

Focused checks:

```sh
node test/training/hce-synthetic-pilot.test.js
python3 tools/training/analyze-hce-synthetic-pilot.py --self-test
```

## Independent forensic audit (2026-09-14)

The saved 10,911-row stream was recovered and its SHA-256 matched the original
summary. Re-running the original implementation's complete 30-fit grid with
NumPy 2.3.5/SciPy 1.17.0 reproduced all five selected lambdas, all five rounded
weight-vector hashes, and every train/validation/test cross-entropy exactly.
The original 4.706% relative test-loss reduction is numerically reproducible;
it remains exploratory teacher-fit evidence, with no Elo or time claim.

An independent python-chess legality check found zero invalid boards and zero
illegal teacher PV sequences. All stored feature vectors, model-cluster keys,
and position-family keys also recomputed exactly. Of these positions, 732 are
in check; the random-continuation data include tactical states that a static
evaluation fit cannot explain by quiet positional terms alone. All 102 source
seeds still cross split boundaries. Position-family bootstrap intervals do not
account for this common source dependence and cannot certify generalization.

Two distinctions correct the earlier interpretation:

- The 215 rows with `seldepth < depth` violate the frozen admission rule;
  they are not thereby corrupt Stockfish scores. Stockfish 18 resets selective
  depth at each iteration/PV and updates it on reached PV nodes, while nominal
  depth is the search iteration. Reductions and pruning can make them differ.
  See the pinned [Stockfish 18 search implementation](https://github.com/official-stockfish/Stockfish/blob/sf_18/src/search.cpp).
  The frozen rule has **not** been relaxed. Filtering these rows also changes
  the position distribution, so this is a protocol sensitivity, not a clean
  new experiment.
- Coefficients reaching bounds or suppressing mobility are observed fitted
  behavior, not proof of a broken optimizer or worse play. Correlated features,
  the WDL objective and tactical sampling can explain such behavior. Their
  persistence justifies a clean ablation before considering runtime use.

The audit did find a one-centipawn research reconstruction bug:
`runtimeRoundedScore` accumulated already-divided floating coefficients before
rounding, disagreeing with Rust on 153/10,911 rows at half-integer boundaries.
It now accumulates exact integer numerators before the final `/24`; parity is
10,911/10,911. The convex smooth objective and original fit numbers are unchanged.
The analyzer's historical `rounded` field means rounded **weights** with a smooth
taper; a separate `runtimeRounded` field now applies actual runtime score
rounding. No runtime code or WASM bytes changed.

Forensic refits after the 215 declared exclusions retain 7,517 train, 1,593
validation and 1,586 test rows. The same five surfaces and same lambda grid
give the following **post-hoc, smooth-taper** losses:

| Surface | Validation | Test |
| --- | ---: | ---: |
| Frozen shipped coefficients | 0.452572 | 0.437485 |
| Existing HCE retune | 0.437415 | 0.423358 |
| Retune + pawn attacks | 0.430836 | 0.417455 |
| Retune + king-bucket pawn PST | 0.436662 | 0.422548 |
| Cheap combined | 0.430248 | 0.416486 |
| Full R3 | 0.429270 | 0.415009 |

All surfaces still choose lambda 0.02; full R3 rounds all four mobility terms to
zero and saturates four pawn-attack terms. These are sensitivity results on the
same contaminated source corpus, with no new candidate or admission gate.
Exact reproduction, legality, rounding and sensitivity values are preserved in
`pilots/hce-synthetic-12k-25kn-forensic-audit.json`. Historical run/review JSON
remain byte-for-byte unchanged. Audit and refits used local CPU only: no Modal,
GPU or CI dispatch.

The checked-in forensic driver reproduces both analyses from the retained raw
labels. It verifies the fixed historical source/input hashes, consumes read-only
input snapshots, checks the independent legality and WASM reconstruction, and
binds its own source hash in its output. It does not change the current analyzer's
strict admission rules or execute Stockfish. With the pinned original git object
available, NumPy 2.3.5, SciPy 1.17.0 and python-chess (`chess` module 1.11.2):

```sh
python3 tools/training/audit-hce-synthetic-pilot.py \
  --input /absolute/path/to/pilot.ndjson \
  --label-summary /absolute/path/to/pilot-summary.json \
  --source-archive /absolute/path/to/stockfish-sf18.zip \
  --executable /absolute/path/to/stockfish \
  --output /absolute/path/to/new-forensic-audit.json
```
