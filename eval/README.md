# Chessy Evaluation v1 — license-clean corpus & release-gate scorecards

Chessy's existing harness (fixed-node tactics, `ai-bench`, and the 800-game
paired match) answers one question well: *did this engine change win?* This
directory adds the **separate scorecards** the strength match cannot provide —
**correctness**, position quality, level calibration, and analysis/coaching —
each measured on a **frozen, license-clean corpus** and reported as a **score
vector, not one headline Elo number**.

Tracker: *Evaluation v1 — license-clean corpus and release gates* (see the
tracking issue). This first slice ships **E1 (corpus + provenance + frozen PR
shard)** and a working **correctness scorecard** (the E2 slice). The
strength/position-quality baselines are deliberately deferred until the active
engine changes in #72 settle.

## What's here

| Path | Purpose |
| --- | --- |
| `corpus/eval-v1.ndjson` | The frozen corpus — one JSON record per line, full provenance schema |
| `corpus/manifest.json` | Counts, split policy, shared `analyse` opts, generator version, corpus sha256 |
| `BASELINE.md` / `BASELINE.json` | The first published correctness baseline (human + machine) |
| `LICENSE-REPORT.md` | Per-source license provenance and the explicit exclusion list |
| `../test/eval/gen-corpus.js` | Deterministic, self-validating generator that (re)builds the corpus |
| `../test/eval/scorecard.js` | Correctness score-vector runner (frozen 64-case PR shard + full mode) |

## Run it

```sh
node test/eval/scorecard.js            # frozen 64-case PR shard (runs in CI, <1s)
node test/eval/scorecard.js --full     # the whole committed corpus
node test/eval/scorecard.js --json --out run.json          # machine-readable vector
node test/eval/scorecard.js --baseline eval/BASELINE.json   # before/after vs the baseline
node test/eval/gen-corpus.js           # regenerate + re-validate the corpus
```

The generator and the scorecard are **development/build-time Node tools** (they
use `node:crypto`); they are never loaded by the browser app.

## The corpus (eval-v1)

A compact, frozen set carrying the tracker's provenance schema on every record:

```
id, source_url, source_id, license, retrieval_date, source_sha,
fen, move_history?, phase, themes, rating_band, branching, split_group,
generator_version, seed?, assert
```

- **Openings** — standard published opening theory (names/ECO from the CC0
  lichess `chess-openings` project); each FEN is derived by replaying the line
  through Chessy's own engine. License `CC0-1.0`.
- **Stateful / adversarial + endgame fixtures** — original positions authored
  for this repository (`chessy-eval-generator`) covering en passant, castling
  rights (and restraint), promotion, stalemate, checkmate, mate-in-1 score
  boundaries, the fifty-move boundary, threefold repetition, insufficient
  material / dead positions, and long-range endgame legality. License `MIT`.

**No third-party game or puzzle databases are vendored.** The Lichess puzzle /
evaluation corpus, Syzygy endgame fixtures, and later-month OOD sample described
in the tracker require network downloads and build-time tooling and are staged
for later E1 work; see `LICENSE-REPORT.md` for the license rationale and the
explicit exclusion list.

`split_group` assigns a deterministic **70/15/15 train/val/test** split by
hashing the record id. **Never tune on the test split.** The frozen **64-case
PR shard** (`shard: true`) runs on every PR; the full corpus is for nightly /
pre-release runs.

## The correctness scorecard (a score vector)

| Axis | What it checks | Gate |
| --- | --- | --- |
| `legalRoot` | Differential legal-move set (pseudo-move re-derivation + unique SAN round-trip); non-empty iff live | strict |
| `terminalStatus` | checkmate / stalemate / fifty-move / threefold / insufficient-material verdict | strict |
| `specialMoves` | en-passant / castling / promotion availability **and restraint** (absent where forbidden) | strict |
| `pvReplay` | every reported MultiPV line replays legally, move by move | strict |
| `perspectiveMate` | `analyse()` mate distance **and** winning side match | strict |
| `symmetry` | best move is invariant under colour/rank mirroring | strict |
| `determinism` | `analyse()` is bit-identical across repeated runs | strict |

**Correctness is strict: any failed check exits non-zero (100%, no tolerated
regression).** This axis is *version-independent* — a correct engine scores 100%
regardless of its playing strength — so it is safe to gate now, before the
strength baselines. The generator validates every committed expectation against
the engine at build time, and the scorecard verifies the corpus sha256 against
the manifest before running, so a corrupted fixture fails loudly rather than
passing silently.

## Roadmap (per the tracker)

- **E1** — corpus & provenance, frozen 64-case PR shard *(this slice; the
  network-sourced Lichess/Syzygy/OOD tranches are staged next)*.
- **E2** — correctness runner *(this slice: differential legality, PV replay,
  stateful cases, deterministic search signature)*.
- **E3** — analysis scorecard: acceptable-move sets, top-3 recall, regret,
  stability at ¼×/1×/4× node budget, cache/progress/cancel behaviour.
- **E4** — level & match calibration: the 400-opening manifest, adjacent-level
  ladder, paired opening-cluster statistics.
- **E5** — tuning protocol: grouped splits, locked-test workflow, corrected
  K-fit, fresh post-selection paired match.
