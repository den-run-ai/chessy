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

### Working release position on generated output

This is Chessy's documented working release position, not legal advice or a
guarantee about any particular artifact. The GNU/FSF FAQ says that a program's
output is [not generally covered by the copyright on the program's
code](https://www.gnu.org/licenses/gpl-faq.en.html#WhatCaseIsOutputGPL), while
output that copies substantial protected material from the program can require
a [different analysis](https://www.gnu.org/licenses/gpl-faq.en.html#GPLOutput).
On that basis, Chessy does not presume that Stockfish's numeric CP/WDL labels
or machine-readable chess moves become GPL-covered merely because Stockfish
generated them. If output copied protectable Stockfish expression, that
working position would not resolve the issue.

Three questions remain separate:

- distributing the Stockfish executable or covered code invokes the GPL
  obligations for that software;
- input positions and databases retain their CC0, CC BY, ODbL, DbCL, LGPL, or
  other upstream status; relabelling does not clear those rights or notices;
- generated label corpora, fitted HCE parameters, and NNUE checkpoints need an
  explicit artifact-license decision. The repository's MIT license does not
  automatically attach to them.

Preserve the pinned teacher and input provenance even when no Stockfish binary
is distributed. Before any public release of labels, HCE parameters, or NNUE
checkpoints, record an artifact-specific legal review and the chosen license.

The locked `11...Bd4` incident position, its color/rank mirrors, and its
broader structural position family are actively denied from corpus selection,
teacher relabelling, and training. This budget-independent family denial also
rejects a corpus record produced by relabelling the position at a nearby node
budget.

Two broader controls are deliberately marked pending in `heldout-v1.json`.
The static Lichess evaluated-position export has no stable source-game IDs, and
the incident fixture does not identify a corresponding upstream Lichess game,
so same-source-game-lineage quarantine cannot yet be enforced. It requires a
pinned CC0 PGN-derived corpus and an explicit incident source-game identifier.
A fit using only the static FEN export may exercise the research pipeline, but
is policy-ineligible for public artifact release until that lineage condition
is satisfied. This is currently a documented policy gate, not an executable
release gate.

The nearby budgets are already preregistered as 8,268,594 and 10,106,060 nodes
in `hce-r3-fit-v1.json`. Ad hoc probe runs are not corpus records, and no
execution evidence or results exist until a broadly validated candidate
reaches the post-fit gate. Do not describe preregistration as completed probe
execution or the pending lineage control as active enforcement.

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
7. For sources carrying stable lineage, group splits by source game or
   generation lineage. A FEN-only source must record lineage as unavailable
   and cannot claim this control.
8. Generate final labels with the pinned external Stockfish teacher.
9. Record the complete run manifest and output checksums.
10. Record legal review and an explicit license decision for generated labels,
    HCE parameters, and NNUE checkpoints.
11. Re-run the license gate before publishing a corpus, parameters, or weights.
