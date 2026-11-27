# HCE R3 and NNUE training foundation

[Home](../../README.md) · [Evaluation](../README.md) · [Data sources](DATASETS.md)

This guide covers the frozen training foundation for HCE (handcrafted
evaluation) [#137](https://github.com/den-run-ai/chessy/issues/137) and NNUE
[#105](https://github.com/den-run-ai/chessy/issues/105). Both use one licensed
teacher corpus with separate validation and test roles. These tools do not
apply weights to the runtime or change difficulty budgets.

The foundation pins the behavior-equivalent r71 evaluator as its E4/training
baseline and keeps historical r69 as the locked incident evidence source.
These are protocol identities, not the current app release. The incident's
`--require-fix` check remains opt-in.

Production corpus freezing still requires the literal Lichess snapshot SHA-256
and an external corpus-scale Stockfish run. CI exercises small real-teacher
fixtures; those fixtures cannot produce a production fit or release artifact.
For later research reports, see the [evaluation index](../README.md#research-index).

## Workflow

Run commands from the repository root and keep large inputs and outputs
outside Git. Read the [source/license policy](DATASETS.md) before acquiring data.

| Stage | Guide |
| --- | --- |
| Prerequisites and stop rules | [Predeclared sequence](#predeclared-sequence) |
| Grouping and leakage controls | [Data flow](#data-flow) |
| Source selection | [Deterministic selection](#build-a-deterministic-multi-million-selection) |
| Teacher and pipeline smoke checks | [Admission checks](#teacher-admission-and-sample-checks) |
| Production labels | [Label one shard](#re-label-one-shard-with-the-pinned-teacher) |
| Convex handcrafted evaluation | [HCE R3](#hce-r3) |
| Neural evaluation | [NNUE G0/G1](#nnue-g0g1) |
| Execution and publication boundaries | [Trusted runners](#trusted-runner-and-publication) |
| Restore omitted sparse-refit research inputs | [Thin-bundle restoration](../../tools/eval_pipeline/BUILD.md#restore-omitted-refit-inputs-from-a-thin-bundle) |

The separately recorded evaluator production study has a thin evidence bundle
that preserves both cost-aware refits while omitting duplicate bulk inputs.
Its [restoration helper](../../tools/eval_pipeline/restore_refit_inputs.py)
authenticates the original train/validation data, reconstructs exact packed
features through the retained extractor, and verifies the complete 49-file
study inventory. It preserves the fitted models and reads no holdout data.
See the linked guide for prerequisites and commands; restored research evidence
does not change a model's production or playing-strength admission.

## Predeclared sequence

1. Freeze the E4-v1 adapter/manifests and corpus contracts before games or labels.
2. Complete [#84](https://github.com/den-run-ai/chessy/issues/84)'s device,
   offline, watchdog, memory, battery, and thermal baseline.
3. Certify Master first: 800 untouched opening clusters, both colors, 1,600
   games. The one-sided 95% rating lower bound must reach 2300 on the pinned
   Stockfish 18 UCI-Elo scale.
4. Run HCE R3.0/R3.1 once with the preregistered representation. Select lambda
   only on `hce-validation`, then open `hce-test` once.
5. Only a broadly validated candidate may run the locked `11...e4` post-fit
   gate. It must choose `e5e4` at 9,187,327 nodes and stably at the registered
   nearby budgets of 8,268,594 and 10,106,060 nodes, then pass parity,
   scorecard, device, and strength gates.
6. If r71 certifies, retain `11...Bd4` as a known master-level mistake. If r71
   fails, stop the 2300+ claim.
7. If HCE fails untouched transfer or the locked gate, stop HCE and continue
   NNUE. Do not change features, lambda, budgets, FENs, or weights after the
   result to rescue that attempt.

The [E4 freeze guide](../e4/README.md) describes the opening prerequisites.
A successful preparation step is not a certification result.

## Data flow

The pipeline authenticates a CC0 Lichess snapshot, streams candidate positions,
quarantines incident/certification families, assigns five deterministic roles,
and relabels each shard with pinned Stockfish 18. The resulting records feed
HCE sparse features or NNUE's 768 input features.

| Role | Planned records | Permitted use |
| --- | ---: | --- |
| `shared-train` | 2,100,000 | HCE and NNUE fitting |
| `hce-validation` | 450,000 | HCE lambda/candidate selection |
| `hce-test` | 450,000 | One-time HCE transfer decision |
| `nnue-validation` | 450,000 | NNUE architecture/run selection |
| `nnue-test` | 450,000 | One-time NNUE transfer decision |

Model-equivalent boards and legal color/rank/file symmetries stay together,
even when side, castling, or en-passant FEN fields differ. The coarser
pawn-map/king-square/material family hash assigns roles and caps each family
at 64 selected positions. HCE selection cannot consume NNUE's holdout.

### Source and incident limits

The static Lichess export lacks game lineage and halfmove/fullmove state. It
supports static evaluation fitting, not repetition or fifty-move training.
The separate CC0 PGN source supplies complete E4 opening states and opaque
game grouping, but cannot establish lineage for the local Chessy `Bd4`
incident. Same-source-game incident quarantine remains pending until the
incident itself has authenticated lineage.

Incident board clusters and broader structural families are already excluded,
regardless of label budget. Static-FEN fits may exercise the research pipeline
but remain policy-ineligible for public artifact release until lineage is
resolved; no executable release gate currently enforces that policy. Nearby
incident budgets are registered above, but their post-fit results are pending.
Mixed upstream Stockfish labels are used only for sampling.

## Build a deterministic multi-million selection

Retain the evaluated-position archive outside Git and compute its SHA-256.
A 1/100 hash sample is expected to yield about 3.9 million records, depending
on the snapshot and filters. Production selection requires a literally frozen
E4 certification manifest and excludes its board-equivalence clusters and
position families before sampling.

Replace the source digest and retrieval date with those of the retained input:

```sh
node test/training/prepare-lichess-evals.js \
  --input /data/lichess_db_eval.jsonl.zst \
  --source-sha256 REPLACE_WITH_64_HEX_SOURCE_SHA256 \
  --retrieved 2026-07-29 \
  --certification-manifest /data/e4-certification-frozen.json \
  --output /data/chessy-e4-v1-selection \
  --modulus 100 \
  --numerator 1 \
  --family-cap 64 \
  --shards 64
```

The adapter authenticates the compressed source before parsing, applies
`heldout-v1.json` and certification quarantine before role assignment, samples
once per model-equivalence cluster, and writes canonical NDJSON hashes/counts.
Its selection contract binds the wrapper, shared corpus logic, source policy,
E4 validator, certification manifest, and incident-holdout manifest.

Existing output directories and empty, undersized, malformed-heavy, or
role-incomplete selections are rejected. The output states
`finalFitAllowed: false`; successful selection is not fit approval.

## Teacher admission and sample checks

Use the official external Stockfish 18 build and retain its archive,
executable, and embedded-network hashes. Do not vendor the GPL executable.

### Verify the real teacher

Run the admission smoke before corpus-scale work:

```sh
node test/training/smoke-stockfish.js \
  --archive /data/stockfish-ubuntu-x86-64-avx2.tar \
  --stockfish /opt/stockfish-18/stockfish \
  --output /data/smoke/sf18-100kn
```

The smoke refuses overrides, verifies the pinned archive/executable hashes,
exports and hashes both embedded networks, and uses the production labeler's
UCI initialization, watchdog, 100,000-node request, parser, and exact-score
eligibility rules. Provenance records score-line nodes separately from
terminal nodes, plus platform/runtime metadata. A handled engine/network
failure exits nonzero and retains its diagnostic transcript and provenance.

### Exercise the small pipeline fixture

```sh
node test/training/generate-training-sample.js \
  --stockfish /opt/stockfish-18/stockfish \
  --output /data/chessy-training-sample \
  --profile preliminary
```

The fixture exercises selection, real-teacher labels, mixed-role NNUE input
validation, and HCE feature extraction. Its immutable profiles are:

| Profile | Selected roles: train / HCE val / HCE test / NNUE val / NNUE test | Label outcome |
| --- | --- | --- |
| Default smoke (omit `--profile`) | 2 / 2 / 2 / 2 / 2 | 10 labels, zero exclusions |
| `preliminary` | 18 / 4 / 9 / 2 / 7 | 17 / 4 / 9 / 2 / 7 labels; one train exclusion |

The preliminary fixture uses all 40 checked-in CC0 opening-family records.
Its one `bestmove-pv-mismatch` is preserved: the teacher's final best move does
not head the last eligible exact-score line. Any different selection, label,
or exclusion inventory fails the run.

Both profiles use the accepted wire format, the
`chessy-training-mechanism-fixture` source, a fixture-placeholder exploration
teacher, and the pending `awaiting-opening-freeze` certification template.
They do not represent an official Lichess snapshot or production opening
freeze. Exact sample markers propagate through selection, teacher, NNUE, and
HCE summaries as `sample-only-not-fit-eligible`.

### Exercise convex solver mechanics

The preliminary profile can test packing and the frozen solver math:

```sh
python3 -m pip install 'numpy==2.3.5' 'scipy==1.17.0'
node test/training/hce-r3-baseline.js \
  --output-dir /data/chessy-hce-r3-baseline
python3 tools/training/sample-hce-convex.py \
  --sample-manifest /data/chessy-training-sample/sample-manifest.json \
  --center /data/chessy-hce-r3-baseline/center.json \
  --scales /data/chessy-hce-r3-baseline/scales.json \
  --output /data/chessy-training-sample/preliminary-convex-diagnostic.json
```

This path accepts only the exact preliminary sample, authenticates feature
files/sidecars, and requires disjoint train/validation rows, clusters, and
families. It evaluates the registered R3.0/R3.1 lambda grid on 17 fit and four
validation rows. Output contains only metrics and hashes: no weights, selected
lambda, candidate, or test result. These 21 rows support no quality inference.

The diagnostic remains `sample-only`, `fitAllowed: false`, and non-publishable.
Production label, train, pack, and fit entry points reject sample disposition;
the explicit sample override permits validation only. CI uploads the sample
summary and weight-free convex diagnostic, excluding labels, features,
transcripts, and internal sidecars. Those summaries describe mechanism status
and cannot independently replay the teacher evidence they hash.

## Re-label one shard with the pinned teacher

After admission, label a frozen production selection:

```sh
node test/training/label-stockfish.js \
  --input /data/chessy-e4-v1-selection/selection-000.ndjson \
  --selection-manifest /data/chessy-e4-v1-selection/manifest.json \
  --output /data/chessy-e4-v1-teacher/teacher-000.ndjson \
  --stockfish /opt/stockfish-18/stockfish
```

[`teacher-sf18-100kn-v1.json`](teacher-sf18-100kn-v1.json) fixes teacher identity,
executable/network hashes, node limit, UCI options, score eligibility, and
perspective conversion. The CLI cannot retune them. Admission verifies all
selection-contract hashes, then the shard bytes and every row's ID, canonical
FEN, model cluster, family, role, and shard assignment. Pending or test-only
certification selections are refused.

Each position receives `ucinewgame`, `Clear Hash`, and `isready`, with
`Threads=1`, `Hash=64`, `Ponder=false`, `MultiPV=1`, no Syzygy path, and WDL
output enabled. Frozen startup, readiness, position, and shutdown watchdogs
terminate a wedged teacher and remove that run's temporary shard files on
handled failure.

### Label eligibility

Stockfish can cross `go nodes 100000` while its last line is still bounded.
The adapter requires at least 100,000 terminal reported nodes and labels from
the latest unbounded exact-centipawn line that has valid depth, a 1,000-count
WDL triplet, and a principal variation headed by the final `bestmove`.
Score-line and terminal node counts are both retained. A mate report
invalidates earlier centipawns unless a later unbounded exact-CP line follows.
CP/WDL convert exactly once from side-to-move to White's perspective.

Accepted rows are streamed in ID order. Ineligible results, including mate
scores, enter `teacher-000.ndjson.exclusions.ndjson`; no stale CP is reused.
Mixed upstream labels are removed from fit-ready rows, while source bytes and
selection provenance remain hash-bound. The adjacent `.manifest.json` binds
the selection, output, exclusion ledger, UCI transcript, and frozen metadata.

### Verify complete teacher evidence

HCE and NNUE require each shard's actual exclusion ledger and complete UCI
transcript. Shared `teacher-evidence.js` admission consumes the same retained
bytes it authenticates and accounts for every selected ID exactly once in
labels or exclusions. It replays UCI options, resets, FENs, and budgets through
the score reducer, reconstructing each label/exclusion and reason inventory.
Missing evidence, substituted fields, rehashed omissions, or inconsistent
labels fail before fitting.

This proves retained evidence consistency within the trusted runner. A
coherently fabricated transcript is not cryptographic proof that Stockfish
ran. Licensing, frozen selection, registration, device, and strength gates
remain separate.

## HCE R3

The historical Round-2 branch materializes all features in memory, depends on
game outcomes, and lacks symmetry/family isolation. R3 retains its exact
feature reconstruction and explicit application principles while using sparse
shards and a pinned convex solver.

### Frozen representation

The vector has 753 existing identifiable terms plus 212 zero-default
interaction terms, for 965 parameters:

- Pawn attacks on enemy minor pieces, rooks, and queens, tapered by phase.
- Advanced pawn space/cramp on relative ranks 4–6, tapered by phase.
- King-bucketed pawn piece-square deltas, with the center king bucket as reference.
- Safe mobility for knights, bishops, rooks, and queens as supporting evidence.

The 192 king-bucketed pawn deltas cover the 48 reachable squares on relative
ranks 2–7; ranks 1 and 8 are structural pins. New weights regularize toward
zero. The baseline remains a candidate, lambda zero is excluded, and the
extractor, evaluator candidate, and distinct-weight oracle must agree exactly.
R3.0 fixes safe mobility at zero. R3.1 is eligible only if removing safe
mobility still beats baseline and preserves at least half the validation gain.

### Generate, pack, and fit

Generate the r71 Round-2 center, zero R3 centers, and frozen scales in a new
external directory. The generator parses typed integer declarations in the
Rust evaluator; it does not execute a JavaScript evaluator.

```sh
node test/training/hce-r3-baseline.js \
  --output-dir /data/chessy-hce-r3-baseline
```

Pack one role from all authenticated teacher shards. Repeat `--input` for
each shard; packing merges globally sorted IDs with bounded memory.

```sh
python3 tools/training/pack-hce.py \
  --input /data/teacher/teacher-000.ndjson \
  --input /data/teacher/teacher-001.ndjson \
  --role shared-train \
  --center /data/chessy-hce-r3-baseline/center.json \
  --scales /data/chessy-hce-r3-baseline/scales.json \
  --output /data/hce/shared-train.npz
```

Repeat for `hce-validation`, then run the registered R3.0/R3.1 convex screen:

```sh
python3 tools/training/hce-fit.py \
  --train /data/hce/shared-train.npz \
  --validation /data/hce/hce-validation.npz \
  --center /data/chessy-hce-r3-baseline/center.json \
  --scales /data/chessy-hce-r3-baseline/scales.json \
  --output /data/hce/r3-float-candidate.json
```

Packing is pinned to NumPy 2.3.5; fitting additionally requires SciPy 1.17.0.
`hce-r3-linear.test.js` reconstructs the Rust/WASM evaluator exactly across a
legal-position trajectory before packer admission.

### Matrix and candidate contract

The fitter accepts only authenticated `chessy.hce-csr.v2` inputs. It checks
the 965-column digest, `/24` taper, teacher, literal selection manifest,
selection contract, source snapshot, center/scales values, sorted row IDs,
and disjoint row/cluster/family sets. The required
`authenticated-production-input` disposition authenticates input mode, not
completion of later fit or release gates.

Each packed sidecar lists exactly the supplied teacher shards, their
sidecars, and their bound selected inputs. It also binds the affine/baseline
extractors, Rust evaluator source, and shipped WASM. Before publication the
fitter rehashes both NPZ files and sidecars, center/scales, and all retained
fitter/packer/extractor/evaluator/contract inputs, rejecting replacement.

Float output is not a shipping candidate. Integer rounding/polishing, the
untouched test opener, and runtime candidate/application remain separate;
the fitter edits no runtime file.

## NNUE G0/G1

[`nnue-v1-architecture.json`](nnue-v1-architecture.json) freezes 12 colored
piece planes × 64 squares, both perspectives, accumulator order, three seeds,
and the H64-SCReLU/H64-CReLU/H128-SCReLU screen. The MIT trainer
`tools/training/train-nnue.py` uses PyTorch 2.7.1 as a development dependency.
Its G1 output is an expected-score logit. G2 must fit/freeze a logit-to-centipawn
scale on `nnue-validation` before quantization or search integration.

### Input admission

Before importing PyTorch, the trainer validates shard hashes/counts, the
Stockfish manifest and both networks, exact roles, sorted/unique IDs,
recomputed corpus keys, and incident quarantine. Every shard needs its
adjacent `.manifest.json` and the complete teacher evidence described above.

Node is required even for Python input validation. Through
`test/training/validate-selection-admission.js`, the trainer invokes
`Label.validateSelectionManifest()` and `E4.validateCertificationManifest()`
on the same retained bytes it authenticated. It compares identities and
quarantine keys and retains validator/dependency hashes for publication.
Aggregate hashes, empty certification, or rehashed source/schedule/control
changes cannot replace the canonical contracts. Sample mode requires the
complete pending template and remains validation-only.

### Run or validate

Selection shards normally mix all five roles. Both `--train` and
`--validation` must name the complete declared physical shard inventory;
complementary subsets are rejected. Each shard is fully authenticated once,
then only `shared-train` enters fitting and only `nnue-validation` enters
validation. Other roles remain validated and are never used for NNUE fitting
or selection. Reports include all physical role counts and selected counts.

```sh
python3 tools/training/train-nnue.py \
  --train /data/teacher/teacher-*.ndjson \
  --validation /data/teacher/teacher-*.ndjson \
  --architecture h64-screlu \
  --seed 10501 \
  --device cpu \
  --output /data/checkpoints/h64-screlu-seed10501.pt
```

Each option accepts multiple paths; repeat it for additional directories while
preserving the full inventory under both options. For validation without
PyTorch, use the same shard arguments with `--validate-inputs` and omit
architecture, seed, device, and output.

Run all three frozen seeds and select by the median validation run. H128 may
be trained for evidence but requires #84's fixed-memory/device admission to
ship. Quantization/export is G2; Rust/WASM incremental integration is G3 and
remains blocked on #84.

### Retained inputs and CI coverage

Validation hashes and parses one retained descriptor per input. Training also
copies each shard with bounded memory into an unlinked temporary snapshot in
the checkpoint directory. Each epoch rewinds and rehashes that snapshot,
never reopening the input pathname. Allow temporary space for one teacher
corpus; snapshots close on success/failure. `--validate-inputs` avoids the
corpus-sized copy and closes descriptors after report generation.

The model card uses configuration, architecture, trainer, teacher, holdout,
and corpus-contract hashes captured before training. Publication rechecks
those files, sidecars, selection manifests/shards, retained snapshots, and
validator dependencies under the output lock.

CI byte-compiles the trainer and runs `--self-test` without PyTorch. It covers
FEN/features, symmetry/roles, deterministic batching, generated authenticated
shards, provenance, and post-validation mutation refusal. Production-shard
validation and a full PyTorch training run are not yet exercised in CI.

## Trusted runner and publication

Run admission, labeling, fitting, and publication in a fresh isolated OS
account with a fixed checkout and trusted Node/Python executables. Retained
descriptors and private snapshots protect against pathname replacement and
ordinary concurrent writers. They do not defend against a hostile same-user
process, debugger, or root access that can alter inodes or interpreter memory.

Cooperating producers use exclusive output locks and refuse replacement.
Completion has a specific meaning for each artifact:

| Output | Completion boundary |
| --- | --- |
| Selection | A unique staging directory is renamed into a new final directory |
| Teacher smoke | `sf18-100kn.uci.log` first; `.provenance.json` last, binding the transcript hash |
| Sample | `sample-manifest.json` last; a directory without it is incomplete |
| Label shard | Labels, exclusions, and transcript first; `.manifest.json` last, binding every hash |
| HCE float candidate | Serialize/fsync a same-directory temporary file, rehash all inputs, then publish with a no-replace hard link |
| NNUE checkpoint/card | Recheck captured inputs under the output lock before atomic publication |

Separate files are not a single atomic transaction. Consumers must require
the final marker and verify its bound hashes. Handled failures remove only
the failing run's owned temporary paths; an abrupt termination can leave
incomplete files or stale locks. Inspect them before cleanup/retry and never
remove a concurrent winner's files. Failed HCE serialization, writing, or
rehashing leaves no final candidate path.

Exported GPL networks from the smoke live in a system-temporary directory
outside CI's upload allowlist and are removed on handled success/failure.
An abrupt kill cannot add them to CI's explicit evidence upload set.

## Repository and license policy

[`source-manifest.json`](source-manifest.json) is the source allowlist;
[DATASETS.md](DATASETS.md) records the license audit and working release policy.
Only manifests, contracts, and small authored smoke fixtures belong in Git.
Keep raw archives, shards, labels, checkpoints, logs, and teacher executables
external.

Dataset rights, Stockfish binary obligations, and generated-output licensing
are separate. Numeric output is not presumed GPL-covered merely because
Stockfish generated it, absent copied protectable program material. Public
label corpora, HCE parameters, and NNUE checkpoints still require provenance,
an explicit artifact-license decision, and the legal review specified in
DATASETS.md. The repository's MIT license does not automatically cover them.
