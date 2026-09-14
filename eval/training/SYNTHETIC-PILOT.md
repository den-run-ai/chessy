# Bounded synthetic-position / Stockfish pilot

Research only; this does not satisfy R3.0 or bypass PR #146's production
admission checks. No model or weight vector is emitted and no runtime changes.

Before fitting, the comparison is fixed to:

- 12,000 generated legal continuations, seed 1370914, one-third each phase;
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
