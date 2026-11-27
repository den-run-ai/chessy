# Evaluation and research

[Home](../README.md) · [Development](../docs/DEVELOPMENT.md) ·
[Training research](training/README.md)

This directory measures Chessy's rules correctness, analysis quality, playing
strength, and level calibration. These are separate claims: a correct result,
a better puzzle score, and a stronger match result need different evidence.

The correctness and analysis scorecards run in CI. Difficulty labels remain
provisional, and research candidates have their own admission requirements.
Start with [running the scorecards](#run-the-scorecards), then see
[calibration and matches](#calibration-and-matches) or the
[research index](#research-index).

## Run the scorecards

Run these commands from the repository root. `chess.js` is an independent
rules oracle used only by development tools and CI; it is never bundled with
the offline app.

```sh
npm install --no-save chess.js@1.4.0
node test/eval/scorecard.js --baseline eval/BASELINE.json
node test/eval/analysis-scorecard.js --baseline eval/ANALYSIS-BASELINE.json
```

The PR checks use a frozen 64-case correctness shard and a 34-case analysis
shard. The weekly/manual [Full evaluation workflow](../.github/workflows/full-eval.yml)
runs the complete baselines:

```sh
node test/eval/scorecard.js --full --baseline eval/FULL-BASELINE.json
node test/eval/analysis-scorecard.js --full --baseline eval/ANALYSIS-FULL-BASELINE.json
```

For machine-readable output or fault checks:

```sh
node test/eval/scorecard.js --json --out run.json
node test/eval/analysis-scorecard.js --self-test
```

Omitting `--baseline` reports the selected score vector. Baseline comparison
also guards coverage and configuration, so dropping cases cannot improve a
reported result. Do not commit npm manifests, lockfiles, or local outputs
created by these commands.

## Files and baselines

| Path | Contents |
| --- | --- |
| [corpus/sources/](corpus/sources/) | Frozen CC0 puzzle/opening samples and source provenance |
| [corpus/eval-v1.ndjson](corpus/eval-v1.ndjson) | Frozen position records with provenance |
| [corpus/manifest.json](corpus/manifest.json) | Counts, split policy, analysis options, generator version, and hashes |
| [BASELINE.md](BASELINE.md) / [BASELINE.json](BASELINE.json) | Correctness PR baseline |
| [ANALYSIS-BASELINE.md](ANALYSIS-BASELINE.md) / [ANALYSIS-BASELINE.json](ANALYSIS-BASELINE.json) | Analysis PR baseline and fault inventory |
| [FULL-BASELINE.json](FULL-BASELINE.json) | Full correctness baseline |
| [ANALYSIS-FULL-BASELINE.json](ANALYSIS-FULL-BASELINE.json) | Full analysis baseline |
| [LICENSE-REPORT.md](LICENSE-REPORT.md) | Source licenses, exclusions, and planned corpus additions |

The full baselines were generated from r73 commit
`07b29d39c07761bd9e1cec242ac16e0435e15f7a`, with corpus SHA-256
`34a47ea48ec5006332e791ec9a6428d63cc4d61d6b313060c1a8fd4bfaac3c27`.
They are reviewed reference values, not claims about an unmeasured candidate.

| Full-baseline measure | Reviewed value |
| --- | --- |
| Strict correctness | 310/310 checks over 117 cases |
| Complete legal roots / played-move rank | 103/103 and 40/40 |
| Puzzle top-1 / recall@3 | 27/40 and 34/40 |
| Principal-variation stability / budget stability | 53/80 and 68/103 |
| Regret, median / p90 / p99 | 0 / 17 / 440 centipawns |
| Catastrophic misses | 0 |
| Exact accepted-move fixtures | 40 |

## Corpus and provenance

`eval-v1` contains 117 cases: 80 from CC0 sources and 37 authored MIT fixtures.

| Source | Cases | Coverage |
| --- | ---: | --- |
| Lichess Open Database puzzles | 40 | Five difficulty bands: <1000, 1000–1399, 1400–1799, 1800–2199, 2200+ |
| Lichess `chess-openings` | 40 | ECO/name/line samples across all five ECO volumes |
| Chessy-authored fixtures | 37 | Special-move availability and restraint, terminal states, repetition, fifty-move boundaries, dead positions, and endgame line replay |

Lichess puzzle FENs precede the opponent's setup move. The corpus uses the
position after that move and retains `source_fen`, `setup_move`, and the
labelled key move. Opening positions are derived by replaying their source
lines through Chessy's rules engine.

Every record carries the provenance and expectation fields below; `?` marks
an optional field:

```text
id, source_url, source_id, license, retrieval_date, source_sha,
fen, source_fen?, setup_move?, move_history?, expected_moves?, phase, themes,
rating_band, branching, split_group, generator_version, seed?, assert
```

The deterministic train/validation/test split is 70/15/15. Puzzles are grouped
by source game before extraction. The 64-case correctness PR shard includes
all correctness-critical authored fixtures, then fills by round-robin across
ECO volumes and puzzle bands. Strict correctness may include test-tagged
records; routine analysis-quality feedback uses train/validation only.

The full corpus was consulted when selecting accepted-move criterion v1.
Its test-tagged records therefore serve as compatibility evidence for that
criterion, not an untouched holdout. A fresh non-overlapping lockbox is tracked
in [#112](https://github.com/den-run-ai/chessy/issues/112). Syzygy exact-WDL
fixtures and a later-month out-of-distribution sample remain planned in the
[license report](LICENSE-REPORT.md).

### Regenerate or refresh

The app is offline; development and corpus acquisition may use the network.
Only compact source samples belong in Git, not full database dumps.

```sh
# Deterministic regeneration from the committed sources; also runs in PR CI.
node test/eval/gen-corpus.js

# Intentional online refresh of the frozen source sample and provenance.
node test/eval/fetch-corpus.js
```

The fetcher downloads CC0 sources into `corpus/sources/`. The generator reads
those committed bytes offline, validates expectations, and produces identical
output for identical inputs. Both are Node development tools; the fetcher
also uses `curl`.

## Correctness scorecard

Every correctness check must pass. The runner authenticates the corpus against
its manifest, and baseline comparison rejects lost coverage, vacuous axes,
or changed analysis configuration.

| Axis | Check |
| --- | --- |
| `legalRoot` | Legal-move set against `chess.js`, plus pseudo-move derivation, unique SAN round-trip, and a nonempty set exactly when live |
| `terminalStatus` | Checkmate, stalemate, fifty-move, repetition, dead-position, and live-state expectations |
| `specialMoves` | Castling, en passant, and promotion availability and restraint |
| `expectedLegal` | Legality of every corpus-labelled move |
| `pvReplay` | Legal replay of every reported principal variation |
| `perspectiveMate` | Correct mate distance and winning side |
| `symmetry` | Best-move invariance under color/rank mirroring |
| `determinism` | Identical repeated analysis results |

[`chess.js`](https://github.com/jhlywa/chess.js) is a separate BSD-2-Clause
rules implementation. Without it, `legalRoot` falls back to self-consistency
checks. Installing the oracle strengthens validation but never changes the
generated records. Correctness does not depend on playing strength.

## Analysis scorecard

The analysis scorecard checks the output consumed by coaching. It separates
strict result contracts, directional quality measures, and an exact semantic
fixture.

| Axis | Requirement | Meaning |
| --- | --- | --- |
| `rootComplete` | Strict | The shipped result validator accepts the whole object, and `bestLines` covers every legal root |
| `playedRank` | Strict | Rank and classification match all legal roots at the shipped candidate width |
| `puzzleTop1` | Quality ratchet | The Lichess key move ranks first |
| `puzzleRecall3` | Quality ratchet | The key move ranks in the top three |
| `pvStability` | Quality ratchet | An independent search one ply shallower retains the best move |
| `budgetStability` | Quality ratchet | The best line survives ¼× budget; full mode also checks 4× |
| `regret` | Quality ratchet | Full-depth regret of the quick-scan choice: median, p90, p99, and catastrophic-miss count |
| `equivalence` | Exact fixture | Criterion identity and each puzzle's accepted-move verdict/reason match the reviewed baseline |

Strict axes require 100%. Quality may improve but cannot regress against the
matching PR or full baseline. The ratchet is exact because analysis is
deterministic; an unsolved puzzle establishes the measured level. Checked
counts and regret sample size are part of the gate and cannot shrink.

Whole-object validation uses `ChessyAnalysisResult.validate` with an
independently derived request identity. It covers provenance, completeness,
depth/stability, evaluations, resolved lines, ordering, and duplicates. E3 adds
complete legal-root coverage. The ¼×/4× results must pass the same validator;
an unusable tier counts as a quality miss. Candidate width comes from
`assets/reflection.js` at runtime.

The equivalence fixture preserves honest `unknown` and `not-equivalent`
results. A changed criterion, missing case, or changed verdict/reason requires
an explicit reviewed rebaseline; opposite changes cannot cancel in an
aggregate. The PR fixture covers 12 puzzles and the full fixture covers 40.
Comparisons use accepted-move sets, overlap, stability, and regret, rather
than requiring exact external-engine centipawn scores or lines.

`--self-test` exercises 18 cases: 13 strict engine faults, one unusable
auxiliary tier, one misleading stability self-report, and three exact-fixture
changes. See [ANALYSIS-BASELINE.md](ANALYSIS-BASELINE.md) for the inventory.
Cache, progress, cancellation, and worker recovery are tested by the runtime
service/browser suites, outside this pure-core scorecard.

## Calibration and matches

The displayed 1500–2300+ bands are provisional targets on an external engine
scale. They are not certified FIDE, Chess.com, or Lichess ratings.

| Evidence | Scope and status |
| --- | --- |
| [E4-v1 opening freeze](e4/README.md) | Pinned historical r71 baseline; exploration and certification manifests remain pending |
| [r80 level screen](level-screen-r80/README.md) | Exploratory Stockfish 18 comparison that informed the preset relabel; no certification |
| [Easy depth comparison](easy-depth-screen-2026-09-25/README.md) | 200-game development screen that retained depth-2 Easy |
| [Play/analysis recalibration](PLAY-ANALYSIS-RECALIBRATION-2026-09.md) | Budget and analysis-profile rationale |
| [v2 manifest](match-v2/PROVENANCE.md) and [execution](match-v2/EXECUTION.md) | Frozen 400-endpoint CC0 bank; exact commits, modules, budgets, both colors, and 20 complete shards; diagnostic only |
| [Fresh finite-bank contract](match-formal/CONTRACT.md) | Separate formal protocol with randomized sampling and authenticated prerequisites; no admitted campaign |
| [Admission proposal](match-v2/ADMISSION-PROPOSAL.md) | Exposure limits and dependency map for future admission |
| [Historical v1 protocols](MATCH-HISTORY.md) | Archived strength, efficiency, and equal-time contracts; do not dispatch for a new candidate |

The v2 profiles remain distinct: `evaluator-easy` uses 10,000 nodes and an
endpoint lower bound above 50%; `selective-hard` uses 230,000 nodes and a bound
above 49%. These protocol IDs predate r80 and do not name current Play levels
(230,000 nodes is Expert). Unique endpoints do not establish independent
opening families. No candidate has been measured on that manifest.

The formal [registry](match-formal/registry.json) has no campaign. Fresh-bank,
candidate, correctness, reproduction, and device prerequisites remain open in
[#175](https://github.com/den-run-ai/chessy/issues/175). The conservative
selective-search profile cannot admit an exactly behavior-preserving cost
optimization; those changes need the separately reviewed equivalence/runtime
policy described in the contract.

## Research index

These reports retain experimental results and limitations. They do not, by
themselves, change the shipped evaluator or certify strength.

| Topic | Reference |
| --- | --- |
| Expanded PeSTO evaluation | [Pilot](PESTO-PILOT-2026-09.md) |
| Natural-game follow-up | [50,000-position experiment and 80-game development screen](NATURAL-PILOT-2026-09.md) |
| Compact neural evaluation | [Original H4](neural-h4/REPORT.md), [residual repair](neural-h4-v2/REPORT.md), [phase/width](neural-h4-v3/REPORT.md), [factorial and budget screen](neural-h4-v4/REPORT.md) |
| Compiled neural cost | [Storage, module, memory, and runtime](training/nnue-phase-runtime-results-2026-09.md) |
| Incremental accumulation | [Direct evaluation and aggregate-search comparison](training/nnue-incremental-results-2026-09.md) |
| Training foundation | [HCE R3 and NNUE guide](training/README.md) |
| Engine signatures | [Versioned evidence and activation](../experiments/wasm/SIGNATURE-ROTATION.md) |
| Search-cost experiments | [WASM engine guide](../experiments/wasm/README.md) |

The evaluation tracker is [#87](https://github.com/den-run-ai/chessy/issues/87).
E1 covers corpus/provenance, E2 correctness, E3 analysis quality, E4 level and
match calibration, and E5 tuning with grouped splits and locked tests. Corpus
generation, correctness, and analysis checks run in CI; certification and
tuning admission remain separate work.
