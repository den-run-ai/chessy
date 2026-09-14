# Natural-game compact evaluator pilot v1

This is a separately preregistered research study. Its selection and any later
teacher-loss results do not admit a production evaluator or demonstrate an
Elo/time improvement. The frozen June production dataset and its admission
contracts are unchanged.

## Freeze and complete source

The machine rules are [natural-pilot-v1.json](natural-pilot-v1.json), the
constrained HCE experiment is [natural-fit-v1.json](natural-fit-v1.json), and
the retained source-built Stockfish 18 profile is
[natural-teacher-v1.json](natural-teacher-v1.json). The selector snapshots all
three identities before inspecting games, and rehashes them, its implementation,
the complete source, and quarantine inputs before its completion marker.

The entire official CC0 January 2013 Lichess standard-rated archive was
authenticated: **17,761,302 compressed bytes; 121,332 games**.

- Compressed SHA-256:
  `aa40b3671fa3cf1072eb182892cd90b0e1e003a4a5943492f64b77e7f3fd1635`.
- Decompressed SHA-256:
  `8963b6a1620a0e9c77e5515a0744ec133e86869487188af047bb0a74400dee37`.
- [Official archive](https://database.lichess.org/standard/lichess_db_standard_rated_2013-01.pgn.zst),
  [checksums](https://database.lichess.org/standard/sha256sums.txt),
  [CC0 policy](https://database.lichess.org/).

The archive's UTC dates include December 31 because of its calendar boundary;
the frozen range therefore includes `2012.12.31` through `2013.01.31`.
Ratings, time controls, legal game completion and game IDs are checked before
position eligibility. Metadata thresholds are both ratings 1,200–3,500 and
base time at least 180 seconds, with at least 30 recorded plies. Time forfeits
are eligible because teacher targets come from positions, not game outcomes.

## Label-blind selection and isolation

Each source game contributes at most one position, selected by a fixed hash
among quiet candidates from plies 16–160. A root is out of check, has a
halfmove clock of 2–79, is not insufficient material or a current threefold
repetition, and its next recorded move is a non-capture, non-promotion and
non-check. This is recorded-move quietness; it does not certify that no tactical
capture or threat exists. No engine scores were used to choose positions.

One candidate is chosen before quarantine or duplication checks. Excluding it
does not trigger a replacement from the same game. Global admission uses fixed
hash order, one exact/model-symmetry cluster per dataset, and at most four
positions per static pawn/king/material family. Family hashes assign disjoint
70/10/10/5/5 roles. Unique source-game IDs independently prevent source reuse.

The quarantine binds seven exact repository files. It includes all known
scorecard/puzzle roots, both incident records and their complete known
trajectories, historical match opening trajectories, and all 400 v2 opening
trajectories. The boundary contains **2,179 model clusters, 1,085 structural
families and 40 known source-game IDs**. Incident upstream game lineage remains
unknown; the selector preserves that limitation instead of inventing an ID.

## Selection result, before labels

All frozen coverage gates passed. The dataset contains **50,000 unique source
games, 50,000 unique model clusters and 49,381 structural families**.

| Role | Rows | Opening | Middlegame | Endgame | Families |
| --- | ---: | ---: | ---: | ---: | ---: |
| Shared train | 35,031 | 17,982 | 11,109 | 5,940 | 34,610 |
| HCE validation | 5,033 | 2,582 | 1,568 | 883 | 4,966 |
| HCE test | 4,962 | 2,572 | 1,533 | 857 | 4,898 |
| NNUE validation | 2,510 | 1,349 | 770 | 391 | 2,476 |
| NNUE test | 2,464 | 1,292 | 759 | 413 | 2,431 |

The source inventory preserves all **121,332** records and their original
decompressed byte offsets/lengths and raw-game hashes. The mutually exclusive
dispositions are 50,000 selected; 37,321 too-fast controls; 7,523 short games;
5,461 ratings outside the range; 398 invalid ratings/controls; 615 without a
quiet candidate; 10 quarantined model clusters; 178 quarantined structural
families; 42 duplicate model clusters; 114 family-cap exclusions; and 19,670
global-cap exclusions. None were selected or replaced using labels.

Every selected row retains its full legal start-position UCI prefix, six-field
FEN, source ID, game identity and immutable role. Each role has a separate
physical file; HCE and NNUE test labels can stay unopened. The manifest is the
sole completion marker and binds every role file and the complete source
inventory by SHA-256, bytes and row count.

The family count is not a proven effective sample size. Players and opening
ideas can still be shared, and January 2013 games are not representative of all
present-day chess. A tiny-network screen requires its own freeze and the
reserved NNUE roles. No model, runtime coefficient, WASM or difficulty level
is changed by this selection.

## Reproduction

Use Python `chess==1.11.2` and `zstandard==0.25.0`, plus Node for the existing
opening catalog. Python chess is an external development dependency; it is not
redistributed in the app. Keep the complete archive, raw source inventory,
selected data, labels, transcripts and model artifacts outside Git.

```sh
python3 test/training/natural-select.test.py
python3 test/training/natural-select.py \
  --archive /data/lichess_db_standard_rated_2013-01.pgn.zst \
  --quarantine-root /path/to/chessy-with-frozen-v2-openings \
  --output /data/natural-pilot/selection
```

The selector requires a fresh output directory. If interrupted or failed,
partial files are retained for diagnosis without `manifest.json`, and consumers
must reject them. The trust scope is an isolated trusted research runner, not
sealing against a hostile process sharing the same user identity.

Nine targeted tests cover complete-source hash refusal, malformed/truncated or
conflicting PGN, exact source byte framing, legal/quiet prefix reconstruction,
source/family/cluster isolation, quarantine without replacement, and honest
coverage failure. A 275-position independently generated/corpus check matches
the existing JavaScript model/structural-family keys exactly. A strict token
check closes python-chess's permissive behavior of ignoring unknown PGN tokens.

## Audited fitting and one-time test exposure

The research fitter requires exactly NumPy **2.3.5** and SciPy **1.17.0** and
fails before reading inputs if their versions differ. It accepts a completed
label run only after both independent audits pass: the complete selection
source audit and the closed label-artifact audit. Supply their reviewed
SHA-256 identities explicitly; the examples below use uppercase placeholders.

```sh
python3 tools/training/natural-pilot-fit.py select \
  --label-summary /data/natural-pilot/labels/summary.json \
  --selection-manifest /data/natural-pilot/selection/manifest.json \
  --selection-audit /data/natural-pilot/audit/selection-audit.json \
  --selection-audit-sha256 SELECTION_AUDIT_SHA256 \
  --label-audit /data/natural-pilot/audit/label-audit.json \
  --label-audit-sha256 LABEL_AUDIT_SHA256 \
  --output /data/natural-pilot/private-selection.json \
  --report /data/natural-pilot/validation-report.json
```

The fitter verifies both audit reports, their exact source and label-summary
identities, complete raw transcripts, worker partitions, exclusions, source
files, quarantine and implementation evidence. It rehashes every audited file
before model fitting and again before publishing a result. Mechanical hashing
of reserved test artifacts does not decode their labels or calculate model
metrics. The frozen selection retains all audit identities and the complete
input hash map. Research weight vectors stay outside Git.

Only a selection with `testEligible: true` may run the transfer command:

```sh
python3 tools/training/natural-pilot-fit.py test \
  --selection /data/natural-pilot/private-selection.json \
  --output /data/natural-pilot/test-report.json
```

This command revalidates the frozen audit evidence. Before opening test rows,
it atomically creates a permanent experiment marker under
`/data/natural-pilot/.natural-fit-state/`, outside the immutable selection and
label directories. The key binds the dataset selection, fit contract and
teacher contract; copying or renaming the frozen selection cannot reset it.
Any failure after exposure leaves the marker in place. A baseline selection
keeps the test closed. These consumer integrity checks leave the frozen
scientific contract, thresholds and optimization grid unchanged.
