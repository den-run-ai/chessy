# eval-v1 license & provenance report

The evaluation corpus is **license-clean**: every committed record carries an
explicit `license`, `source_url`, `source_id`, `retrieval_date`, and
`source_sha`, and only sources with clear redistribution terms are vendored.
Chessy itself is MIT, and this corpus must not compromise that.

## Committed in eval-v1

| Content | License | Basis for redistribution |
| --- | --- | --- |
| Opening positions (32) | `CC0-1.0` | Standard published opening theory (uncopyrightable chess facts). Opening names/ECO classification come from the CC0 lichess [`chess-openings`](https://github.com/lichess-org/chess-openings) project. Each FEN is **derived** here by replaying the move line through Chessy's own MIT engine — no third-party file is copied. |
| Stateful / adversarial + endgame fixtures (34) | `MIT` | Original positions authored for this repository (`source_id: chessy-eval-generator`) and validated against the engine. Covered by this repository's own MIT license. |

Every committed expectation is checked against the Chessy engine at generation
time (`test/eval/gen-corpus.js`), and the scorecard verifies the ndjson sha256
against `manifest.json` before every run.

## Staged for later E1 work (network + build-time tooling required)

These are named in the tracker but require downloads this offline, license-clean
first slice deliberately does not perform. When added, each record will carry
the same provenance schema and the source's own license tag:

| Source | License | Planned use | Caveat honored |
| --- | --- | --- | --- |
| [Lichess Open Database](https://database.lichess.org/) | `CC0` | Rated puzzles (stratified by rating band/theme/phase), evaluated middlegame positions | Puzzle FEN precedes the setup move; eval FENs omit move counters/history, so they cannot test repetition or fifty-move behaviour |
| Lichess `chess-openings` | `CC0` | ECO/name tags, reproducible opening sampling | Classification data, not strength labels |
| Stockfish opening books | `CC0` | Diverse opening seeds, closed/endgame positions | Freeze a small manifest; do not vendor multi-million-position books |
| Fathom + Syzygy | `MIT` probing code | Build-time generation of exact WDL/DTZ endgame fixtures | Tablebases stay build-time tooling; only compact derived fixtures are committed |
| `chess.js` | `BSD-2-Clause` | Development-only differential oracle | Dev-only; **never** a runtime dependency |
| Stockfish binary | `GPL` | Optional pinned local oracle (version/checksum/threads/hash/node-limit/MultiPV pinned) | GPL — used as an external binary only; **never vendored or linked** into the MIT app |

`wdl` is kept `null` until Chessy has its own calibrated WDL model — Stockfish's
WDL describes its self-play model, not human win probability.

## Explicitly excluded (no clear redistribution terms / wrong license)

Kept out of committed fixtures entirely:

- PGN Mentor, TWIC, CCRL, Caissabase, KingBase / MillionBase, and assorted
  historical tactics collections — no explicit redistribution terms.
- Lichess **broadcast** exports — `CC BY-SA`, not `CC0`; excluded from the
  default corpus.
