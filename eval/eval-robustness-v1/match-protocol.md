# Equal-time game screens

The target is a **55% candidate game score** against the r85 production HCE, with a draw worth half a point. Both comparisons use 32 opening pairs, 25 ms per move with zero node limit, a maximum search depth of 30 and a limit of 180 searched plies. The host switches candidate colors for the second game of each opening and alternates the starting candidate color across pairs. It retains cap draws and uses complete repetition history, production WASM, four identical fixed-node warmup rounds and the byte-bound Node host from the production evaluator pipeline. A single prespecified short control keeps this a development experiment.

## Opening selection

The banks come from the previously inventoried January 2014 Lichess archive. Across the two initial banks every opening is unique by source game, structural root family, mirrored board cluster, and family after eight plies. The selector excludes all one million prior primary positions by family and cluster, earlier Stockfish diagnostic games and families, historical quarantine fixtures, and earlier sparse-evaluator match roots. The anonymous primary export lacks source game IDs, so its game-level overlap is unknown. All 64 match game IDs lie in a hash partition reserved before the new teacher collection. No engine score or result selects an opening. Each bank contains at most two openings per four-ply structural family. The two-color score interval resamples these families, retaining both colors together. Inference is approximate and specific to this sample and hardware.

## Candidate choice

The first bank always tests the complete no-pawn residual. The primary fit on fresh sibling decisions determines the numerator of the residual on the independent second bank. A numerator of 16 replicates the complete no-pawn candidate. A numerator of 0 makes the selected score identical to HCE. In that case only, a separately registered exploratory half-strength candidate uses the second bank. The fit selected 12/16, so the conditional half-strength registration (SHA-256 `cc17986c9196060e65d55eece52a0b01fb8988f4eccb91f0a8f79fc2cab195d3`) did not run. Fitted and unscaled results from different banks are each comparisons with HCE and do not directly measure the difference between candidates.

## Reproduction

Run the following from the repository root, with python-chess and zstandard installed. Restore the original data bundle from the sparse PeSTO v1 study into a fresh directory for reselection. The committed JSONL opening files also permit running a campaign without restoring training or holdout data.

```sh
python -m tools.eval_robustness.match_openings /path/to/restored/data /tmp/reselected
cmp /tmp/reselected/match-unscaled-openings.jsonl eval/eval-robustness-v1/match-unscaled-openings.jsonl
cmp /tmp/reselected/match-fitted-openings.jsonl eval/eval-robustness-v1/match-fitted-openings.jsonl
python -m tools.eval_robustness.match unscaled /path/to/baseline-memory.wasm /path/to/sparse-simd.wasm /tmp/games --numerator 16
python /tmp/games/campaign/source/games.py audit /tmp/games/campaign
```

For the second campaign use the fitted bank, measured candidate module and selected numerator. The run freezes the configuration, source, node binary identity, exact modules, openings and schedule before playing. Use CPU affinity to pin the process on hosts that support it. The two initial 32-pair screens each used a single pinned search worker on logical CPU 8. Other research processes could run concurrently on the shared host. Engine-call and end-to-end timing receipts quantify achieved wall time. They do not establish exclusive core access or mobile behavior.

## Independent replication of the unscaled model

The initial no-pawn point estimate exceeded the target. Before playing another game on a third bank, we froze 128 previously unused opening pairs, selected with a new salt and excluding both earlier banks by source game, structural root family, root board cluster, and eight-ply family. We retained the maximum of two pairs per four-ply family across the whole replication. The opening index modulo four assigns each pair to a shard. Each shard uses a single pinned worker, and all four registrations are written before any shard starts. The aggregate interval resamples the four-ply families across all shards. This replication has one prespecified budget and one candidate.

```sh
python -m tools.eval_robustness.match_openings /path/to/restored/data /tmp/replication-bank --replication
python -m tools.eval_robustness.match_replication register-run /path/to/baseline-memory.wasm /path/to/sparse-simd.wasm /tmp/replication --cpus 0,1,6,7
python -m tools.eval_robustness.match_replication audit /tmp/replication /tmp/replication-summary.json
```

## Raw replay and move-choice checks

The evidence archives retain the complete raw request/response ledgers, engine modules, executable identities, protocol, Python source/rules, PGNs and canonical audits. The single-campaign archives contain a top-level `campaign/`. After extraction, run the following in a fresh restoration directory to re-audit the closed ledger and PGNs without searching again.

```sh
PYTHONPATH=campaign/source python - <<'PY'
from pathlib import Path
import games
root = Path("campaign")
expected = games.decoded((root / "audit.json").read_bytes())
actual = games.audit(root, expected["campaignAudit"]["registrationSha256"], publish=False)
assert actual == expected
PY
```

The optional `match_choices` diagnostic replays the opening prefix, identifies both timed searches on the identical board and complete history, and asks pinned Stockfish 11 for its score of each differing choice at 100,000 nodes per child. Identical moves contribute exactly zero to the difference. It reports the latest completed exact PV score, oriented to the root player and capped at ±2,000 cp. This post hoc diagnostic compares the two timed moves at the opening root. It does not score every later choice or estimate regret against an unconstrained best move.

For the replication archive, extract into a fresh directory and run `python -m tools.eval_robustness.match_replication audit /path/to/extracted /tmp/verified-replication.json` from the repository root. That command verifies each shard against its original registration and replays all its histories and PGNs before producing the combined result. The committed result includes the archive size, SHA-256 and successful restoration receipt.

## Fitted-model replication and paired difference

Before opening the unscaled replication scores, the fitted 12/16 residual was registered for all 128 identical opening pairs on the same four-CPU partition. Its games ran in a later measurement period after the preceding shards sealed. Both candidates therefore face HCE on the same opening positions and colors. The difference between their two scores is an indirect comparison with a shared opponent. The two candidates did not play each other. Per-CPU and time-limit summaries accompany both results.

```sh
python -m tools.eval_robustness.match_replication register-run /path/to/baseline-memory.wasm /path/to/scaled-12.wasm /tmp/fitted-replication --numerator 12 --cpus 0,1,6,7 --after /tmp/replication
python -m tools.eval_robustness.match_replication audit /tmp/fitted-replication /tmp/fitted-replication-summary.json
python -m tools.eval_robustness.match_contrast eval/eval-robustness-v1/match-replication.pgn eval/eval-robustness-v1/match-fitted-replication.pgn eval/eval-robustness-v1/match-replication-openings.jsonl /tmp/joint.json
```

The joint analysis binds both archived PGNs and verifies identical openings and color pairs before resampling the same structural families for both models and their difference. The marginal intervals refer to individual comparisons. The simultaneous intervals use three Bonferroni-adjusted percentile bands.
