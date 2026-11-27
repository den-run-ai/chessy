# Compact incremental hashing: isolated cost prototype

**Research only. The selected candidate still fails the frozen raw-size ceiling.**
No production source, asset, ABI, release, evaluation weight, search decision,
formal registry, or admission rule is changed by this directory.

The base is r82,
[`f65224dece688f23d00429c148715262dd3c9b79`](https://github.com/den-run-ai/chessy/tree/f65224dece688f23d00429c148715262dd3c9b79).
This is a new implementation of the cost idea examined in
[#184](https://github.com/den-run-ai/chessy/pull/184), not another run of its
retired candidate. Its separate cost-admission policy remains open in
[#175](https://github.com/den-run-ai/chessy/issues/175). The physical-device
requirements in [#84](https://github.com/den-run-ai/chessy/issues/84) remain open.

## Transformation and invariant

The old piece-square keys are unchanged. `Z_PAIRS[i]` packs the original
`Z1[i]` into the low 32 bits and `Z2[i]` into the high 32 bits of a `u64`.
XOR acts independently on those halves, so splitting the result yields the
original two words without mixing them.

Each recursive call owns one immutable board-only hash value. After making a
legal search edge, the child value XORs out the original mover at `from`, XORs
in the actual post-move piece at `to`, and XORs out the captured piece. An en
passant capture uses its third square. Castling also removes and adds the rook
at its old and new squares. Reading the post-move destination handles all
promotions and underpromotions without assigning new values or move codes.

The parent value is a local variable, so unmake, aborted calls, PVS re-searches,
and temporary legality probes cannot invalidate a mutable hash cache. A PVS
re-search reuses the same child value. Unlike #184, this design has no
per-ply validity slots, reset loop, or extra static cache. It updates every
quiescence edge, including those that will not need repetition hashing; the
cost of those updates is included in the retained timings.

Turn and castling suffixes are unchanged. TT identity includes the raw en
passant file, while repetition identity includes that file only when a legal
en passant capture exists. The existing make/unmake legality probe remains
unchanged. The two streams are used in the same order everywhere.

Ordinary root, fixed search and exact-root setup scan their own board before
passing a child value. Game-history loading, completed-root repetition checks
and PV reconstruction still call the full-scan hash. Exact-root selection
still resolves the requested move against generated legal roots. There is no
new hash assumption at a public FEN or ABI boundary.

The selected `threaded` implementation retains checked table indexing. The
unselected `proven-indices` variant removes a private lookup check under the
legal-move index argument; it saved only 15 bytes and is retained solely as a
negative size result. It has no correctness or timing claim.

## Evidence and remaining failure

Pinned Rust 1.97.1 (`8bab26f4f68e0e26f0bb7960be334d5b520ea452`) and
Binaryen 131 use the unchanged build script, fast profile, target features,
1 MiB stack reservation and fixed 26,542,080-byte linear memory. No small
profile output is substituted for the fast asset.

| Candidate | Fast WASM bytes | Excess over 37,172 | Outcome |
| --- | ---: | ---: | --- |
| Historical #184 | 38,359 | 1,187 | Prior evidence; not rerun |
| `threaded` | 37,885 | 713 | Selected checked design; size fails |
| `shared-update` | 37,885 | 713 | Byte-identical fast output; not timed |
| `proven-indices` | 37,870 | 698 | Only 15 bytes saved; rejected for selection |

The selected fast SHA-256 is
`7d1f2f9046dc46ca754445577a74a50e34f1eaaf6360fce9a1b07ddd9ff94a79`.
The initial and final independent builds produced that same digest. The final
generator reproduces the generated search-source digest in every retained
variant receipt; earlier generator receipts are preserved without relabeling.

Native tests passed **12/12**, including 7,097 authored legal edges and 38,622
seeded legal sibling edges. Every checked child hash matched a full scan,
every completed hash matched the unchanged two-stream function, and parent
positions survived make/unmake and legal-EP probing. Search comparisons cover
120 ordinary, 120 fixed and 312 shared-budget exact-root/PV cases, plus loaded
twofold and threefold history. Authored cases include both colors of castling,
promotion captures, underpromotions, legal and pinned en passant, terminal
positions, fifty-move boundaries and small abort budgets.

The built module also passed all **144 immutable r69 signatures**, paired
complete ordinary and exact-root/PV outputs, independent JavaScript legal-PV
replay, and two history-sensitive searches through the strict r82 loader.
Complete paired outputs include fields outside the nine-field historical
fixture. These finite observations support the local invariant; they are not
a universal proof of search equivalence.

## One retained development measurement

[`protocol.json`](protocol.json) was registered before timing. There is one
selected candidate, 18 authored/mirrored positions, 10k/36k/230k fixed-node
budgets, four order-balanced repetitions, and two warmup passes. Each paired
ratio is baseline elapsed time divided by candidate elapsed time. Position
medians combine the four pairs; the table uses their geometric mean.

| Node budget | Geometric speed ratio | Opening median | Middlegame median | Endgame median |
| --- | ---: | ---: | ---: | ---: |
| 10,000 | 1.05401 | 1.02496 | 0.99525 | 1.14181 |
| 36,000 | 1.07200 | 1.05459 | 1.01748 | 1.14779 |
| 230,000 | 1.09017 | 1.04214 | 1.02617 | 1.14356 |

All **432 timed observations / 216 paired comparisons** had identical complete
search outputs. The low-budget middlegame median is a retained regression.
Timings include the strict loader's complete search call, including position
and history preparation; they are hosted Node observations, not browser/device
or universal performance claims.

The preregistered routing rule required a 230k geometric ratio of at least
1.02 and every phase median of at least 1.00. It passed, so the runner executed
only the declared two Ruy Lopez and two Lucena pairs at the current Master
8,000 ms / depth-111 configuration: eight searches, 64 seconds of budgets.
All four pairs completed the same depth and chose the same move (Ruy Lopez
depth 8; Lucena depth 13). Candidate node gains ranged from 3.56% to 14.80%.
The largest observed full-call overshoot was 3.411 ms for the candidate and
1.083 ms for the baseline. Four pairs cannot establish tail responsiveness,
device benefit, deeper search, or strength.

Local Brotli-11 sizes were 17,690 baseline and 17,937 candidate bytes using
Node 24.22.3 / Brotli 1.2.1. This is **diagnostic compression**, because the
authoritative encoder is Node 22.23.2 / Brotli 1.1.0. The raw-size failure is
already conclusive and no ceiling exception is requested.

## Reproduction and guards

`prepare.js` captures its own recipe, pins all eight base build/source inputs,
requires exact patch anchors and a new destination outside the repository,
and writes a source receipt. Native reference/oracle code is `cfg(test)` only.
The build crate and its target directory remain outside the repository.

```sh
CHESSY_HASH_TMP=$(mktemp -d)
node experiments/wasm/compact-hash/probe.test.js
node experiments/wasm/compact-hash/prepare.js "$CHESSY_HASH_TMP/candidate"
(cd "$CHESSY_HASH_TMP/candidate" && cargo test --locked --offline)
CHESSY_CARGO_TARGET_DIR="$CHESSY_HASH_TMP/target" sh "$CHESSY_HASH_TMP/candidate/build.sh"
node experiments/wasm/compact-hash/validate.js "$CHESSY_HASH_TMP/candidate" "$CHESSY_HASH_TMP/validation.json"
node experiments/wasm/compact-hash/probe.test.js "$CHESSY_HASH_TMP/candidate"
```

Use the pinned tool paths accepted by `build.sh` when they are not on `PATH`.
The final probe asserts that newly built fast bytes equal the measured digest.
These commands perform correctness/reproduction checks and no timing campaign.
The validator records `rawGatePassed: false`; its successful exit means the
finite correctness checks passed, never that this candidate can ship.

The benchmark captures and executes the runner/loader/rules bytes that it
identifies, retains input module bytes, journals every warmup and measurement,
and reserves a shared per-account one-shot ledger before search. No outcome is
retried or replaced. The exact measured runner is archived in
[`evidence/measured-runner.js.txt`](evidence/measured-runner.js.txt).
After measurement, receipt-binding preflight was strengthened and mutation
tests were added. Those checks bind module identities, sizes and raw-gate status
back to validation; the original registration and measured outcome were not
changed or rerun. Focused probes check the archived runner identity, all source
variant digests, missing/mutated result rows and false authority/size receipts.

All source receipts, build logs, native output, full validation rows, the frozen
registration, measurement rows and summary are under [`evidence/`](evidence/).
[`manifest.json`](manifest.json) inventories the retained package. Size,
separate reviewed cost-admission policy, trusted enforcement and authentic
physical-device evidence remain prerequisites for any future activation.
