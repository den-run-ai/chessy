# Current-production evaluator artifacts

`prepare.py` embeds the previously selected sparse PeSTO model by default into
a retained copy of the current production Rust crate. A separate explicit
option accepts a completed, eligible family refit. The resulting modules use the real
ABI v2, including seeded Play, repetition history, fixed search, exact-root
coaching, cumulative budgets, and PV export. They are experimental artifacts;
this tool does not replace an app asset or activate an evaluator.

## What is built

| Artifact | Evaluation | Memory |
| --- | --- | --- |
| `baseline` | Exact original production HCE | Exact production capacity |
| `baseline-memory` | Exact original production HCE | Declared candidate capacity |
| `hce-scalar` | Specialized shared HCE kernel | Declared candidate capacity |
| `hce-simd` | Same HCE, explicit integer SIMD board masks | Declared candidate capacity |
| `sparse-scalar` | HCE plus the selected residual; original full model by default | Declared candidate capacity |
| `sparse-simd` | Same evaluation, explicit integer SIMD board masks | Declared candidate capacity |

The two evaluation paths are separate compiler instantiations. The HCE-only
path eliminates learned offsets, table accesses, residual accumulation, and
residual rounding. Full-model tables are generated as immutable Rust constants
using `Model::from_tables`; no model loader, run-time variant switch, batch
position buffer, or whole-board evaluation cache enters the WASM interface.
The default full table payload is exactly 16,712 bytes. Native reference loading remains
available for independent export/parity tests and is dead code in these builds.

The generated crate keeps the captured `src/search.rs` and `src/engine.rs`
byte-for-byte unchanged. Its `lib.rs` receives only the two evaluation module
declarations. The copied pinned production build recipe retains its compiler,
Binaryen, optimization, 1 MiB stack, and table settings. Candidate recipes
explicitly specify scalar or SIMD128, disable relaxed SIMD, and remap source
paths. SIMD helps board mask extraction; it does not claim to vectorize every
term or to win on every browser.

## Build

Use an exact production commit and the pinned direct toolchain executables.
The output must be a new directory outside the repository. No network access
or package download occurs during preparation/build.

```sh
python3 tools/eval_pipeline/prepare.py \
  --base-commit 2cf89b6e2ff7c7f2f11c2bf39e4c9b7bc99d28e0 \
  --output /absolute/new-eval-build \
  --extra-memory-page --build \
  --rustc /absolute/rust-1.97.1/bin/rustc \
  --cargo /absolute/rust-1.97.1/bin/cargo \
  --wasm-opt /absolute/binaryen-version_131/bin/wasm-opt

node test/training/eval-pipeline-abi.test.mjs \
  /absolute/new-eval-build /absolute/new-eval-build/ABI-CHECK.json
```

Omit `--build` to inspect the prepared sources first. Building that unchanged
snapshot later uses `--build-existing --output ...` and the three tool paths.
Preparation options, including memory, cannot be changed at that stage.

### Separately import an eligible cost-aware refit

The default full model and previous artifacts are never replaced. To prepare a
separate candidate, provide **both** the complete refit result manifest and one
of its two registered recipes:

```sh
python3 tools/eval_pipeline/prepare.py \
  --base-commit 2cf89b6e2ff7c7f2f11c2bf39e4c9b7bc99d28e0 \
  --output /absolute/new-no-pawn-build --extra-memory-page \
  --refit-manifest /absolute/completed-refit/RESULTS.json \
  --recipe refit-no-pawn
```

Use `refit-no-ray` for the other registered recipe. Build the prepared snapshot
with the same `--build-existing` command and pinned tools used above. A recipe
name, weight file, or intermediate report alone is insufficient. Preparation
requires the complete two-recipe result, original registered input inventory,
and exact original train/validation corpus and fitting/extractor source hashes.
It stream-verifies every file in the completion inventory, checks the packed
arrays against the original manifest, and binds the registration/run protocol.
No holdout or OOD file may enter the input/packed closure.

The importer independently checks the selected fit's recipe and numerical
convergence fields, float-to-integer symmetric half-away rounding, exact zeros
in the removed family, validation phase/family inventories, reported quality
guards, and actual narrow-table range eligibility. It executes no supplied
refit source. Complete source, reports, model bytes, and validation score files
are retained under `refit/`; the large raw corpus, packed arrays, and extractor
executables are stream-verified and bound through the retained `RESULTS.json`
and `IMPORT.json`, rather than duplicated in each build. Keep the complete
refit study alongside the candidate for full reproduction. The hashes bind
the supplied evidence; they do not establish training honesty independently.

Only sparse variants receive the family compile flag. `eval_pipeline_no_pawn`
removes learned pawn-attack extraction, context lookups, and its table, leaving
13,640 coefficient bytes. `eval_pipeline_no_ray` removes learned pair lookups
and accumulation, leaving 15,360 bytes. HCE pawn terms and sliding geometry
remain necessary in both cases. The immutable constructor rejects nonzero
values in an omitted table at compilation, and the native strict loader rejects
nonzero omitted coefficients. HCE controls receive neither family flag.

An eligible refit is a separate research candidate. This option does not add it
to a registered cost/game campaign or activate it. Its prepared model identity,
family flag, validation/runtime admission, and complete provenance are explicit
in `PREPARED.json`. Equal-time playing strength remains a separate gate.

### Restore omitted refit inputs from a thin bundle

The thin evidence bundle preserves the completed v1 refit results, both models,
validation scores, registration, source snapshots, native extractor, and packed
receipt. It omits the two large raw train/validation files and their 16 packed
array files. Importing a refit requires those inputs to be restored so all 49
files in the original `RESULTS.json` inventory can be authenticated.

Obtain the original `chessy-sparse-pesto-data-and-evidence.tar.zst` archive and
extract `data/eval-v1/manifest.json`, `data/eval-v1/train.jsonl`, and
`data/eval-v1/validation.jsonl`. The restoration helper authenticates the exact
original manifest and both raw inputs. It does not need a holdout extraction.

Use a Linux x86-64 host compatible with the retained native extractor and
Python with the recorded NumPy/SciPy versions. No Rust compiler is executed.
Run from the repository root, with a new reconstruction directory outside the
thin study and original-data trees:

```sh
python3 -m pip install 'numpy==2.3.5' 'scipy==1.17.0'
python3 tools/eval_pipeline/restore_refit_inputs.py \
  --study /data/thin-evidence/refit-study-v1 \
  --data-directory /data/original-inputs/data/eval-v1 \
  --work-directory /data/new-refit-input-reconstruction
```

The helper executes the captured, hash-pinned `pack_roles` in an isolated
subprocess. It reconstructs only train/validation features and verifies all 16
arrays plus `packed/PACKED.json` against the completed study before publishing
missing inputs. It preserves fitted weights, validation outputs, and all
historical manifests. Existing mismatches, changed source, symlinks, and unsafe
paths stop restoration without overwriting evidence. Valid inputs already
present are kept. Failed attempts leave no success receipt; a partial attempt
may leave verified inputs already restored.

Successful restoration verifies all 49 inventory identities and writes
`RESTORED-INPUTS.json`. The original `RESULTS.json` remains unchanged. No fitting
is rerun and only train/validation data are opened. The helper is bound to this
recorded v1 study; another study requires an explicitly reviewed identity.
The restored tree can then be passed to `prepare.py --refit-manifest` using the
command above. Its quality and playing-strength status remain unchanged.

### Explicit one-page memory experiment

The current 405-page capacity is 26,542,080 bytes. An initial real build
reproduced the original control but the specialized HCE needed 26,542,300
bytes, exceeding it by 220 bytes before embedding the learned tables. The
tool does **not** silently increase memory. Without `--extra-memory-page` the
normal linker check still rejects an oversized artifact.

`--extra-memory-page` explicitly reserves 406 pages, or 26,607,616 bytes, for
the candidate variants and the memory-matched original-HCE control. The exact
original control remains at 405 pages and must still reproduce the committed
WASM byte for byte. No stack reduction, TT reduction, memory growth, or search
change is used to make room. Actual WASM contracts check both initial capacity
and failure of `memory.grow(1)` for every module.

This research option does not change production's capacity or download-size
limits. Raw and compressed artifact costs must accompany any later activation
proposal; a smaller coefficient payload is not a complete module-size claim.

## Captured inputs and output identity

Preparation reads the declared production commit through Git objects rather
than the mutable worktree. It checks the complete Rust source inventory and
captures all eight crate/build inputs, the shipped control module, production
loader/rules, and license notices. The current implementation and model bytes
are read once, retained, and hashed. The full model must match the preceding
selection manifest's dense weight identity; arbitrary substitutions are
rejected. Current HCE constants must match the captured production evaluator.

Every original coefficient and every derived fused/ray coefficient is checked
for signed-eight-bit range before source export. There is no clipping,
approximate quantization, or changed interpolation. Export tests cover stage
offsets and opposing-color ray signs; native runtime tests compare the baked
tables with strict loading and the preceding independent evaluation oracle.

`PREPARED.json` is written last after exclusive output reservation. It binds
the complete source/model/control inventory, capacities, table bytes, and
variants. Build verifies the snapshot before each compilation and again before
publication, rejects ambient Cargo configuration, uses an isolated Cargo home,
and clears inherited Rust/Cargo override variables. On Linux, the pinned tool
executables run through retained open file descriptors; those same executable
inodes are hashed again at completion. Toolchain dependency provenance remains
the responsibility of the pinned toolchain installation and its receipts.

`BUILT.json` is written only after every declared variant builds and the
unchanged control reproduces exactly. It records module bytes/hashes, declared
capacity, exact tool versions/hashes, and the preparation digest. Failed builds
leave their source snapshot and logs; neither source nor observations are
silently overwritten or resumed. Final modules are under `modules/`, source
crates under `variants/`, and full compiler logs under `logs/`.

## Verification and interpretation

```sh
python3 test/training/eval-pipeline-build.test.py
EVAL_PIPELINE_RUSTC=/absolute/rust-1.97.1/bin/rustc \
  python3 test/training/eval-pipeline-runtime.test.py
```

The actual-module ABI test executes the captured production loader/rules from
the same bytes it hashes. It checks the exact export/import interface, fixed
memory, static HCE equality, sparse scalar/SIMD equality, seeded fixed-node
search equality/determinism, special moves, threefold history, shared-budget
exact-root results, legal PV replay, aborted analysis, and invalid-load state.
It reports correctness only; its execution durations are not a cost study.

The production crate's existing native seed test also contains an HCE-specific
behavioral witness: several depth-two starting moves tie, so sixteen seeds
must produce more than one selected move. The learned model can make a unique
best starting move; it retains deterministic seed behavior and equal-depth
minimax value but does not preserve that tie witness. The original test/source
is retained, not rewritten to claim unchanged opening variety. This is a
separate product behavior to assess before activation, alongside complete-game
strength, conversion, and coaching quality.

The separate actual-module test verifies all twenty start-position roots at
depth two with quiescence off: this frozen full model ranks `d2d4` at 0 cp and
the next move `e2e3` at -5 cp. All sixteen seeds correctly retain the unique
best move. Those numeric starting-position goldens apply only to the original
full model's SHA-256. Each imported refit must independently verify all initial
best roots and select one of them at the same depth for every seed. A separately
checked mate-in-one position has four equal best roots; every sparse model
must vary among those verified best moves and repeat each seed exactly. Thus
the old HCE-specific starting tie is not relabeled as model-independent, and
seed variation is still tested on an actual equal-best witness.

All candidate/control cost measurements must use the same declared capacity
and actual product inputs. Equal-wall-time complete games remain the primary
playing-strength criterion, including for levels that currently use node caps.
Static prediction gains, NPS gains, exact kernel parity, and passing ABI tests
do not establish that a learned evaluator improves play at equal time.

## Production activation contracts

The captured production `ai-worker.js` keeps the first WASM-loading promise
for the worker's lifetime, including a rejected load. Later requests with a
different `wasmUrl` do not replace that evaluator. A future policy that selects
an evaluator by time budget must route to an already validated matching worker
instance or terminate and recreate the worker before loading the new module.
Changing only the request URL cannot implement evaluator switching or recover
that failed-load singleton. Bind the worker instance to its source/model/build
identity and validate its ABI before assigning requests.

These artifacts do not change that worker policy, release assets, service-worker
cache version, or production default. Activation needs a coherent release that
binds the selected module, loader/worker, model identity, fixed memory, and cache
keys, plus the applicable equal-time and coaching-quality evidence. A rejected
candidate can remain an isolated reproducible research artifact.
