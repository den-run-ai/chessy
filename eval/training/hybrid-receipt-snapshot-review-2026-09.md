# Hybrid match receipt audit and registrar repair

The post-merge review of PR #178 found a real registration race: the original,
optimized and recovery registrars hashed receipt files, then reopened their
paths for semantic validation. A file replacement could therefore bind one
snapshot while admitting another.

The repair hashes and parses a single retained snapshot. Preflight independently
repeats the semantic and cross-receipt checks on authenticated bytes before any
no-rerun ledger is consumed. Original-registration digests, exact implementation
inventories and canonical ledger paths are also checked; rehashing an edited
registration cannot redirect the ledger to an unused filename.

The original retained offline/runtime/source receipts and their module bindings
passed revalidation; the machine-readable receipt records the exact original
registration digest. This does not prove no race occurred historically. It finds
no retained binding mismatch and does not reclassify the audited 41.5% result.
No previous source snapshot, registration, game, model, or production asset was
edited, and no game or paid job was run for this repair. Historical audits still
use their own frozen source commits; do not rewrite their hashes to current code.

Fault-injection tests give the registrar an invalid first read and a valid later
read. The old implementation publishes a registration; the repaired version
rejects the first retained receipt and publishes nothing. Additional tests reject
internally rehashed but semantically inconsistent model/module bindings and
redirected ledgers. These tests run in the existing CI match suite.
