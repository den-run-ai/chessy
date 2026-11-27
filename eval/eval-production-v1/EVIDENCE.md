# Retained evidence and restoration

The delivered archive is **`chessy-eval-production-v1-evidence.tar.zst`**:
60,335,251 bytes (about 60.3 MB), SHA-256
`2c79993643d3ea7f38c44b5d2e46cf7dbe81b8924b3378ce993df3bb7e4b0979`.
It uses source commit `02623d2bac34d039dd9c5487e3e01ba9687f5062` on
[PR #202](https://github.com/den-run-ai/chessy/pull/202).
[Machine-readable delivery receipt](EVIDENCE.json).

A new-directory restoration verified **all 1,532 files**: 713 raw archive
members and 819 exact repository-blob references, totaling 318,405,974 restored
bytes. The restored game ledger was then audited again using its retained
source, with no searches rerun. Its complete audit was byte-identical to the
published result: 128 games and 13,590 searched plies.

## Contents

- The complete 2,592-observation main cost study and 648-observation refit
  cost study, including raw protocols, source snapshots, schedules, warmup,
  build identities, modules, and host metadata.
- All 128 games: raw request/response ledger, complete histories, normalized
  records, PGNs, registration, completion seal, and canonical audit.
- Separate independent game-audit source, its complete timing distributions,
  freshly executed JavaScript rules replay, and the cost-audit receipt/source
  provenance. The cost inline source was recovered after execution; that
  limitation is explicit in its provenance record.
- Three production-ABI build sets, the original failed fixed-memory build,
  prior native fixture diagnostics, and explicitly unexecuted superseded
  registrations. Build target/cache intermediates are omitted.
- Both fitted smaller models, all integer validation predictions, native
  parity evidence for 200,328 comparisons, and the verified input-restoration
  source, tests, and receipts.
- Chromium/WebKit Worker receipts and CI-produced modules from run 46022918601.
  All six CI modules matched the local measured build byte for byte. Later
  source/test/documentation checks remain visible on the PR.
- The pinned Node executable used by the refit cost study, with its official
  distribution license/notices. Rust/Binaryen distributions are not duplicated;
  their versions and provenance are recorded.

## Restore the runtime evidence

Use Python with `zstandard==0.25.0`, the delivered archive, and a repository
checkout containing the source commit above. `bundle.py` resolves exact Git
blobs from repository history and verifies every size and SHA-256; it does not
execute any study. Use an output directory that does not already exist.

```sh
python3 tools/sparse_eval_v2/bundle.py restore \
  --repo /absolute/chessy \
  --archive /absolute/chessy-eval-production-v1-evidence.tar.zst \
  --archive-sha256 2c79993643d3ea7f38c44b5d2e46cf7dbe81b8924b3378ce993df3bb7e4b0979 \
  --output /absolute/new-evidence-restoration
```

The restored tree begins at `new-evidence-restoration/evidence/`. Its
`INDEX.json` describes each study and the exclusions. `RESTORED.json` in the
outer directory is written only after the complete hash check passes.

To re-audit an already completed game campaign without overwriting its
retained audit, run the retained API with publication disabled. No Node process
or WASM search is started by this canonical audit; it verifies the recorded
production-JavaScript replay against an independent Python replay.

```python
from pathlib import Path
import sys

study = Path('/absolute/new-evidence-restoration/evidence/eval-production-games-v1')
sys.dont_write_bytecode = True
sys.path.insert(0, str(study / 'source'))
import games

report = games.audit(
    study,
    '5bbc44937c218e24a934a9cbe9de7478fda74972f12fc797bc4447920229f80b',
    publish=False,
)
assert games.encoded(report) == (study / 'audit.json').read_bytes()
```

## Restore the omitted refit inputs

This is a **thin refit bundle**, not a self-contained training corpus. It retains
31 files in the refit inventory plus `RESULTS.json`, and intentionally omits
18 bulky inputs: raw training/validation JSONL and their sixteen packed arrays.
The original archive is `chessy-sparse-pesto-data-and-evidence.tar.zst`,
456,904,369 bytes, SHA-256
`d921612ff1c062a635092def504a1505460ffdb7c47774752e8dd53c72d3a638`.
[Original archive instructions](../sparse-pesto-v1/REPRODUCTION.md).

After authenticating and extracting that archive's `data/eval-v1` directory,
run the new helper with NumPy 2.3.5 and SciPy 1.17.0 on a host able to execute
the retained Linux x86-64 extractor. The work directory must be new.

```sh
python3 tools/eval_pipeline/restore_refit_inputs.py \
  --study /absolute/new-evidence-restoration/evidence/refit-study-v1 \
  --data-directory /absolute/original-data/data/eval-v1 \
  --work-directory /absolute/new-packing-work
```

The helper authenticates the retained sources and extractor, opens only the
original training/validation roles, and rebuilds packing without fitting. It
checks all sixteen array hashes and the packed receipt before publishing any
missing input, then verifies all 49 original inventory identities. Existing
mismatches are errors; nothing is overwritten. The exact operation passed on
an independent thin copy, and both strict model imports passed afterward.
[Restoration verification](REFIT-RESTORATION-VERIFIED.json).

Hash closure establishes provenance and reproducibility. It does not repair
missing source-game IDs in the original corpus, make the exposed opening bank
a fresh holdout, establish browser/mobile latency, or admit a model to production.
