# Sibling decisions from natural games

The frozen sample contains 631 decisions and 2,019 candidate moves from 320 Lichess games. The labels come from Chatarunga 2.0 using its original embedded NNUE weights. Each child also carries the three integer static scores from Chessy. All four scores use the root mover's perspective. The sibling sample tests move ranking and static evaluation. A position immediately after a capture can still contain a forced recapture, whereas Chessy's search normally examines that continuation.

## Sampling and labels

The collector streams the January 2014 standard-game archive and takes the first 320 eligible games in archive order. Both reported ratings must be between 1200 and 3500, with at least 180 seconds initial time, a completed PGN result, a standard initial board, and legal mainline replay. The source-game identifier is Chessy's SHA-256 of the Lichess site ID prefixed by `lichess:`. The sampler excludes the 4,096 prior transfer games and the 64 opening sources from PR #200. The independent match banks reserve three hash prefixes. A later audit checked their actual game IDs.

For each game a hash of its ID assigns two preferred strata. Possible strata include positions in check, a played recapture, endgames, tactical moves and quiet moves. The sampler chooses at most two roots per game, separated by at least six plies, with at least two legal options per root. Candidate moves include the played move, the teacher's preferred move, and hash-selected tactical and quiet alternatives when available. The teacher determines its move once at the parent. It searches each selected child with the legal game history and a UCI new-game request. Each worker reuses one teacher process. A direct replay found that the teacher retained enough state for query order to change two of 97 sampled children’s scores, by up to 31 cp.

Each search requests 12,000 nodes using one thread and a 16 MiB hash table. Counts reflect the implementation's stopping behavior. The 2,007 nonterminal child searches reached a median of 15,924 reported nodes and depth 9. The 12 terminal children use the rules result directly. Mate labels preserve the signed mate distance separately and also encode it near ±3,000 cp. These shallow search labels span all five strata. The sampled alternatives are a subset of legal moves.

The source-game and new symmetry-cluster partitions are disjoint. Across all one million old corpus rows, one symmetry cluster also occurs in the new fitting split. None occurs in the new held-out split. The historical evaluation dump omits game identities, so this cannot establish historical source-game isolation.

## Reproduction

Run from the repository root with python-chess and zstandard installed. `ORIGINAL` denotes the extracted original data-and-evidence archive. `REFIT` contains the restored native extractor and two weight files from the prior refit study. The new compressed JSONL and its SHA-256 are the frozen inputs to model comparisons. Re-running the original collector can yield different scores and node counts because the teacher process can retain search state. The frozen file reproduces the original fit.

```sh
python tools/eval_robustness/collect.py \
  --pgn "$ORIGINAL/data/lichess-standard-2014-01.pgn.zst" \
  --teacher "$ORIGINAL/chnn/head-screen-v1/chatarunga" \
  --previous-ood "$ORIGINAL/data/ood-selection-v1/selection.jsonl" \
  --previous-openings eval/sparse-pesto-v2/game-openings.jsonl \
  --extractor "$REFIT/extractor" \
  --full "$REFIT/inputs/original-full.i16le" \
  --no-pawn "$REFIT/refit-no-pawn.i16le" \
  --output /tmp/collection.jsonl.gz
```

`collect_verify.py` replays all positions, checks move flags and mate/draw termination, independently invokes the r85 production WASM ABI for every static score and scans original cluster metadata for overlaps. The arguments below refer to restored production study modules.

```sh
python tools/eval_robustness/collect_verify.py \
  --rows eval/eval-robustness-v1/collection.jsonl.gz \
  --openings eval/eval-robustness-v1/match-{fitted,unscaled}-openings.jsonl \
  --wasm "$FULL/modules/baseline-memory.wasm" "$FULL/modules/sparse-simd.wasm" \
         "$NO_PAWN/modules/sparse-simd.wasm" \
  --primary "$ORIGINAL"/data/eval-v1/{train,validation,holdout}.jsonl \
  --output /tmp/collection-audit.json
```

## Search-state isolation

The audit replayed 97 nonterminal children from 32 roots. Five node counts and two scores changed when the teacher received the same positions in a different order. At one fixed child the teacher returned −162, −159 and −202 cp on three consecutive new-game requests in a single process. Starting a fresh process and replaying the original parent and preceding siblings reproduced the archived −193 cp on the first child query.

The isolated re-labeling command starts a fresh operating-system process for each parent and each nonterminal child. It keeps the original alternatives, histories, terminal results and static scores. It compares parent move choices, repeats 32 complete roots, and refits the same four scalar recipes with the original exclusion groups and split.

```sh
python -m tools.eval_robustness.isolated_labels \
  eval/eval-robustness-v1/collection.jsonl.gz \
  "$ORIGINAL/chnn/head-screen-v1/chatarunga" \
  eval/eval-robustness-v1/fit-protocol.json \
  eval/eval-robustness-v1/fit-exclusions.json \
  /tmp/chessy-isolated-siblings --workers 2
```

Across the full isolated pass, 117 of the 2,007 searched child scores changed, with a maximum absolute shift of 86 cp. The best-scoring child set changed at 11 of 631 roots. All 631 isolated parent searches chose the originally sampled teacher move. The 32 independently repeated parents and 97 nonterminal children matched on every retained search field. `isolated-collection.jsonl.gz` contains the full corrected labels and `isolated-audit.json` records the comparison.

The fitted continuous scale changed from 0.7404 to 0.7387. The integer export is 12/16 in both cases, and all three ablations also reproduced their exported numerators. On the same 78 held-out games the isolated labels yield mean regret of 207.84 cp for HCE, 167.96 cp for full, 177.56 cp for no-pawn and 184.03 cp for calibrated. The calibrated-minus-HCE difference is −23.81 cp, with a paired game-bootstrap 95% interval of −81.23 to +17.53 cp. `isolated-fit.json` retains the complete refit and `isolated-exclusions.json` binds the identical exclusion groups to the corrected labels.

A second full pass ran with the roots in reverse order on four workers. The two complete passes produced byte-identical compressed labels, fits, exclusions and audit output. To reproduce this comparison, rerun the command with a separate output directory and `--workers 4 --reverse-order`, then compare both directories. `isolated-second-pass.json` records the full 631-parent and 2,007-child comparison.
