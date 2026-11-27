# Independent-source Stockfish 18 diagnostic

This is a new, research-only diagnostic for the sparse PeSTO prototype. It does
not reopen any historical locked test or certify playing strength. Its labels
cannot select or refit the candidate: evaluate the frozen candidate once, and
report failure as well as improvement.

## Source and selection, frozen before teacher labeling

The natural source is the **complete January 2014 Lichess standard-game
archive**, containing 697,600 source games. The compressed archive is CC0 and
has official SHA-256
`f4e9efea9aeb608211a1e1b62aff00b92679eab6b70f957e77a1d7c4d8bfbbc8`.
The parent natural-data importer inventories every source game, replays legal
mainlines, and retains at most one label-blind quiet position per eligible game.
Those natural positions are unlabelled and do not silently become training data.

The OOD selector reads the complete primary train, validation and holdout
inventories for family/cluster exclusion only. It excludes **every primary
family and exact/mirrored cluster**, then selects 4,096 distinct natural games
and distinct structural families. Selection uses the smallest SHA-256 of
`chessy.sparse-ood.v1`, NUL, and the opaque source-game ID within each phase:

| Phase | Frozen selected rows |
|---|---:|
| Opening, phase 18–24 | 1,366 |
| Middlegame, phase 7–17 | 1,365 |
| Endgame, phase 0–6 | 1,365 |

The selector publishes an authenticated selection manifest only after verifying
all declared input rows, byte counts and hashes. It replays every selected
full UCI move prefix and requires the exact original six-field FEN. A missing
phase quota, changed input, duplicate game/family, or incomplete inventory
stops publication.

The eval export lacks game lineage. Therefore "independent source" means a
different verified archive with observed family/cluster separation; it does
not establish that no anonymous eval-export record originated in the same
upstream game. Shared players and more general opening dependence remain
unknown.

## Pinned teacher

- Official release: [Stockfish 18](https://github.com/official-stockfish/Stockfish/releases/tag/sf_18).
- [Ubuntu AVX2 release archive](https://github.com/official-stockfish/Stockfish/releases/download/sf_18/stockfish-ubuntu-x86-64-avx2.tar),
  114,401,280 bytes; published SHA-256
  `536c0c2c0cf06450df0bfb5e876ef0d3119950703a8f143627f990c7b5417964`.
- Extracted executable SHA-256:
  `6b087694916228c905a5e14db74cca8c7e5643602226af1fa5d42353c455b9f9`.
- Embedded networks: `nn-c288c895ea92.nnue` and `nn-37f18f62d772.nnue`.
  Their bytes are bound by the executable hash. The teacher executes from a
  private directory containing the authenticated executable, with no external
  NNUE files.
- GPL-3.0 teacher; CC0 input games. The teacher executable/networks are not
  included in the Chessy application or relicensed as MIT.

Every selected root receives `ucinewgame`, explicit `Clear Hash`, full
`position startpos moves ...` history and `go nodes 100000`. Settings are one
thread, 16 MiB hash, MultiPV 1, full skill, no pondering, no limited strength,
standard chess, WDL reporting on and Syzygy probing disabled. At most four
independent single-thread processes run locally. There is no paid compute.

## Admission and evidence

Admission requires a final unbounded centipawn report with at least 100,000
reported nodes, depth at least 10, absolute score at most 2,000 cp, a legal
complete PV, and agreement between its first move and the terminal `bestmove`.
The first teacher move must be quiet: no capture, promotion or check. WDL
components must be nonnegative and sum to 1,000. Centipawns and WDL are converted
from the teacher's side-to-move perspective to White's perspective.

Mate scores, bounded scores, incomplete budgets, depth failures, tactical first
moves, illegal PVs and bestmove/PV disagreement are retained as explicit
exclusions. No row is relabeled or retried to obtain a preferable result.
In particular, a final aspiration-window bound at the node limit is excluded
rather than treated as an exact score.

All selected rows remain in `labels.jsonl`, including exclusion reasons. Every
UCI command and response is retained in `traces.jsonl.gz`, with per-row trace
hashes. Initialization transcripts, exact options, executable identity,
selection identity and complete output inventories are published before the
final completion manifest. Missing completion metadata means an interrupted
or invalid run, not an eligible partial dataset.

These 100k-node scores are approximate teacher labels. Quietness and numerical
admission narrow the evaluated population. A lower prediction loss on this
set would be transfer evidence, not an Elo gain or a physical-device result.

## Commands

```sh
python tools/sparse_eval/label_ood.py select \
  /absolute/data/pgn-v1/manifest.json \
  /absolute/data/eval-v1/manifest.json \
  /absolute/output/ood-selection-v1

python tools/sparse_eval/label_ood.py label \
  /absolute/output/ood-selection-v1/manifest.json \
  /absolute/stockfish-ubuntu-x86-64-avx2 \
  /absolute/output/ood-labels-v1 --workers 4
```

Only final generated manifest hashes and observed results should be appended
after execution. The predeclared selection and admission rules above do not
change after observing candidate performance.

## Completed collection and independent audits

The full archive produced **407,732 eligible unlabelled positions from 407,732
unique games**, covering 390,994 structural families. An independent audit
verified all 697,600 raw-game hash/count joins and the strict SAN-token counts
of every selected complete game. The OOD selector excluded 25,530 rows with a
primary family/cluster overlap and selected its frozen 4,096 rows from 382,202
eligible rows.

The single teacher pass completed all 4,096 selected roots in **237.38 seconds**
using four local single-thread workers. There were no retries. Independent
raw-trace audit verified all source/label/trace joins, full-history position
commands, exact requested budgets, final PV legality, admission decisions,
White-POV CP/WDL conversions, and all four initialization transcripts. Final
reported node counts sum to 406,599,557; early mate termination is retained in
the exclusion inventory.

| Phase | Selected | Accepted | Bounded score | Mate | Tactical first move | Below budget |
|---|---:|---:|---:|---:|---:|---:|
| Opening | 1,366 | 713 | 538 | 3 | 112 | 0 |
| Middlegame | 1,365 | 855 | 326 | 46 | 138 | 0 |
| Endgame | 1,365 | 857 | 302 | 111 | 94 | 1 |
| **Total** | **4,096** | **2,425** | **1,166** | **160** | **344** | **1** |

The accepted labels cover 2,425 distinct source games and families. The high
exclusion fraction is disclosed: this diagnostic represents the admitted
quiet, unbounded-score population, not all natural positions. Neither
collection nor its independent audits inspected candidate performance.

The complete local evidence consists of authenticated source/selection
manifests, selected full histories, labels including exclusions, compressed raw
UCI transcripts, initialization transcripts, and two independent OOD audits.
Key identities:

| Artifact | SHA-256 |
|---|---|
| Frozen selection manifest | `3180d17d7958f10b7ebd9830db3d64633fe706868b6323d6846489d4a654e1d2` |
| Selected rows | `2add1b46557117edd833bf493bc66c4264ad4700e0fa416ffa81a543a8b8a92f` |
| Completed label manifest | `2c719dff3dd1448b85748b5b79f4e5755b1c8208a572b350703d28c41ea28a05` |
| All labels and exclusions | `7d95d02426ef09da884ac3051d333731f41054210f52ed66eeafcef780342fff` |
| Compressed raw UCI traces | `e77bbfd0569d54a84d7aa369755cec55e2b5efafbe052eb0c6b3c295fee0dc91` |

Candidate transfer metrics belong in the frozen model's results report. These
data-collection outcomes establish no evaluator or playing-strength gain.
