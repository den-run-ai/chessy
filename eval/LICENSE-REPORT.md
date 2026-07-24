# eval-v1 license & provenance report

The evaluation corpus is **license-clean**: every committed record carries an
explicit `license`, `source_url`, `source_id`, `retrieval_date`, and
`source_sha`, and only sources with clear redistribution terms are vendored.
Chessy itself is MIT, and this corpus must not compromise that.

## Online eval, offline app

Only the shipped Chessy PWA is offline. The eval harness and CI are online, so
the corpus is built from **real** CC0 data: `test/eval/fetch-corpus.js` (online)
commits a compact frozen sample under `corpus/sources/`, and
`test/eval/gen-corpus.js` (offline, deterministic) derives the corpus from those
committed files — so CI needs no network. `corpus/sources/PROVENANCE.json`
records the source URL, license, dump date, and a sha256 of each committed
sample; the generator re-checks those shas before building.

## Committed in eval-v1

| Content | License | Basis for redistribution |
| --- | --- | --- |
| Lichess Open Database puzzles (40) | `CC0-1.0` | [database.lichess.org](https://database.lichess.org/) is released **CC0**. A compact, stratified sample (8 per difficulty band) is committed as `corpus/sources/lichess-puzzles-v1.csv` — never the multi-million-row dump. The puzzle FEN precedes the opponent's setup move, so the corpus stores the post-setup position and keeps the labelled key move; `source_id` is the Lichess `PuzzleId`. |
| Opening positions (40) | `CC0-1.0` | Real ECO/name/line rows sampled across all five ECO volumes from the CC0 lichess [`chess-openings`](https://github.com/lichess-org/chess-openings) project (`corpus/sources/openings-v1.tsv`); each FEN is derived by replaying the line through Chessy's own MIT engine. |
| Stateful / adversarial + endgame fixtures (34) | `MIT` | Original positions authored for this repository (`source_id: chessy-eval-generator`) and validated against the engine. Covered by this repository's own MIT license. |

Every committed expectation is checked against the Chessy engine at generation
time (`test/eval/gen-corpus.js`), and the scorecard verifies the ndjson sha256
against `manifest.json` before every run.

## Staged for later E1 work

Named in the tracker; each will carry the same provenance schema and its
source's license tag when added:

| Source | License | Planned use | Caveat honored |
| --- | --- | --- | --- |
| [Lichess Open Database](https://database.lichess.org/) — evaluated positions | `CC0` | Evaluated middlegame positions (the puzzle tranche already ships) | Eval FENs omit move counters/history, so they cannot test repetition or fifty-move behaviour |
| Stockfish opening books | `CC0` | Diverse opening seeds, closed/endgame positions | Freeze a small manifest; do not vendor multi-million-position books |
| Fathom + Syzygy | `MIT` probing code | Build-time generation of exact WDL/DTZ endgame fixtures | Tablebases stay build-time tooling; only compact derived fixtures are committed |
| Stockfish binary | `GPL` | Optional pinned local oracle (version/checksum/threads/hash/node-limit/MultiPV pinned) | GPL — used as an external binary only; **never vendored or linked** into the MIT app |

**Now in use (dev/CI only):**

| Tool | License | Use | Caveat honored |
| --- | --- | --- | --- |
| [`chess.js`](https://github.com/jhlywa/chess.js) `@1.4.0` | `BSD-2-Clause` | Independent legal-move oracle for the `legalRoot` axis (a separate rules implementation). CI runs `npm install --no-save chess.js`. | Dev/CI only, `--no-save`, not committed; **never** a runtime dependency of the app, and the corpus regenerates identically without it (validation-only). |

`wdl` is kept `null` until Chessy has its own calibrated WDL model — Stockfish's
WDL describes its self-play model, not human win probability.

## Explicitly excluded (no clear redistribution terms / wrong license)

Kept out of committed fixtures entirely:

- PGN Mentor, TWIC, CCRL, Caissabase, KingBase / MillionBase, and assorted
  historical tactics collections — no explicit redistribution terms.
- Lichess **broadcast** exports — `CC BY-SA`, not `CC0`; excluded from the
  default corpus.
