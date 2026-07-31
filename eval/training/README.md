# HCE R3 and NNUE training foundation

This directory prepares one license-clean teacher corpus for the final HCE
attempt in #137 and NNUE G0-G2 in #105. It does not change Chessy's evaluator,
search, level budgets, Rust/WASM asset, or release token. The historical r69
evaluator remains the held-out incident evidence source; the
behavior-equivalent shipped r71 evaluator is the current E4/training baseline,
and `--require-fix` remains opt-in.

The current work stops before any production fit, candidate weight, model
artifact, or runtime integration. CI exercises a tiny real-Stockfish sample,
but a production corpus freeze still needs the literal Lichess snapshot
SHA-256 and an external corpus-scale Stockfish run; those large artifacts are
intentionally not stored in Git.

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
6. If r71 certifies at Master strength, retain `11...Bd4` as a known
   master-level mistake. Master strength is not perfect Stockfish play.
7. If r71 fails certification, stop the 2300+ claim. If HCE R3 fails untouched
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
training. The separately preregistered CC0 PGN opening source supplies complete
states and opaque source-game grouping for E4 opening selection. That PGN
lineage cannot establish lineage for the Bd4 incident: its fixture is a local
Chessy offline-PWA regression record, not an authenticated Lichess game.
Same-source-game incident quarantine therefore remains explicitly pending,
not enforced, until the incident itself has authenticated lineage.
Static-FEN-only fits may exercise the research pipeline but are
policy-ineligible for public artifact release until that lineage condition is
satisfied; no executable release gate currently consumes this policy.
The incident cluster and broader structural family are enforced now, so a
training record for the position is rejected regardless of its label budget.
The nearby budgets are already preregistered at 8,268,594 and 10,106,060
nodes; only their post-fit execution evidence and results remain pending.
Upstream mixed Stockfish labels are sampling evidence only.

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
and writes canonical NDJSON hashes/counts. An exclusive output-prefix lock
serializes cooperating producers, and each run writes to a unique staging
directory before the completed directory is renamed into place. A handled
failure removes only that run's staging directory and releases its lock. An
abrupt process termination can leave owned staging or a lock behind; inspect
and remove those incomplete paths before retrying rather than treating them as
a completed selection. The selection contract hashes the wrapper, shared
corpus logic, source policy, E4 validator, certification manifest, and
held-out manifest. Empty/undersized, malformed-heavy, or role-incomplete runs
fail closed. The output deliberately states `finalFitAllowed: false`.

## Re-label one shard with the pinned teacher

Use the official external Stockfish 18 build. Record the archive, executable,
and NNUE hashes; do not vendor the GPL binary:

Before spending corpus-scale compute, run the real teacher admission smoke:

```sh
node test/training/smoke-stockfish.js \
  --archive /data/stockfish-ubuntu-x86-64-avx2.tar \
  --stockfish /opt/stockfish-18/stockfish \
  --output /data/smoke/sf18-100kn
```

The smoke refuses overrides and verifies the checked-in archive and executable
SHA-256 values, exports and hashes both embedded NNUEs, then drives the same
UCI initialization, watchdog, `go nodes 100000`, parser, and exact-score
eligibility path used by the production labeler. It commits
`sf18-100kn.uci.log` and then `sf18-100kn.provenance.json`, each atomically and
without replacement. The provenance file is the last-written pass/failure
commit marker; consumers must require it and verify its transcript SHA-256
rather than treating the two files as an atomic transaction. The provenance
records both the exact score-line nodes and the terminal reported nodes,
because an eligible exact CP/WDL line can precede a bounded terminal line that
crosses 100,000 nodes. It also records platform/runtime metadata. A failed
engine/network smoke exits nonzero while retaining handled-failure provenance
and transcript diagnostics. An exclusive prefix lock plus no-replace hard-link
commits prevent concurrent or later runs from replacing existing evidence.
Exported GPL network files live in a system-temporary directory outside CI's
explicit artifact allowlist and are removed on handled success or failure; an
abrupt process kill therefore cannot make CI upload those network files with
partial smoke evidence.

Before corpus-scale work, exercise the selection, real-teacher, mixed-role
validation, and HCE feature-stream boundaries with a small external fixture:

```sh
node test/training/generate-training-sample.js \
  --stockfish /opt/stockfish-18/stockfish \
  --output /data/chessy-training-sample \
  --profile preliminary
```

The explicit immutable `preliminary` profile creates all 40 distinct
checked-in CC0 opening-family records, with exact role counts
`18/4/9/2/7` for shared-train, HCE validation/test, and NNUE
validation/test. Omitting `--profile` retains the faster 10-row smoke profile
with two records per role for local/debug runs. Both are encoded in the
accepted evaluation wire format. The selection manifest and every
selection/teacher
row identify the source as
`chessy-training-mechanism-fixture`, carry the exact non-fit fixture marker,
and use a fixture-placeholder exploration teacher; they never claim the
official Lichess evaluation snapshot or mixed-Lichess teacher identity. The
generator uses the checked-in `awaiting-opening-freeze` certification
template, runs selection, labels every row with the real pinned Stockfish
teacher, validates the resulting mixed-role shard through the NNUE input
boundary, and extracts the profile's exact `shared-train` and
`hce-validation` HCE feature inventories. In the preliminary profile the
pinned teacher deterministically excludes one shared-train position because
its final best move does not head the last eligible exact-score PV, leaving
exact labelled counts `17/4/9/2/7`; preserving that
`bestmove-pv-mismatch` exercises the real exclusion ledger without post-hoc
substitution. Any other selection, labelled, or exclusion inventory fails the
run. The default smoke profile remains exactly 10 labelled rows and zero
exclusions.

The preliminary profile may additionally exercise packing and the frozen
convex solver math without crossing the production fit boundary:

```sh
python -m pip install 'numpy==2.3.5' 'scipy==1.17.0'
node test/training/hce-r3-baseline.js \
  --output-dir /data/chessy-hce-r3-baseline
python tools/training/sample-hce-convex.py \
  --sample-manifest /data/chessy-training-sample/sample-manifest.json \
  --center /data/chessy-hce-r3-baseline/center.json \
  --scales /data/chessy-hce-r3-baseline/scales.json \
  --output /data/chessy-training-sample/preliminary-convex-diagnostic.json
```

That separate diagnostic accepts only the exact 40-row preliminary sample,
authenticates both feature files and adjacent sidecars, and requires
train/validation row, cluster, and position-family disjointness. It evaluates
the preregistered R3.0/R3.1 lambda grid on only 17 fit and four validation
rows but emits metrics and hashes only: no weights, selected lambda, candidate,
or test result. Those 21 rows support no quality inference. Its output remains
`sample-only`, `fitAllowed: false`, and non-publishable. The production NPZ
packer and fitter continue to reject the sample disposition.

Fixture state is carried in the selection manifest, teacher sidecar, NNUE
report, and HCE stream summary as `sample-only-not-fit-eligible`. Production
label, train, and pack entry points reject it; the explicit sample override is
validation-only and cannot run NNUE training or production HCE
packing/fitting. The sample diagnostic is a bounded, explicitly separate
mechanism path; it cannot create a production matrix or fit artifact.

`sample-manifest.json` is written last and is the sole completion marker;
consumers must treat a sample directory without it as incomplete. On handled
failure the generator removes its sample directory. An abrupt termination may
leave an incomplete directory that requires inspection and manual cleanup.
CI uploads only the non-replayable sample summary and weight-free convex
diagnostic—not the generated labels, features, transcript, or detached
internal sidecars. They are mechanism-status records, not standalone evidence
of the teacher run whose artifacts they hash. The fixture is neither an
official Lichess evaluation snapshot nor a production opening freeze.

Only after that admission succeeds, label the frozen selection:

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
teacher and remove that run's temporary shard artifacts on handled failure
instead of hanging a run.

Eligible records are written in ID order to the requested file. Mate scores
and every other ineligible result go to
`teacher-000.ndjson.exclusions.ndjson`; they never reuse an earlier CP score.
`teacher-000.ndjson.manifest.json` binds the selection, output, exclusion
ledger, UCI transcript, and frozen teacher metadata by SHA-256. Output,
exclusion, and transcript files are streamed so shard labelling does not
accumulate them in memory. An exclusive output-prefix lock serializes
cooperating producers. Publication is no-replace per file: output, exclusion
ledger, and transcript are committed first, and the sidecar is committed last
as the completion marker. Consumers must require the sidecar and verify every
bound hash; the earlier files alone are not a completed shard. An abrupt
termination can leave some final files and/or the lock behind. Inspect that
prefix, remove only the incomplete run's files and stale lock, then retry; the
labeler does not automatically delete final paths because they may belong to a
concurrent winner.

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

Generate the exact r71 baseline Round-2 center plus zero-valued R3 centers and
the frozen regularization scales into a new external directory. The generator
strictly parses the typed integer declarations in
`experiments/wasm/src/eval.rs`; it does not restore or execute a JavaScript
runtime evaluator:

```sh
node test/training/hce-r3-baseline.js \
  --output-dir /data/chessy-hce-r3-baseline
```

The solver consumes only the authenticated `chessy.hce-csr.v2` format. It
checks the complete 965-column digest, `/24` taper contract, teacher, literal
selection-manifest, selection-contract, and source-snapshot hashes,
center/scales value hashes, the exact `authenticated-production-input`
disposition, sorted row IDs, and disjoint row/cluster/position-family sets.
The packed sidecar also binds the affine extractor, baseline extractor, Rust
evaluator source, and shipped WASM bytes by SHA-256; the fitter rehashes each
before candidate publication.
That disposition authenticates a production-mode input; it does not assert
that every later fit or release gate has passed. Each packed sidecar enumerates
exactly the provided teacher shards and their adjacent sidecars plus the
selected input shards they bind; it does not overclaim full-corpus coverage.
Immediately before publishing a float candidate, the fitter rehashes both
validated NPZ files, both adjacent sidecars, center/scales files, and every
fitter, packer, extractor, evaluator, and contract input against the digests
retained when they were authenticated, and refuses any replacement. The
candidate is first serialized and fsynced to a same-directory temporary file,
then published with a no-replace hard link after that final rehash. Failed
serialization, writing, or rehashing leaves no final candidate path. Matrix
packing is frozen to NumPy 2.3.5 and the convex fitter to NumPy 2.3.5 plus
SciPy 1.17.0.
R3.0 fixes safe mobility at zero. R3.1 is eligible only if zeroing safe
mobility still beats baseline and retains at least half of the candidate's
validation gain.

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

`hce-r3-linear.test.js` reconstructs the shipped Rust/WASM evaluator exactly
over a legal-position trajectory before the packer is admitted. The exact
integer round/polish, untouched-test opener, and runtime candidate/apply path
remain deliberately separate, so a float fit still cannot be treated as
shippable.

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

Selection shards normally contain all five roles. A physical mixed-role
teacher shard may be supplied under both `--train` and `--validation`: it is
authenticated and fully validated once, then only `shared-train` records enter
the training stream and only `nnue-validation` records enter the validation
stream. HCE and test records remain validated but are never consumed by NNUE.
Both options must name the complete declared teacher-shard inventory; using
complementary subsets is rejected because it could silently omit a role from a
physical mixed-role shard. The report records complete per-role physical
counts plus each stream's selected count.

Validation hashes and fully checks records from one retained file descriptor,
so replacing a shard pathname cannot substitute different bytes between those
steps. A training run additionally copies each shard, with bounded memory, to
an unlinked temporary snapshot in the checkpoint directory. Every epoch
rewinds and rehashes those same authenticated bytes; it never reopens an input
pathname. Allow one teacher-corpus-sized block of temporary space on the
checkpoint filesystem. Snapshots are closed and removed on success or failure.
`--validate-inputs` avoids that corpus-sized copy, retains the authenticated
descriptors only through report generation, and then closes them.

The trainer also captures the configuration, architecture, trainer source,
teacher, held-out, and corpus-contract hashes before fitting. The model card
uses those captured hashes, and the files, all input sidecars, selection
manifests/shards, and immutable teacher snapshots are checked again under the
output lock immediately before atomic checkpoint/model-card publication.

The G1 head is an expected-score logit, not a falsely labelled centipawn score.
G2 must fit and freeze its logit-to-centipawn scale on `nnue-validation` before
quantization or search integration.

Example research run:

```sh
python3 tools/training/train-nnue.py \
  --train /data/teacher/teacher-*.ndjson \
  --validation /data/teacher/teacher-*.ndjson \
  --architecture h64-screlu \
  --seed 10501 \
  --device cpu \
  --output /data/checkpoints/h64-screlu-seed10501.pt
```

`--train` and `--validation` each accept one or more paths, so the shell-expanded
globs above pass the same complete mixed-role inventory under both options.
Repeat either option if the inputs span multiple directories, preserving that
complete inventory in each stream. To validate all sidecars and records without
installing or importing PyTorch, run the same shard arguments with
`--validate-inputs` and omit the architecture, seed, device, and output.
CI byte-compiles the complete trainer and runs `--self-test`, which exercises
FEN parsing, exact feature maps, symmetry/role derivation, deterministic
shuffle/batching, generated authenticated train/validation shards, provenance
propagation, and post-validation mutation refusal without importing PyTorch.
A production-shard validation run and a full PyTorch training execution are
not yet exercised in CI.

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

`DATASETS.md` records the working release position for Stockfish-generated
output. In short, numeric output is not presumed GPL-covered merely because a
GPL program generated it, absent copied protectable program material; binary
GPL obligations and input-dataset rights are separate. This is not legal
advice. Generated label corpora, HCE parameters, and NNUE checkpoints require
preserved provenance, an explicit artifact-license decision, and legal review
before public release—the repository's MIT license is not automatic.
