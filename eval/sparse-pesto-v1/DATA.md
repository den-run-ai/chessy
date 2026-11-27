# Large sparse PeSTO: data and source boundaries

This is a new exploratory study authorized in November 2026. It does not
reopen a previous failed tuning round or any of the historical locked test
roles. It keeps the production evaluator and historical evidence separate.

## Primary evaluation sample

The source is the [official Lichess evaluation export](https://database.lichess.org/#evals),
whose [database license](https://database.lichess.org/) is CC0 1.0. The download
declares the **first 536,870,912 compressed bytes (512 MiB)** of the November 1,
2026 export before looking at admission results. The response must be HTTP
206 with exactly that byte range. Its retained source receipt records the
URL, response ETag, last-modified time, retrieval time, byte count and SHA-256.
This is a reproducible prefix sample, **not a representative random sample
of the full database** and not a complete Zstandard frame or archive.

All complete decompressed JSONL lines in the declared sample are inventoried
and hashed. A final incomplete line is discarded, with its byte count and
hash recorded. The importer can stop admitting at one million rows while
still consuming every complete source line. It never invents a total-game
count: these records have no source-game lineage.

The frozen admission rule is:

- Choose the deepest available evaluation, breaking ties by reported nodes;
  use its first principal variation. A deeper mate result is excluded rather
  than replaced by a shallower numeric evaluation.
- Require depth at least 20, at least 100 reported kilonodes, and a finite
  integer White-perspective score in `[-2000, 2000]` centipawns.
- Require a structurally valid standard chess board, no check at the root,
  and sufficient material. The first PV move must be legal, noncapturing,
  nonpromoting and nonchecking. Every move of the complete supplied PV must
  replay legally.
- Exclude historical quarantined positions and structural families; remove
  duplicate position clusters and cap each structural family at eight rows.
- Assign the entire structural family to an 80% training, 10% validation,
  10% holdout role by a fixed salted SHA-256 rule. The cap and role rule are
  independent of fitted model performance.

The old repository's exact symmetry keys are retained: original position,
file reflection, color/rank reflection and both reflections share a cluster.
The coarser family key retains pawn locations, king locations and nonpawn
material while forgetting other piece locations. This conservative key also
ignores side to move, castling rights and counters for leakage prevention.
It is checked against the repository's independent JavaScript implementation.

The eight-file quarantine covers the public evaluation corpus, puzzle source,
both tracked Master incidents and their complete recorded prefixes, both
historical opening banks and the old WASM signature fixture. It contains
2,179 unique model clusters, 1,085 structural families and 40 known source
games. No historical test scores or candidate performance are used to select
new rows. Unknown cross-source incident lineage remains unknown.

The completed run inventoried **7,231,317 complete source lines** and admitted
the registered **1,000,000 positions**, covering **549,270 structural
families**. It reached the admission cap after 2,495,750 source lines; the
remaining 4,735,567 complete lines were retained in the source inventory
without further candidate admission. Ninety-four decompressed trailing bytes
formed an incomplete final line and were excluded.

| Role | Positions | Opening | Middlegame | Endgame |
| --- | ---: | ---: | ---: | ---: |
| Training | 799,145 | 461,709 | 172,253 | 165,183 |
| Validation | 100,164 | 57,668 | 21,911 | 20,585 |
| Holdout | 100,691 | 58,044 | 22,019 | 20,628 |

The downloaded compressed-prefix SHA-256 is
`6c2dc6c9b3856d3fb19bcd1d568cdbb49418f2895b12091cd0497b0c2aff117f`.
The primary importer ran with Python chess 1.11.2 and Zstandard 0.25.0.
These counts describe admitted static positions; the number of source games
represented by them is unknown.

A separate audit verified **all 1,000,000 source-to-label joins**, every role
file's hash/count, zero cross-role structural-family overlap, and **973
deterministically sampled key pairs** against the independent JavaScript
corpus implementation. This verifies provenance and split consistency; it
does not establish that every mixed-engine teacher score is objectively
correct. No candidate or holdout performance was inspected by the audit.

## Additional natural games

The independent natural source is the **complete January 2014 standard rated
archive: 697,600 games, 111,440,294 compressed bytes**. The official
[checksum list](https://database.lichess.org/standard/sha256sums.txt) pins it to:

```
f4e9efea9aeb608211a1e1b62aff00b92679eab6b70f957e77a1d7c4d8bfbbc8
```

Every raw source game receives a content-hash inventory entry. A game is
eligible for position selection only if it has a standard initial position,
an authenticated-shaped Lichess game ID, a complete matching result token,
no declared bot participant, both player ratings between 1200 and 3500,
base time at least three minutes, and at least 30 legally parsed mainline
plies. Usernames are discarded. Selected source-game identities are opaque
hashes.

The selector chooses at most one position per game by a label-blind hash
over eligible plies 16–160. Its root has halfmove clock 2–79, is not in check,
has sufficient material and no current threefold repetition, and the next
recorded game move is legal, noncapturing, nonpromoting and nonchecking.
The same quarantine, mirror deduplication and eight-row family cap apply.
The complete legal move prefix and authentic full FEN are retained so a
separate teacher can reconstruct draw state.

The completed selector retained **407,732 positions from 407,732 unique
games**, covering **390,994 structural families**. The full inventory records
241,003 rating/time-control exclusions, 41,692 short games, 3,046 games with
no eligible quiet position, 2,142 family-cap exclusions, 1,117 quarantine
exclusions, 757 duplicate-game/cluster exclusions and 111 malformed-metadata
or parse exclusions. Together with selected games these account for every
one of the 697,600 input records.

The run executed the original read-only importer snapshot. After completion,
an independent audit passed **all 697,600 raw-game inventory joins** and used
the historical selector's strict SAN-token grammar to verify **every one of
407,732 selected games' full movetext lengths**, closing python-chess's
ability to silently ignore an unknown token. The reusable importer now
performs that strict scan before admitting future games. No scores or
candidate outcomes determine this correction; original data and receipts
are preserved, and the independently audited run keeps its original source
hash rather than being relabelled as an execution of the newer code.

**These additional natural positions start unlabelled.** The number of raw
games, selected games, labelled positions and fit rows are separate counts.
They must never be added together or described as though every downloaded
game supplied a training label. A prospective independent-source test can
select a fixed subset after additionally excluding **all** primary-sample
families and then label that subset with one pinned Stockfish build. That
stage must publish its own teacher/configuration/evidence receipt.

## Artifact contract

`tools/sparse_eval/data.py` publishes three role-specific JSONL files and a
`chessy.sparse-eval-data.v1` manifest. Each file inventory entry includes its
role, exact byte length, row count and SHA-256. Each row has `fen`,
`cpWhite`, `depth`, `knodes`, `pvFirst`, `pvPlies`, `pvSha256`, `cluster`,
`family`, `phase`, `phaseBucket`, `role` and `sourceRecord`. The primary
source's `sourceGameId` is explicitly null. Four-field source FENs get
synthetic `0 1` counters **only for static evaluation**; these counters must
not be treated as real game history.

The complete-source natural selector publishes
`chessy.sparse-natural-data.v1`, one raw-game inventory and one unlabelled
position file. Its rows additionally retain `prefixUci`, `selectedPly`,
`gamePlies` and `selectionPriority`.

Both importers reserve a new output directory exclusively, retain and hash
the same input descriptor that they consume, verify it again before
completion, fsync their output files, and publish the manifest last. A
directory without its final manifest is incomplete and may not be used for
fitting. Runs execute a retained read-only implementation snapshot, whose
hash is recorded; changes to a neighboring working copy do not alter the
running implementation.

The explicit `researchOnly: true`, `productionFitAllowed: false` and primary
`publishableArtifact: false` fields mean **no certified/deployable evaluator
artifact is authorized by this data receipt**. They do not prevent publication
of the research implementation, weight-free results or separately documented
and licensed exploratory weights. Such weights still require a model card
stating their actual mixed-teacher source, experimental status and lack of
strength or deployment admission; they cannot silently become production
inputs. The source remains CC0 regardless of Chessy's code license.

## Remaining data limitations

The evaluation export mixes Stockfish versions, networks, budgets and
settings. Depth and node thresholds do not make those labels homogeneous or
prove they are correct. It omits game IDs and genuine draw counters; split
families do not establish independence of players or opening histories.
Quiet-PV filtering is a practical noise filter, not a proof that every legal
move is quiet. The prefix may have phase, score, date or opening bias.

Consequently the main split supports an **exploratory predictive comparison
on this particular source**, not an Elo claim. The separate natural-game,
fixed-teacher check, phase/tail metrics, quantized parity and search-time
measurements are needed to evaluate transfer and cost. Formal strength,
minimum-device evidence and production admission remain separate.

## Commands

Run downloads and large outputs outside the repository:

```sh
python tools/sparse_eval/data.py download-eval /data/lichess-eval-prefix512m.jsonl.zst
python tools/sparse_eval/data.py import-eval /data/lichess-eval-prefix512m.jsonl.zst /data/lichess-eval-prefix512m.jsonl.zst.source.json /data/eval-v1 --root "$PWD" --workers 4
python tools/sparse_eval/data.py download-pgn /data/lichess-standard-2014-01.pgn.zst --sha256 f4e9efea9aeb608211a1e1b62aff00b92679eab6b70f957e77a1d7c4d8bfbbc8
python tools/sparse_eval/data.py select-pgn /data/lichess-standard-2014-01.pgn.zst /data/lichess-standard-2014-01.pgn.zst.source.json /data/pgn-v1 --root "$PWD" --workers 4
python test/training/sparse-data.test.py
```

For a long run, copy the selected importer to a new read-only snapshot path
first and execute that snapshot with an explicit `--root`. The JSONL files
remain external; the committed research report records final counts and
content identities after completion.
