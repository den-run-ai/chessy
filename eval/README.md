# Chessy Evaluation v1 — license-clean corpus & release-gate scorecards

Chessy's existing harness (fixed-node tactics, `ai-bench`, and the 800-game
paired match) answers one question well: *did this engine change win?* This
directory adds the **separate scorecards** the strength match cannot provide —
**correctness**, position quality, level calibration, and analysis/coaching —
each measured on a **frozen, license-clean corpus** and reported as a **score
vector, not one headline Elo number**.

Tracker: [#87](https://github.com/den-run-ai/chessy/issues/87) — *Evaluation v1
— license-clean corpus and release gates*. This first slice ships **E1 (corpus + provenance + frozen PR
shard)** and a working **correctness scorecard** (the E2 slice). The
strength/position-quality baselines are deliberately deferred until the active
engine changes in #72 settle.

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
| `LICENSE-REPORT.md` | Per-source license provenance and the explicit exclusion list |
| `../test/eval/fetch-corpus.js` | **Online** fetcher: commits the frozen CC0 sample under `corpus/sources/` |
| `../test/eval/gen-corpus.js` | **Offline** deterministic, self-validating generator that derives the corpus |
| `../test/eval/scorecard.js` | Correctness score-vector runner (frozen 64-case PR shard + full mode) |

## Run it

```sh
node test/eval/scorecard.js            # frozen 64-case PR shard (runs in CI, <1s)
node test/eval/scorecard.js --full     # the whole committed corpus
node test/eval/scorecard.js --json --out run.json          # machine-readable vector
node test/eval/scorecard.js --baseline eval/BASELINE.json   # before/after vs the baseline
node test/eval/gen-corpus.js           # regenerate the corpus offline from committed sources
node test/eval/fetch-corpus.js         # (online) refresh the frozen CC0 sample under corpus/sources/
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
split — split-before-extract). **Never tune on the test split.** The frozen
**64-case PR shard** (`shard: true`: every correctness-critical generated case,
then a fill stratified round-robin across ECO volumes and puzzle rating bands)
runs on every PR; the full corpus is for nightly / pre-release runs. The
Syzygy exact-WDL fixtures and the rotating later-month OOD sample are staged for
later E1 work — see `LICENSE-REPORT.md`.

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

## Roadmap (per the tracker)

- **E1** — corpus & provenance, frozen 64-case PR shard *(this slice: online
  fetcher + offline generator, real CC0 Lichess puzzles + openings committed;
  the Syzygy exact-WDL and rotating OOD tranches are staged next)*.
- **E2** — correctness runner *(this slice: differential legality, PV replay,
  stateful cases, deterministic search signature)*.
- **E3** — analysis scorecard: acceptable-move sets, top-3 recall, regret,
  stability at ¼×/1×/4× node budget, cache/progress/cancel behaviour.
- **E4** — level & match calibration: the 400-opening manifest, adjacent-level
  ladder, paired opening-cluster statistics.
- **E5** — tuning protocol: grouped splits, locked-test workflow, corrected
  K-fit, fresh post-selection paired match.
