# Frozen hybrid fixed-node diagnostic

The prior frozen smooth-6-12 hybrid improved held-out teacher loss by 3.53% but
scored 41.5% in its complete 200-game, 20 ms development arm against shipped
HCE. This separate experiment asks whether removing unequal node throughput
makes it competitive. It cannot identify every evaluation/search interaction:
identical node limits still allow different trees, pruning and completed depths.

The [prospective contract](hybrid-fixed-node-v1.json) freezes exactly 200 games:
the same 100 exposed openings with both colors, 16,384 nodes per search, no time
limit, maximum depth 30 and 180 searched plies. The budget is the existing higher
fixed-node cell in `hybrid-runtime-v1.md`; it was chosen before these games.
Modules are the exact unchanged binaries authenticated by the original
registration `db7f95f1cfe2b69dd53aeeb0a7faf0d66e8ac1a26d03ee7cdf5560fd346c0fbc`.
Expanded HCE remains the prior offline and equal-time control; this diagnostic
adds no third arm. Early mate or maximum-depth completion can use fewer nodes.

One complete run is permitted, with no optional stopping, outcome-based rerun,
post-hoc extension, formal holdout access, training or paid compute. The
prospective research routing threshold is a 50% hybrid score: at or above it,
profile residual costs and register a separate longer equal-time screen; below
it, inspect move ranking, tactical misses and phase transitions before further
optimization/training. This threshold is not a significance test or admission
gate. All statistical bounds are descriptive on an exposed opening bank.

The runner retains exact emitted bytes in parent memory, atomically publishes
each game, requires parent acknowledgement before continuing and compresses
only after the search process exits. Authenticated retained archives supply
all replay and scoring. Invalid search results are captured before failure;
failed/partial inventories are retained without a score. JavaScript replay and
an independent python-chess replay both verify legal moves, full opening-prefix
repetition, endings, requested nodes and coherent search stop metadata.

Before registration, copy the implementation dependency tree into a fresh,
read-only execution snapshot and invoke the tools only from that snapshot.
Record exact snapshot hashes in registration, commit/publish that registration
before any game, and retain the snapshot unchanged through publication. This
prevents accidental concurrent edits from changing executed code under the
honest-operator threat boundary. Existing source trees are not modified by the
experiment. Parse authenticated retained bytes rather than reopening receipt
paths after hashing. Recheck inputs before publication; exclusive no-replace
ledger/output publication forbids a second run. Module bytes are verified and
consumed directly by the loader.

Other CPU development may run on the host. Observed per-move times are diagnostic
metadata, not evidence of a causal speedup; isolated paired profiles are needed
for runtime claims. No shipped asset, evaluator, difficulty or rating changes.

Post-completion review identified that permission checks alone cannot protect a
retained directory from ancestor-path replacement or stop a copied study with
its local ledger omitted. The completed recipe's registration, run and internal
child entrypoints are therefore retired before reading arguments or writing
state. No current producer API can reopen this consumed experiment.

The [exact executed source](../../tools/training/hybrid-fixed-node-v1.executed.js.txt)
is preserved as non-executable historical text. The actual run used the unchanged
reviewed read-only snapshot; its registration, raw bytes and audits remain intact.
This correction changes no result and authorizes no rerun. Read-only game replay,
statistics and audit helpers remain available. Independent Python audit entrypoints
also require the executing auditor/helper to match the registered read-only root.
Audit original evidence with its exact preserved auditor version:

```sh
python SNAPSHOT/tools/training/audit-hybrid-fixed-node-v1.py \
  --execution-repo SNAPSHOT --registration REGISTRATION --registration-sha256 SHA \
  --run-dir ORIGINAL_RUN_DIRECTORY --output NEW_AUDIT
```

Focused verification:

```sh
node --test test/training/hybrid-fixed-node-v1.test.js \
  test/training/hybrid-match-capture-v1.test.js \
  test/training/hybrid-match-recovery-v1.test.js
python test/training/hybrid-fixed-node-audit.test.py
```
