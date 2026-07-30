# HCE R3 and NNUE training foundation

This directory prepares one license-clean teacher corpus for the final HCE
attempt in #137 and NNUE G0-G2 in #105. It does not change Chessy's evaluator,
search, level budgets, Rust/WASM asset, or release token. The shipped r69
evaluator remains the baseline and `--require-fix` remains opt-in.

The current work stops before any fit, candidate weight, model artifact, or
runtime integration. A real corpus freeze needs the literal Lichess snapshot
SHA-256 and an external Stockfish run; those large artifacts are intentionally
not stored in Git.

## Predeclared sequence

1. Freeze the E4-v1 adapter/manifests and the corpus contracts before games or
   labels.
2. Finish #84's physical-device, offline, watchdog, memory, battery, and
   thermal baseline.
3. Run Master certification first: 800 untouched opening clusters, both
   colors, 1,600 games. The one-sided 95% rating lower bound must reach 2300
   on the pinned Stockfish 18 UCI-Elo scale.
4. Run HCE R3.0/R3.1 once with the preregistered representation. Select lambda
   only on `hce-validation`, then open `hce-test` once.
5. Only a broadly validated candidate may run the locked `11...e4` post-fit
   gate. It must choose `e5e4` at exactly 9,187,327 nodes and stably at the
   preregistered nearby budgets, then pass parity, scorecard, device, and
   strength gates.
6. If r69 certifies at Master strength, retain `11...Bd4` as a known
   master-level mistake. Master strength is not perfect Stockfish play.
7. If r69 fails certification, stop the 2300+ claim. If HCE R3 fails untouched
   transfer or the locked post-fit gate, stop HCE without post-hoc feature,
   lambda, budget, FEN, or weight changes and continue NNUE #105.

## Data flow

```text
CC0 Lichess snapshot (pinned SHA-256)
  -> streaming exploration adapter
  -> incident/symmetry/family quarantine
  -> deterministic five-role selection
  -> pinned Stockfish 18 relabel per shard
  -> HCE sparse features OR NNUE 768-bit features
```

The five roles are fixed by the coarser position-family hash:

| Role | Planned records | Permitted use |
| --- | ---: | --- |
| `shared-train` | 2,100,000 | HCE and NNUE fitting |
| `hce-validation` | 450,000 | HCE lambda/candidate selection |
| `hce-test` | 450,000 | One-time HCE transfer decision |
| `nnue-validation` | 450,000 | NNUE architecture/run selection |
| `nnue-test` | 450,000 | One-time NNUE transfer decision |

This prevents an HCE result from spending NNUE's holdout. Model-equivalent
board-only positions and their legal color/rank/file symmetries stay together,
even when side/castling/en-passant FEN fields differ. The broader pawn-map,
king-square, and material family key owns role assignment and is capped at 64
selected positions, so one structural family cannot cross roles or dominate a
fit.

The static Lichess export has no game lineage or halfmove/fullmove state. It is
therefore suitable for static evaluation fitting, not repetition/fifty-move
training. A later CC0 PGN slice supplies complete states and source-game
grouping. Upstream mixed Stockfish labels are sampling evidence only.

## Build a deterministic multi-million selection

Download the Lichess evaluated-position archive outside the repository, retain
the archive, and compute its SHA-256. A 1/100 hash selection is expected to
produce roughly 3.9 million records, depending on the frozen snapshot and
filters. Production selection refuses to start until the E4 certification
manifest is literally frozen, then excludes every certification
board-equivalence cluster and position family before sampling:

```sh
node test/training/prepare-lichess-evals.js \
  --input /data/lichess_db_eval.jsonl.zst \
  --source-sha256 <64-hex-source-sha256> \
  --retrieved 2026-07-29 \
  --certification-manifest /data/e4-certification-frozen.json \
  --output /data/chessy-e4-v1-selection \
  --modulus 100 \
  --numerator 1 \
  --family-cap 64 \
  --shards 64
```

The adapter verifies the entire compressed source before parsing, rejects an
existing output directory, applies `heldout-v1.json` and the E4 certification
quarantine before role assignment, samples once per model-equivalence cluster,
and writes canonical NDJSON hashes/counts. The selection contract hashes the
wrapper, shared corpus logic, source policy, E4 validator, certification
manifest, and held-out manifest. Empty/undersized, malformed-heavy, or
role-incomplete runs fail closed. The output deliberately states
`finalFitAllowed: false`.

## Re-label one shard with the pinned teacher

Use the official external Stockfish 18 build. Record the archive, executable,
and NNUE hashes; do not vendor the GPL binary:

```sh
node test/training/label-stockfish.js \
  --input /data/chessy-e4-v1-selection/selection-000.ndjson \
  --selection-manifest /data/chessy-e4-v1-selection/manifest.json \
  --output /data/chessy-e4-v1-teacher/teacher-000.ndjson \
  --stockfish /opt/stockfish-18/stockfish
```

Teacher identity, executable/NNUE hashes, node limit, UCI options, score
eligibility, and POV conversion come only from the checked-in
`teacher-sf18-100kn-v1.json`; none can be supplied or retuned on the command
line. The labeler verifies the selection manifest's aggregate adapter,
corpus, E4 validator, source-policy, incident-holdout, and frozen certification
hashes, then verifies the selected shard hash and recomputes every record's ID,
canonical FEN, model cluster, position family, role, and shard assignment. A
pending/test-only certification selection is refused.

Each position gets `ucinewgame`, `Clear Hash`, and `isready`, with
`Threads=1`, `Hash=64`, `Ponder=false`, `MultiPV=1`, no Syzygy path, and WDL
enabled. Stockfish may cross the `go nodes 100000` boundary while an
aspiration-window line is still bounded. The adapter records that terminal
line as effort evidence, requires at least 100,000 reported nodes, and labels
only from the latest earlier unbounded exact-CP line with a 1,000-count WDL
triplet, valid depth, and a PV headed by the final `bestmove`. It records both
the score-line and terminal node counts. A mate report invalidates any earlier
CP unless a newer unbounded exact-CP line follows. CP and WDL are converted
exactly once from side-to-move to White POV.
Mixed upstream labels are removed from fit-ready rows; their source bytes and
selection provenance remain bound through the sidecar's input hashes.
Frozen startup, readiness, per-position, and shutdown watchdogs kill a wedged
teacher and remove the partial shard artifacts instead of hanging a run.

Eligible records are written in ID order to the requested file. Mate scores
and every other ineligible result go to
`teacher-000.ndjson.exclusions.ndjson`; they never reuse an earlier CP score.
`teacher-000.ndjson.manifest.json` binds the selection, output, exclusion
ledger, UCI transcript, and frozen teacher metadata by SHA-256. Output,
exclusion, and transcript files are streamed so shard labelling does not
accumulate them in memory.

## HCE R3

The Round-2 branch is historical infrastructure, not mergeable training
software: it materializes one JSON file and all features in memory, depends on
game outcomes, and has no symmetry/family isolation. R3 must salvage its
fidelity and explicit-apply principles onto current `main`, then pack
memory-mapped sparse shards and use a pinned convex solver.

The frozen R3 surface has the existing 753 identifiable terms plus 212
zero-default interaction terms:

- pawn attacks on enemy minor/rook/queen, tapered MG/EG;
- advanced pawn space/cramp on relative ranks 4/5/6, tapered MG/EG;
- king-bucketed pawn PST deltas, with the center king bucket as reference;
- safe mobility for N/B/R/Q as supporting evidence.

The 192 king-bucketed pawn-PST deltas use only the 48 reachable pawn squares
(relative ranks 2–7); the first/eighth ranks are structural pins, not fake
parameters. The full experimental vector is therefore 965 parameters.

All new weights regularize toward zero. The linear feature extractor, evaluator
candidate, and distinct-weight oracle must agree exactly before fitting.
Baseline is always a candidate; lambda zero is excluded; no runtime file is
edited by the fitter.

Generate the exact r69 Round-2 center plus zero-valued R3 centers and the
frozen regularization scales into a new external directory:

```sh
node test/training/hce-r3-baseline.js \
  --output-dir /data/chessy-hce-r3-baseline
```

The solver consumes only the authenticated `chessy.hce-csr.v2` format. It
checks the complete 965-column digest, `/24` taper contract, teacher and
selection hashes, center/scales value hashes, sorted row IDs, and disjoint
row/cluster/position-family sets. Matrix packing is frozen to NumPy 2.3.5 and
the convex fitter to NumPy 2.3.5 plus SciPy 1.17.0. R3.0 fixes safe mobility at zero. R3.1 is
eligible only if zeroing safe mobility still beats baseline and retains at
least half of the candidate's validation gain.

Pack one role from all of its authenticated teacher shards. Repeat `--input`
for each shard; the packer performs a bounded-memory global ID merge:

```sh
python3 tools/training/pack-hce.py \
  --input /data/teacher/teacher-000.ndjson \
  --input /data/teacher/teacher-001.ndjson \
  --role shared-train \
  --center /data/chessy-hce-r3-baseline/center.json \
  --scales /data/chessy-hce-r3-baseline/scales.json \
  --output /data/hce/shared-train.npz
```

`hce-r3-linear.test.js` reconstructs the shipped evaluator exactly over a
legal-position trajectory before the packer is admitted. The exact integer
round/polish, untouched-test opener, and runtime candidate/apply path remain
deliberately separate, so a float fit still cannot be treated as shippable.

Run the preregistered R3.0/R3.1 convex screen:

```sh
python3 tools/training/hce-fit.py \
  --train /data/hce/shared-train.npz \
  --validation /data/hce/hce-validation.npz \
  --center /data/chessy-hce-r3-baseline/center.json \
  --scales /data/chessy-hce-r3-baseline/scales.json \
  --output /data/hce/r3-float-candidate.json
```

## NNUE G0/G1

`nnue-v1-architecture.json` freezes 12 colored piece planes × 64 squares,
White/Black perspectives, accumulator order, three seeds, and the
H64-SCReLU/H64-CReLU/H128-SCReLU screen. The custom MIT trainer is
`tools/training/train-nnue.py`; it uses only the permissively licensed PyTorch
2.7.1 development dependency and refuses test roles. Every labelled shard must keep
its adjacent `.manifest.json` sidecar. Before importing PyTorch, the trainer
checks each shard's byte hash and row count, the frozen Stockfish manifest and
both embedded networks, exact role membership, sorted/unique record IDs,
recomputed corpus keys, and the locked incident quarantine.

The G1 head is an expected-score logit, not a falsely labelled centipawn score.
G2 must fit and freeze its logit-to-centipawn scale on `nnue-validation` before
quantization or search integration.

Example research run:

```sh
python3 tools/training/train-nnue.py \
  --train /data/teacher/train-*.ndjson \
  --validation /data/teacher/nnue-validation-*.ndjson \
  --architecture h64-screlu \
  --seed 10501 \
  --device cpu \
  --output /data/checkpoints/h64-screlu-seed10501.pt
```

`--train` and `--validation` each accept one or more paths, so the shell-expanded
globs above pass every shard under the corresponding option. Repeat either
option if the inputs span multiple directories. To validate all sidecars and
records without installing or importing PyTorch, run the same shard arguments
with `--validate-inputs` and omit the architecture, seed, device, and output.
CI exercises this PyTorch-free trust-boundary mode; a full PyTorch training
execution is not yet exercised in CI.

Run all three frozen seeds. Architecture selection uses the median validation
run, not the luckiest run. H128 may be trained for evidence but cannot ship
unless #84 admits its fixed-memory/device cost. Quantization/export is G2;
incremental Rust/WASM accumulator integration is G3 and remains blocked on
#84.

## Repository and license policy

`source-manifest.json` is the machine allowlist and `DATASETS.md` is the audit.
Dataset licenses do not become MIT merely because the pipeline code is MIT.
Only manifests, contracts, and small authored smoke fixtures belong in Git.
Raw archives, selected shards, labels, checkpoints, logs, and teacher
executables remain external.
