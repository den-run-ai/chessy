# Chessy Evaluation v1 — license-clean corpus & release-gate scorecards

Chessy's existing harness (fixed-node tactics, `ai-bench`, and the 800-game
paired match) answers one question well: *did this engine change win?* This
directory adds the **separate scorecards** the strength match cannot provide —
**correctness**, position quality, level calibration, and analysis/coaching —
each measured on a **frozen, license-clean corpus** and reported as a **score
vector, not one headline Elo number**.

Tracker: [#87](https://github.com/den-run-ai/chessy/issues/87) — *Evaluation v1
— license-clean corpus and release gates*. Shipped so far: **E1** (corpus +
provenance + frozen PR shard), the **correctness scorecard** (**E2**), and the
**analysis/coaching scorecard** (**E3**). The strength and level-calibration
baselines (**E4**) are deliberately deferred until the active engine changes in
#72 settle.

## Online eval, offline app

Only the **shipped Chessy PWA** is offline — the **eval harness and CI are
not**. So the corpus is built from *real* public-domain (CC0) chess data in two
steps:

1. **`fetch-corpus.js` (online, manual / nightly)** downloads a compact, frozen
   CC0 sample — stratified Lichess Open Database puzzles and the lichess
   `chess-openings` classification — into `corpus/sources/` with full
   provenance.
2. **`gen-corpus.js` (offline, deterministic — runs in PR CI)** derives the
   corpus from those *committed* sources plus engine-generated fixtures, with no
   network. Same committed sources → identical corpus, so CI is reproducible.

## What's here

| Path | Purpose |
| --- | --- |
| `corpus/sources/` | Frozen raw CC0 samples (`lichess-puzzles-v1.csv`, `openings-v1.tsv`) + `PROVENANCE.json` (source URLs, licenses, dump date, sha256) |
| `corpus/eval-v1.ndjson` | The frozen corpus — one JSON record per line, full provenance schema |
| `corpus/manifest.json` | Counts, split policy, shared `analyse` opts, generator version, corpus + source sha256 |
| `BASELINE.md` / `BASELINE.json` | The first published correctness baseline (human + machine) |
| `ANALYSIS-BASELINE.md` / `.json` | The first published **analysis/coaching** baseline (the E3 slice) |
| `LICENSE-REPORT.md` | Per-source license provenance and the explicit exclusion list |
| `../test/eval/fetch-corpus.js` | **Online** fetcher: commits the frozen CC0 sample under `corpus/sources/` |
| `../test/eval/gen-corpus.js` | **Offline** deterministic, self-validating generator that derives the corpus |
| `../test/eval/scorecard.js` | Correctness score-vector runner (frozen 64-case PR shard + full mode) |
| `../test/eval/analysis-scorecard.js` | **Analysis/coaching** score-vector runner (frozen 34-case train/val PR shard + full mode) |

## Run it

```sh
node test/eval/scorecard.js            # frozen 64-case PR shard (runs in CI, <1s)
node test/eval/scorecard.js --full     # the whole committed corpus
node test/eval/scorecard.js --json --out run.json          # machine-readable vector
node test/eval/scorecard.js --baseline eval/BASELINE.json   # before/after vs the baseline
node test/eval/gen-corpus.js           # regenerate the corpus offline from committed sources
node test/eval/fetch-corpus.js         # (online) refresh the frozen CC0 sample under corpus/sources/

node test/eval/analysis-scorecard.js   # E3 analysis vector — frozen 34-case train/val shard (runs in CI, ~9s)
node test/eval/analysis-scorecard.js --full   # all 103 live cases (~95s, nightly / pre-release)
node test/eval/analysis-scorecard.js --baseline eval/ANALYSIS-BASELINE.json   # strict gate + quality ratchet
node test/eval/analysis-scorecard.js --self-test    # prove the strict gate turns red
```

The three tools are **development/build-time Node tools** (they use
`node:crypto`, and the fetcher shells out to `curl`); they are never loaded by
the browser app.

## The corpus (eval-v1)

A compact, frozen set carrying the tracker's provenance schema on every record:

```
id, source_url, source_id, license, retrieval_date, source_sha,
fen, source_fen?, setup_move?, move_history?, expected_moves?, phase, themes,
rating_band, branching, split_group, generator_version, seed?, assert
```

**117 cases (80 CC0 + 37 MIT):**

- **Puzzles (40, `CC0-1.0`)** — real Lichess Open Database puzzles, stratified
  across five puzzle-difficulty bands (`<1000`, `1000–1399`, `1400–1799`,
  `1800–2199`, `2200+`). Per the Lichess convention the source FEN precedes the
  opponent's setup move, so the corpus stores the position **after** the setup
  move (`fen`), keeps the labelled key move (`expected_moves`), and records
  `source_fen` / `setup_move` for reproducibility.
- **Openings (40, `CC0-1.0`)** — real ECO/name/line rows sampled across all five
  ECO volumes from the CC0 lichess `chess-openings` project; each FEN is derived
  by replaying the line through Chessy's own engine.
- **Stateful / adversarial + endgame fixtures (37, `MIT`)** — original positions
  authored for this repository (`chessy-eval-generator`) covering en passant
  (incl. restraint: no-square and pin-illegal), castling rights (and restraint),
  promotion (and restraint), stalemate, checkmate, mate-in-1 score boundaries,
  the fifty-move boundary, threefold repetition, insufficient material / dead
  positions, and long-range endgame legality (with multi-ply PV replay).

Only a **compact frozen sample** of each CC0 database is committed — never the
multi-million-row dumps. `split_group` assigns a deterministic **70/15/15
train/val/test** split (puzzles hashed by *game id* so same-game puzzles share a
split — split-before-extract). Test-tagged records are excluded from routine PR
analysis-quality feedback (strict correctness coverage may still include
test-tagged shard records). The frozen **64-case PR shard** (`shard: true`: every
correctness-critical generated case, then a fill stratified round-robin across
ECO volumes and puzzle rating bands) runs on every PR; the full corpus is for
nightly / pre-release runs. The Syzygy exact-WDL fixtures and the rotating
later-month OOD sample are staged for later E1 work — see `LICENSE-REPORT.md`.
Historical exception: the full
`eval-v1` metrics were already consulted when selecting accepted-move criterion
v1, so its test-tagged records are now compatibility evidence for that
criterion, not an untouched holdout. A new non-overlapping one-shot lockbox is
tracked in [#112](https://github.com/den-run-ai/chessy/issues/112).

## The correctness scorecard (a score vector)

| Axis | What it checks | Gate |
| --- | --- | --- |
| `legalRoot` | Differential legal-move set — an **independent oracle** (chess.js, a separate rules implementation) when available, plus pseudo-move re-derivation + unique SAN round-trip; non-empty iff live | strict |
| `terminalStatus` | checkmate / stalemate / fifty-move / threefold / insufficient-material verdict **and** live-position (`notTerminal`) expectations | strict |
| `specialMoves` | en-passant / castling / promotion availability **and restraint** (absent where forbidden) | strict |
| `expectedLegal` | every corpus-labelled move (e.g. a puzzle's key move) is legal in its position | strict |
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

**Independent oracle.** `legalRoot` cross-checks Chessy's legal-move set against
[`chess.js`](https://github.com/jhlywa/chess.js) (BSD-2-Clause) — a *separate*
rules implementation — so a bug in Chessy's own move-gen can't pass by agreeing
with itself. It is a **dev/CI-only** tool (CI runs `npm install --no-save
chess.js`), never bundled into the offline app; when it is absent the check
degrades to the self-consistency form and the corpus regenerates identically
(the oracle only validates, it never alters records).

**Baseline gate in CI.** The PR job runs `scorecard.js --baseline
eval/BASELINE.json`, so a lost check, a vacuous axis, or a changed analysis
config fails the gate — not just a new assertion failure.

## The analysis scorecard (the E3 slice)

`analysis-scorecard.js` grades the **quality** of what the coaching panel shows,
on the same frozen corpus. Its axes use strict contracts, directional quality
ratchets, and one exact semantic fixture so those different claims cannot be
silently conflated:

| Axis | Class | What it checks |
| --- | --- | --- |
| `rootComplete` | **strict** | The whole result passes the shipped `ChessyAnalysisResult.validate` (provenance, `complete`, depth/stability, top-level and per-line evaluations, full line resolution, ordering, duplicates), **and** `bestLines` covers every legal root — a true MultiPV, not a shortlist |
| `playedRank` | **strict** | The played-move `rank` matches its true rank over all roots, and `classification` matches that rank at the **shipped** candidate width (equivalent-move recognition) |
| `puzzleTop1` | ratchet | The CC0 Lichess key move is the engine's #1 line |
| `puzzleRecall3` | ratchet | The key move is within the top 3 |
| `pvStability` | ratchet | Best move unchanged one ply shallower — **measured independently**, not read off the engine's own stability flag |
| `budgetStability` | ratchet | Best line unchanged at ¼× budget (`--full` adds the 4× tier); a tier rejected by the shipped validator scores as a miss |
| `regret` | ratchet | Median / p90 / p99 cp regret of the quick-scan pick re-scored at full depth, plus a catastrophic-miss count |
| `equivalence` | **exact fixture** | The shipped `ChessyEquivalence` verdict/reason for each frozen **PR-shard** puzzle key through the shipped-width `playedMove` path; criterion identity, per-case outcome, and coverage must match the reviewed baseline (`--full` reports all puzzle keys descriptively) |

**Strict axes gate at 100%; quality axes ratchet** — they may improve but never
regress against `ANALYSIS-BASELINE.json`. An unsolved puzzle is a measured
quality level, not a broken build; determinism (proven by the E2 axis) makes
the ratchet **exact**, with no tolerance band. Coverage is part of the score:
the fraction axes' `checked` counts and the regret sample `n` fail the ratchet
when they shrink, so an engine can never look better by measuring less. Per the
tracker, oracle comparison avoids exact centipawn/PV equality — acceptable-move
sets, set overlap, budget invariance and a regret tail distribution, never a
single Elo number.

The `equivalence` fixture is intentionally different from a directional
quality score: `unknown` and `not-equivalent` are honest measured states, not
automatic build failures. What fails is an unreviewed semantic change. The
baseline embeds the exact criterion identity and per-case
`id → verdict/reason`, so opposite shifts cannot cancel in an aggregate count;
identity drift, a missing case, or any changed outcome requires a conscious
same-change re-baseline. This exact gate covers the 12 puzzle cases in the
committed shard baseline. The 40-case `--full` output has no committed
full-mode baseline and is therefore descriptive.

The strict axes delegate whole-object validation to the shipped
`ChessyAnalysisResult.validate` (against an independently derived identity), so
the gate can never be laxer than the coaching path consuming the same output;
E3 adds only the full-MultiPV coverage requirement on top — and the auxiliary
¼×/4× tiers must pass the same validator before they are graded. The shipped
candidate width is derived from `assets/reflection.js` at run time, never
duplicated. The PR shard grades **train/validation records only** — the
test-tagged records are reserved for `--full`. They remain outside routine PR
feedback, but are not represented as untouched validation for criterion v1
because its full-corpus metrics were already consulted; see #112 for the fresh
lockbox protocol.
`--self-test` simulates eighteen gate failures: thirteen engine faults must
turn the strict gate red, an unusable auxiliary tier must be fully visible to
the ratchet, a flattering self-report must leave `pvStability` unmoved
(immunity), and verdict drift, missing fixture coverage, and criterion-identity
drift must each turn the exact baseline gate red — see
[`ANALYSIS-BASELINE.md`](./ANALYSIS-BASELINE.md) for the fault list and the
published numbers.

## Roadmap (per the tracker)

- **E1** — corpus & provenance, frozen 64-case PR shard *(this slice: online
  fetcher + offline generator, real CC0 Lichess puzzles + openings committed;
  the Syzygy exact-WDL and rotating OOD tranches are staged next)*.
- **E2** — correctness runner *(this slice: differential legality, PV replay,
  stateful cases, deterministic search signature)*.
- **E3** — analysis scorecard *(this slice: acceptable-move sets, top-3 recall,
  regret quantiles, stability at ¼×/1×/4× node budget, complete-MultiPV and
  played-move-rank contracts, and exact accepted-move criterion fixtures — see
  [`ANALYSIS-BASELINE.md`](./ANALYSIS-BASELINE.md).
  Still open: the **cache / progress / cancel** runtime tests, which live in the
  analysis **service worker** rather than the pure core graded here)*.
- **E4** — level & match calibration: the 400-opening manifest, adjacent-level
  ladder, paired opening-cluster statistics.
- **E5** — tuning protocol: grouped splits, locked-test workflow, corrected
  K-fit, fresh post-selection paired match.
