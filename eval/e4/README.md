# E4-v1 opening-manifest freeze

The checked-in exploration and certification files are intentionally pending.
They contain no invented openings. `test/eval/freeze-e4-manifests.js` is the
offline, deterministic compiler that turns an externally prepared CC0
candidate snapshot into two new literal frozen manifests.

The compiler does not download data, run games, run Stockfish, alter r69, or
enable `--require-fix`. It refuses to overwrite either output.

## Candidate contract

Input is UTF-8 NDJSON. Every nonblank line must contain exactly these fields:

```json
{
  "schema": "chessy.e4.opening-candidate.v1",
  "recordId": "stable-source-record-id",
  "sourceGameId": "stable-source-game-id",
  "fen": "4-or-6-field FEN",
  "eco": "C50",
  "openingFamily": "Italian Game",
  "initialBalanceCp": 12
}
```

The snapshot must be derived from a source explicitly released under
`CC0-1.0`. Record and source-game IDs must be stable within that pinned
snapshot. FEN-only evaluated-position exports do not contain source-game
lineage, so they cannot by themselves satisfy the same-source-game clustering
requirement. Build this opening candidate file from a CC0 PGN source (or
another CC0 source that preserves stable game IDs); do not synthesize lineage
from FEN order.

The freezer fails on malformed records, duplicate record IDs, illegal static
FEN state, unknown fields, non-ECO codes, or non-integral initial scores. It
clusters:

- mirrored/model-equivalent boards;
- exact transpositions, through the same board-equivalence key;
- every record sharing a `sourceGameId`, transitively.

One deterministic representative describes each component. The locked
`11...Bd4` incident board cluster, all mirrors, and its broader structural
position family are removed before selection.

## Freeze request

Counts and anchor allocations are declared before selection. The request is
strict: no unrecognized fields are accepted.

```json
{
  "schema": "chessy.e4.freeze-request.v1",
  "freezeBaseCommit": "40-lowercase-hex-commit",
  "source": {
    "name": "Lichess database",
    "release": "2026-07",
    "url": "https://database.lichess.org/",
    "license": "CC0-1.0"
  },
  "sourceArchiveSha256": "64-lowercase-hex-of-the-exact-NDJSON-file",
  "stockfish": {
    "executableSha256": "pinned-SF18-executable-sha256",
    "networkSha256s": [
      "EvalFile-sha256",
      "EvalFileSmall-sha256"
    ]
  },
  "exploration": [
    {
      "level": "easy",
      "anchorAllocation": [
        { "elo": 1500, "openingClusters": 20 }
      ]
    },
    {
      "level": "medium",
      "anchorAllocation": [
        { "elo": 1700, "openingClusters": 20 }
      ]
    },
    {
      "level": "hard",
      "anchorAllocation": [
        { "elo": 1900, "openingClusters": 20 }
      ]
    },
    {
      "level": "expert",
      "anchorAllocation": [
        { "elo": 2100, "openingClusters": 20 }
      ]
    },
    {
      "level": "master",
      "anchorAllocation": [
        { "elo": 2300, "openingClusters": 20 }
      ]
    }
  ]
}
```

All five exploration levels require a positive, predeclared allocation.
Allocations may use only that level's three nearest frozen anchors. The two
network hashes must exactly match the checked-in teacher manifest in
`EvalFile`, `EvalFileSmall` order.

## Freeze

```sh
sha256sum /data/e4-opening-candidates.ndjson

node test/eval/freeze-e4-manifests.js \
  --candidates /data/e4-opening-candidates.ndjson \
  --request /data/e4-freeze-request.json \
  --exploration-out /data/e4-exploration-frozen.json \
  --certification-out /data/e4-certification-frozen.json
```

Certification is selected first and never depends on exploration counts. Its
assignment order is Master first, followed by Easy, Medium, Hard, Expert, and
the four adjacent-level schedules. It always emits exactly 4,000 paired-color
assignments (8,000 games), including the 800 Master clusters/1,600 Master
games.

Selection is a deterministic balanced round-robin over
`ECO × openingFamily × initialBalanceBucket`; the five balance buckets are
`<-100`, `-100..-31`, `-30..30`, `31..100`, and `>100` centipawns. Hash-sorted
strata and records make selection independent of input line order. Components,
source games, and structural position families cannot be reused, including
between certification and exploration.

Each output binds:

- the exact candidate-file SHA-256 and source release/URL/license;
- the selector contract SHA-256 (selector, validator, corpus grouping,
  schemas, templates, protocol, adapter, and teacher identity);
- the freeze-base commit;
- the Stockfish executable SHA-256;
- the exact ordered `EvalFile` and `EvalFileSmall` hashes;
- canonical opening-set, assignment, and whole-manifest hashes.

Before either file is written, both manifests pass the executable validators
in `test/eval/e4-protocol.js`, including cross-manifest overlap checks. Game
results still require the separate E4 result/statistics validator; freezing
openings is not a certification result.
