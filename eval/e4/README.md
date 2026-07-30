# E4-v1 opening-manifest freeze

The checked-in exploration and certification files are intentionally pending.
They contain no invented openings. Two offline deterministic stages prepare a
freeze:

1. `test/eval/prepare-e4-opening-candidates.js` authenticates and compiles the
   preregistered raw PGN archive into a candidate NDJSON file and provenance
   sidecar.
2. `test/eval/freeze-e4-manifests.js` authenticates those two artifacts and
   turns them into new literal exploration and certification manifests.

Neither stage downloads data, runs games, alters r69, or enables
`--require-fix`. Both refuse to overwrite output.

## Preregistered source and candidate preparation

`eval/e4/opening-candidate-source-v1.json` fixes the direct Lichess standard
rated June 2026 archive:

- URL:
  `https://database.lichess.org/standard/lichess_db_standard_rated_2026-06.pgn.zst`
- compressed bytes: `28,241,946,492`
- SHA-256:
  `8fd81071f56511e7546cb77e38db5cf32f7e8a437fb906e26959cc064d8b1f79`
- license: `CC0-1.0`

The `.torrent` is explicitly denied because its stale metadata does not
authenticate the direct archive bytes. Download and retain the direct archive
outside the repository. The lab command requires Node.js 22 or newer (for
`node:sqlite`) and `zstd` on `PATH`, then runs as follows:

```sh
node test/eval/prepare-e4-opening-candidates.js \
  --input /data/lichess_db_standard_rated_2026-06.pgn.zst \
  --output /data/e4-opening-candidates.ndjson \
  --stockfish /opt/stockfish/stockfish-ubuntu-x86-64-avx2
```

There are no CLI overrides for source identity, checksum, filters, sampling,
teacher, or node budget. The compiler verifies the entire compressed archive
before decompression. After scanning, it authenticates a private copy of the
Stockfish executable immediately before scoring. Both identities must match
their checked-in pins. It filters to standard rated Blitz, Rapid, and
Classical games, rejects BOTs, self-play, players below 1800 Elo, malformed
games, and nonstandard starting positions, and legally replays the PGN.

Exactly one candidate ply from 12 through 20 is chosen per game by the fixed
game-ID hash rule. A fixed hash threshold and bounded lowest-digest selection
cap the scored set at 25,000 candidates. The locked incident cluster and
position family are denied before scoring. Eligible positions are scored from
White's perspective with the pinned Stockfish 18 teacher at exactly 100,000
nodes; mate, bounded, malformed, and scores outside ±200 centipawns are
excluded.

The compiler writes canonical NDJSON and
`e4-opening-candidates.ndjson.manifest.json`. The sidecar binds the raw archive,
all filters and counts, compiler/parser/engine/corpus contracts, held-out
policy, actual teacher executable and networks, 100k-node gate, and exact
output bytes. Both artifacts are created with no-replace semantics.

## Candidate contract

Input is UTF-8 NDJSON. Every line must contain exactly these fields; blank
lines are forbidden:

```json
{
  "schema": "chessy.e4.opening-candidate.v1",
  "recordId": "chessy.e4.lichess-standard-rated.2026-06:candidate:<sha256>",
  "sourceGameId": "chessy.e4.lichess-standard-rated.2026-06:game:<sha256>",
  "fen": "canonical-validated-6-field-FEN",
  "eco": "C50",
  "openingFamily": "Italian Game",
  "initialBalanceCp": 12
}
```

Record and source-game IDs are namespaced SHA-256 identities derived from the
canonical eight-character Lichess `Site` game ID; raw IDs, URLs, usernames, and
profiles are not retained. `initialBalanceCp` is the pinned teacher's exact
integer centipawn score from White's perspective.

The freezer fails on malformed records, duplicate record IDs, illegal static
FEN state or move counters, non-opaque identity, unknown fields, non-ECO codes,
or scores outside the preregistered range. It clusters:

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
    "id": "lichess-standard-rated-pgn",
    "name": "Lichess database",
    "release": "2026-06",
    "url": "https://database.lichess.org/standard/lichess_db_standard_rated_2026-06.pgn.zst",
    "license": "CC0-1.0"
  },
  "rawArchiveSha256": "8fd81071f56511e7546cb77e38db5cf32f7e8a437fb906e26959cc064d8b1f79",
  "candidateNdjsonSha256": "64-lowercase-hex-of-the-exact-NDJSON-file",
  "candidateManifestSha256": "64-lowercase-hex-of-the-exact-sidecar-file",
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
`EvalFile`, `EvalFileSmall` order. `freezeBaseCommit` must equal repository
HEAD, and every selector-contract path must be tracked and clean at that
commit.

## Freeze

```sh
node test/eval/freeze-e4-manifests.js \
  --candidates /data/e4-opening-candidates.ndjson \
  --candidate-manifest /data/e4-opening-candidates.ndjson.manifest.json \
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

- the raw PGN archive, candidate NDJSON, and candidate-sidecar SHA-256 values
  as three distinct artifacts, plus source release/URL/license;
- the selector contract SHA-256 (selector, validator, corpus grouping,
  source policy, PGN compiler, parser/engine rules, schemas, templates,
  protocol, adapter, and teacher identity);
- the freeze-base commit;
- the Stockfish executable SHA-256;
- the exact ordered `EvalFile` and `EvalFileSmall` hashes;
- canonical opening-set, assignment, and whole-manifest hashes.

Before either file is written, both manifests pass the executable validators
in `test/eval/e4-protocol.js`, including independently auditable
source-record, source-game, cluster, and position-family checks across the
manifest pair. Game results still require the separate E4 result/statistics
validator; preparing candidates or freezing openings is not a certification
result.
