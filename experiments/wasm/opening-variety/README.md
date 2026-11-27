# Calculated opening variety: r85 evidence

The requested product change gives new games varied openings while retaining
normal engine calculation. Candidate
`29b804c73864c57493c98b55a9f425a87e90f243` adds an optional `search_seeded`
entry point. It supplies a per-request seed to the existing initial root
shuffle; evaluation, strict improving-score selection, PVS re-search,
aspiration windows, repetition rules, and search budgets remain unchanged.
The original entry point retains seed `0x00C0FFEE`.

Play supplies a seed during the first 12 plies, derived from the durable game
ID and exact FEN. New games vary; retries, Undo, and pending-game reloads retain
the same seed. Telemetry and debug PGNs preserve its bits. Analysis and later
Play use the ordinary unseeded entry point. The loader rejects invalid seeds
or a seeded request to a module without the optional export.

## Reproducible engine proposal

The existing signature mechanism was run from the clean r84 generator commit
`4e296c85f995a3b61b6e115031a07e9e09291245`, comparing that same old source with
the candidate above. Rust 1.97.1, commit
`8bab26f4f68e0e26f0bb7960be334d5b520ea452`, and Binaryen 131 rebuilt each
source twice in separate fresh snapshots. A second independent complete
preparation repeated all four builds and reproduced the bundle and completion
receipt byte for byte.

| Artifact | Result |
| --- | --- |
| Old module SHA-256 | `57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f` |
| Candidate module SHA-256 | `a18affeb07590eaf5610c01a73701d745a05e1ed3f53a257ccc93c4176bd96d7` |
| Candidate raw bytes | 37,210; increase of 38 bytes |
| Fixed linear memory | 26,542,080 bytes, unchanged |
| Complete unseeded signature comparison | 144/144 unchanged, including separate exact-root/PV probes |
| Evidence SHA-256 | `bb37a54957d1acb3956932c9e477b8b4b3d9ffb7ab9416ccad92cbaccbdd3362` |

The content-addressed proposal is
[`wasm-v2-bb37a54957d1acb3956932c9e477b8b4b3d9ffb7ab9416ccad92cbaccbdd3362.json`](../../../test/fixtures/engine-signatures/wasm-v2-bb37a54957d1acb3956932c9e477b8b4b3d9ffb7ab9416ccad92cbaccbdd3362.json).
[`preparation.json`](preparation.json) is the original completion receipt.
The historical r69 generator and fixture remain unchanged.

## Seeded behavior checks

Native tests pass 8/8. The dedicated Node suite passes 12/12, covering genuine
move variety, independent shallow minimax, legal roots, exact node boundaries,
completed-iteration fallback, repetition, seed validation, fresh-instance
replay, no seed leakage, and worker forwarding. Restoring the constant seed in
an isolated mutation causes the variety test to fail.

An exposed initial-position sample with seeds 0 through 15 chooses Nf3 or d4
at each of Easy, Medium, Hard, and Expert. After d4, all four levels choose
between ...d5 and ...Nf6. After e4, Easy through Hard vary; Expert retains
...d5 in that sample. These are development observations, not a strength test.

Changing root order can change the search path, completed depth, and selected
move under finite budgets. The feature adds neither score noise nor random
unevaluated moves; it does not prove unchanged playing strength or force a
different choice when the search keeps preferring one move. No Elo, physical
device certification, optimization admission, or fresh-holdout result is
claimed.

This evidence commit does not activate the candidate. The separate activation
must select this reviewed bundle in the active manifest and pass the trusted
base verifier, pinned rebuild, runtime, and browser gates.
