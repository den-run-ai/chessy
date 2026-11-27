# Reproducing the sparse PeSTO prototype

Start from this research branch of `den-run-ai/chessy`. The experiment's
measured baseline is r84 commit `5e3558378deab8ba21f648cc2cca98195b1beced`.
Exact engine/evaluator/search source copies are pinned under
`tools/sparse_eval/baseline/`; its manifest checks their bytes. This preserves
the experiment while the production app inherits main's later r85 release.
The first research commit is `1e6000d43b8a4bcf17405bd150971256bfd3114e`; later
additions preserve measured source versions rather than relabeling results.
The packaging rebuild passed all 100,164 validation score comparisons against
the original fast binary. [PACKAGING-RECEIPT.json](PACKAGING-RECEIPT.json)
records this check separately, with no new timing measurement.

## Evaluate the fitted model

From the repository root, with Rust 1.97.1:

```sh
rustc --edition=2021 -O --cfg sparse_fast \
  tools/sparse_eval/runtime.rs -o /tmp/chessy-sparse-fast
printf '%s\n' 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1' \
  | /tmp/chessy-sparse-fast eval eval/sparse-pesto-v1/fit/full.spv
```

Output columns are HCE score, candidate score and correction, all White POV.
The compact SPV1 model expands at load time. Omit `--cfg sparse_fast` to build
the reference ray-walk path. All five fitted models are retained in `fit/`;
`full` is the frozen validation choice. Do not choose a different model using
the now-public holdout or OOD results.

## Exact data and raw evidence

Three companion downloads are supplied with the study:

- `chessy-sparse-pesto-data-and-evidence.tar.zst`, containing the primary role
  JSONL, complete January 2014 PGN archive and inventory, natural-game
  positions, OOD game histories/labels/UCI traces, raw native runtime and LP
  evidence, and the original packing/build/freeze receipts.
- `chessy-eval-prefix-512m.part01.zip` and
  `chessy-eval-prefix-512m.part02.zip`, each wrapping one exact 256 MiB source
  byte segment. Unzip both before concatenation.

[DATA-ARCHIVES.json](DATA-ARCHIVES.json) records every archive size and SHA-256.
The main archive also contains `DATA-ARCHIVE-CONTENTS.json`, with identities
for all 207 archived files. Every file was independently read back from the
compressed archive and checked; the concatenated source hash was checked too.
These companion data files are separate from Git. Source, fitted models and
historical source snapshots are retained in the repository.

After extracting the main archive into a chosen study directory, reconstruct
the exact source prefix in its `data/` directory:

```sh
unzip chessy-eval-prefix-512m.part01.zip
unzip chessy-eval-prefix-512m.part02.zip
cat chessy-eval-prefix-512m.part01.bin chessy-eval-prefix-512m.part02.bin \
  > data/lichess-eval-prefix512m.jsonl.zst
sha256sum data/lichess-eval-prefix512m.jsonl.zst
```

The expected assembled hash is:

```text
6c2dc6c9b3856d3fb19bcd1d568cdbb49418f2895b12091cd0497b0c2aff117f
```

This deliberately truncated Zstandard stream is consumed by the importer's
complete-line rule. It is not a complete archive to be repaired or silently
redownloaded from the mutable upstream URL. The full original PGN archive is
complete and has its separately published official checksum.

## Packing and fitting

Use Python 3.12 and the recorded research dependencies:

```sh
python -m pip install numpy==2.3.5 scipy==1.17.0 chess==1.11.2 zstandard==0.25.0
python -m tools.sparse_eval.pipeline --help
python -m tools.sparse_eval.data --help
```

Invoke Python modules from the repository root. Directly executing
`pipeline.py` without the repository on `PYTHONPATH` is unsupported. Example
commands, with fresh output directories and paths changed to your extracted
data location, are:

```sh
python -m tools.sparse_eval.pipeline pack \
  /absolute/study/data/eval-v1/manifest.json /absolute/study/repacked \
  --runtime /tmp/chessy-sparse-fast
python -m tools.sparse_eval.pipeline fit \
  /absolute/study/repacked/manifest.json /absolute/study/refit
```

These commands create a new reproduction with its own implementation and
binary identities. To reconstruct a historical implementation exactly,
consult [source-snapshots/SNAPSHOTS.json](source-snapshots/SNAPSHOTS.json) and
the original result's embedded implementation receipt. Historical versions
are inert `.txt` files and must be restored to their recorded source paths in
an isolated checkout. The original runtime executable is retained in the data
archive. Numerical predictions match the optimized path, but source and
executable identities must not be substituted in an old receipt.

The packed CSR arrays are reproducible caches and are omitted from the data
download. Their original manifest is retained. Packing authenticates complete
role bytes; fitting authenticates the packed manifest again when loading each
role. Outputs reserve a fresh directory and write completion metadata last.
The completed original study froze its validation choice before opening its
holdout. The generic CLI does not implement a global access lock across
different output directories. Repeated exposed-data reproduction is not new
independent validation.

## Correctness checks and timing scope

The eleven new correctness suites initially contained 90 tests: 89 passed
without a teacher binary, and the optional real-teacher smoke then passed
against the pinned official Stockfish 18 binary. Packaging adds a baseline
identity check, for 91 tests in total. Rust parity uses the pinned 1.97.1
compiler. New tests are wired into the existing CI jobs; CI does not rerun
model selection, the holdout, OOD evaluation or timing measurements.

```sh
SPARSE_EVAL_RUSTC=/absolute/rustc python test/training/sparse-features.test.py
SPARSE_EVAL_RUSTC=/absolute/rustc python test/training/sparse-export.test.py
SPARSE_EVAL_RUSTC=/absolute/rustc python test/training/sparse-fast.test.py
```

The remaining `test/training/sparse-*.test.py` files check data admission,
manifest binding, convex solver math, sparse LP primal/dual feasibility,
native NNUE integer semantics, and complete timing inventories. The optional
real-teacher test takes `SPARSE_OOD_STOCKFISH=/absolute/official-stockfish18`.
It checks the exact executable hash before searching an authored position.

Runtime and LP reports preserve successful and rejected outcomes. Timings are
small native CPU diagnostics with complete raw observations, not matched NNUE,
WASM, phone or equal-time match evidence. Any promotion or follow-up tuning
requires its own declared experiment and appropriate independent data.
