# Historical implementation bytes

This directory preserves the exact source versions named by the published
experiment receipts. Historical source copies are SHA-256-named plain text,
not imported modules. Identical current versions remain at their repository
paths instead of being duplicated. The active research tools remain under
`tools/sparse_eval/`.

`SNAPSHOTS.json` records 34 distinct source versions: 20 current repository
versions and 14 historical text copies, totaling 177,248 bytes of historical
source. It maps 115 source-hash references in the published study JSONs,
the pinned-baseline manifest and
retained freeze/build receipts, with no unresolved explicit source hashes.
The same read-only check resolved all 129 source references across 30 retained
archival metadata files; their byte hashes and source identities are recorded
under `archiveMetadataVerification`.

## Historical versions

| Version | Historical role | Later change |
| --- | --- | --- |
| Importer, `4a3bcc8d…` | Primary import and natural-game selection | The reusable importer subsequently added strict SAN-token scanning. An independent audit verified that every selected historical game satisfies the stricter grammar. |
| CHNN adapter, `08e24901…` | The measured direct NNUE head-edit experiment | The reusable adapter subsequently restricted the accepted header to `qa <= 255`. The measured checkpoint already has `qa=255`. |
| Native runtimes, `88e1fb3d…` and `0f5248a5…` | Original native runtime and the separately measured fast implementation | After the measurements, the active runtime's imports were redirected to the exact pinned r84 baseline. Both measured source versions are retained. |
| Feature reference, `f4209aff…` | Python reference used by the completed experiments | Its baseline-table source path was subsequently redirected to the exact pinned r84 copy. |
| Pipelines, `e5780fc5…` and `7425be72…` | Packing and the two retained implementation trees | Before the real fit, the loader was hardened to require the initially frozen manifest hash for every role. The fit used the second implementation. Its source-receipt paths were later adapted to the pinned baseline during packaging. |
| Earlier importer, `8566ab5f…` | Retained precursor | Preserved for completeness; the final corpus receipts identify `4a3bcc8d…`, not this precursor. |
| Six audit scripts | Independent corpus, OOD and runtime audits | Preserved as inert evidence with their exact original source hashes. |

The manifest records each source's exact SHA-256, byte count, original path,
storage path and origin. Each `receiptBindings` entry names the receipt and
its own byte hash, the JSON pointer containing a source hash, and the matching
source version. `snapshotInventories` preserves the original relative file
inventories for both fit implementations, both timing implementations, OOD
evaluation, the fast native build and the data/teacher snapshots.

Small original freeze/build receipts are also retained byte-for-byte. When a
receipt is already published elsewhere in this research directory, the
manifest references that existing copy. The OOD snapshot inherited an older
nine-source receipt before its evaluator was added; that historical receipt
is retained unchanged, and the actual OOD result correctly binds the complete
ten-source execution inventory including `evaluate_ood.py`.

The source copies came directly from retained experiment sources, with one
explicit exception: the CHNN copy was recovered by reversing the single
documented header-guard change in the later file. Its complete bytes match the
already recorded historical SHA-256 exactly. The manifest describes the
recovery and the exact replacement. This does not substitute an inferred
source for an unverified execution hash.

No experiment, metric, weight, selection or historical receipt changed when
these copies were packaged. Later reader hardening and runtime measurements
retain their own identities.

## Production-source isolation during packaging

Main advanced from r84 to r85 after the measurements and changed production
search. The research bridge therefore imports exact r84 `engine.rs`, `eval.rs`
and `search.rs` copies under `tools/sparse_eval/baseline/`. Their byte hashes
and original Git blob identities match the measured sources. The three
historical source versions resolve to those pinned copies in this inventory;
their original execution paths and receipt pointers remain unchanged.

The measured runtime, feature reference and pipeline source versions were
preserved before adapting the active tools' paths. The packaging notes record
the original r84 commit and incoming r85 main commit. Integration uses a merge
that retains the original research commits. This does not relabel r84 timing
results as measurements of r85 production search. `measure_fast.py` retains
its original source because its historical path keys identify frozen metadata
instead of selecting live production code.

The separate packaging receipt binds the current import-path versions and
records equality with the already saved 100,164 validation score triples.
It contains no new timings or teacher labels. The current pipeline source is
also inventoried as a packaging adaptation, with no claim that historical
fits executed that newer version.

For an exact historical reconstruction, use a separate source tree containing
the original paths and dependency files listed in that experiment's complete
implementation receipt. Check every listed hash before running. A receipt may
also depend on the original source-file inventory; copying one old file into
the larger current tool directory does not recreate that entire historical
inventory. Generated bytecode caches, native executables, weights and raw
datasets are outside this source inventory. Reproduction of an exposed
diagnostic is not new independent validation evidence.
