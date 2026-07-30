# Training data policy

Chessy's source code is MIT-licensed. Training data keeps its own upstream
license: inclusion in an MIT repository does not relicense a dataset as MIT.
Raw datasets, transformed shards, and teacher binaries are not committed to
this repository. The committed `source-manifest.json` is the allowlist and
license record; sources not listed as `primary` or `optional-fetch-only` are
denied by default.

This is a provenance and release policy, not legal advice.

## Required final-label path

Final HCE and NNUE fits must use labels generated specifically for Chessy by a
pinned, external Stockfish executable. Labels already present in a source are
useful for exploration and sampling, but are not certification labels because
Stockfish versions, networks, depths, node counts, and settings can vary.

Every label run must freeze and record:

- Stockfish release/commit, executable SHA-256, and NNUE filename/hash;
- UCI options, threads, hash size, tablebase configuration, and deterministic
  node/depth budget;
- label perspective and the exact centipawn, mate, or WDL conversion;
- input-source snapshot, filters, seed, split/grouping rules, and output
  checksums.

Stockfish is a GPL-licensed external build-time tool, not an MIT dependency.
Do not vendor its executable or `nnue-pytorch` into Chessy merely to run the
pipeline. If Stockfish is redistributed, its GPL obligations apply separately.

The locked `11...Bd4` incident position, its color/rank mirrors, nearby-budget
probes, and positions from the same source-game lineage remain denied from
training and exploration. They are post-fit evidence only.

## Primary CC0 sources

These are the default sources. CC0 permits commercial use, modification, and
redistribution without asking permission. Chessy nevertheless retains source,
snapshot, and checksum records. Usernames, profile URLs, and other identifiers
must be discarded when only board state and labels are needed.

### Lichess evaluated positions

- Source: <https://database.lichess.org/>
- Direct export:
  <https://database.lichess.org/lichess_db_eval.jsonl.zst>
- Official convenience mirror:
  <https://huggingface.co/datasets/Lichess/chess-position-evaluations>
- License: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Informational scale on 2026-07-29: 394,669,566 positions. The official
  denormalized Hugging Face representation contains 957,860,115 rows and is
  about 42 GB.

Use this as the main exploration and sampling corpus. It includes FEN, search
depth/node count, centipawn or mate values, and principal variations. Prefer
the strongest evaluation per normalized position, then re-label the selected
fit corpus with the pinned teacher. The export omits halfmove/fullmove
counters; reconstruct full FENs from PGNs or reject cases where draw state can
matter.

### Lichess standard rated games

- Source and monthly downloads: <https://database.lichess.org/>
- Download pattern:
  `https://database.lichess.org/standard/lichess_db_standard_rated_YYYY-MM.pgn.zst`
- License: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Informational scale on 2026-07-30: 7,949,495,674 games in 2.51 TB compressed.

Use selected, checksummed monthly snapshots to reconstruct complete legal
states, diversify sampled positions, and group splits by source game. Filter
to standard chess and explicitly reject bots, malformed games, unsuitable time
controls, and known-bad historical ranges as required by an experiment.
Lichess **broadcast** exports are a different CC BY-SA dataset and are not part
of this primary source.

### Lichess puzzles

- Source: <https://database.lichess.org/>
- Direct export:
  <https://database.lichess.org/lichess_db_puzzle.csv.zst>
- License: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Informational scale on 2026-07-29: 6,057,356 puzzles.

Use as a tactical auxiliary set or independently frozen holdout. Puzzles are a
selected tactical distribution and must not dominate the general evaluation
fit. Remove source-game URLs from derived training records.

## Optional, fetch-only sources

Optional sources are disabled by default. An experiment must opt in by source
ID, preserve the upstream license and notices, and keep the downloaded or
derived database outside the MIT distribution. Relabeling positions does not
by itself erase upstream database obligations.

### DeepMind ChessBench

- Official source:
  <https://github.com/google-deepmind/searchless_chess>
- Dataset license: mixed CC0 and
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Informational scale: 530 million board states from 10 million games and
  about 15 billion Stockfish 16 action values; approximately 1.1 TB
  action-value, 34 GB behavioral-cloning, and 36 GB state-value training data.

The repository's software is Apache-2.0 and its model weights are CC BY; those
licenses do not make the dataset Apache or MIT. Commercial use is allowed, but
dataset redistribution or adaptation requires attribution, a license link, and
an indication of changes. Prefer the official release over mirrors.

### Stockfish master binpacks

- Source:
  <https://huggingface.co/datasets/official-stockfish/master-binpacks>
- License:
  [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
- Informational scale on 2026-07-30: about 287 GB.

These are directly relevant to NNUE research. Any public derivative database
must satisfy ODbL share-alike and access requirements. A public produced work,
including a released trained artifact where applicable, must carry the ODbL
source notice described by section 4.3.

### Leela Chess Zero training data

- License statement:
  <https://lczero.org/blog/2021/06/the-importance-of-open-data/>
- Data index: <https://storage.lczero.org/>
- Database license:
  [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
- Individual contents:
  [DbCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/)

This corpus offers self-play policy/value diversity, but it is not a pinned
Stockfish-centipawn corpus. Apply the same ODbL segregation, share-alike, and
produced-work notice rules as for Stockfish binpacks.

### Stockfish Fishtest LTC PGNs

- Source:
  <https://huggingface.co/datasets/official-stockfish/fishtest_pgns>
- Dataset metadata license:
  [LGPL 3.0](https://www.gnu.org/licenses/lgpl-3.0.html)
- Informational scale on 2026-07-30: approximately one billion games and
  1.05 TB, with evaluation/depth/time comments.

Use only for explicitly licensed sampling or external validation. The corpus
is highly correlated and spans changing development builds, so it is not a
default teacher-label source. Preserve the LGPL dataset license; do not
relicense the files as MIT.

### TCEC games

- Source: <https://github.com/TCEC-Chess/tcecgames>
- PGN license:
  [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)

The archive scripts are Apache-2.0, but the PGNs are CC BY-SA 3.0. If used,
keep PGNs and transformed database material fetch-only with attribution and
ShareAlike treatment. Prefer this source for external engine-game evaluation,
not the default fit.

## Excluded sources

No data may be fetched, trained on, or redistributed from these entries until
the manifest is changed after an explicit upstream license and provenance
review:

- [Gigafish](https://huggingface.co/datasets/lukesalamone/gigafish-3.8b-d10):
  3,919,006,164 depth-10 rows (about 101 GB), but no dataset card or explicit
  license. CC0 ancestry alone does not license the maintainer's transformation.
- [CCRL](https://computerchess.org.uk/ccrl/4040/): downloadable engine games,
  but no explicit dataset license was found on the official download/About
  pages.
- [ChessDB](https://chessdb.cn/cloudbookc_info_en.html): a very large analysed
  position service, but no explicit database license was found.
- [Maia processed CSVs](https://csslab.cs.toronto.edu/datasets/): derived from
  Lichess, but the data page gives no dataset-specific license. Recreate needed
  subsets from primary Lichess CC0 data instead. The current
  [Maia-2 code](https://github.com/CSSLab/maia2) is MIT-licensed tooling, not an
  independently MIT-licensed dataset.
- Third-party mirrors and repackagings, including unofficial ChessBench
  mirrors: a host's license tag is not accepted when it omits or conflicts
  with upstream terms. Use the official source.

## Release checklist

Before any training or model release:

1. Validate the source ID and disposition against `source-manifest.json`.
2. Resolve immutable downloads and record byte size plus SHA-256.
3. Save the upstream license text/URL and required attribution with the run.
4. Confirm that raw and transformed data remain outside the Git tree.
5. Apply privacy minimization and legality/full-state validation.
6. Apply the frozen incident-family denylist before any split or augmentation.
7. Group splits by source game or generation lineage to prevent leakage.
8. Generate final labels with the pinned external Stockfish teacher.
9. Record the complete run manifest and output checksums.
10. Re-run the license gate before publishing a corpus, parameters, or weights.
