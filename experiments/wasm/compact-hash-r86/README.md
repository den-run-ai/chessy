# Compact hashing with seeded Play search

This package integrates the previously checked compact-hash implementation
with r85's optional Play root-order seed. It preserves the seeded search,
evaluation, ordering rules, node accounting, draw handling, fixed memory,
toolchain and ABI exports. It does not add pruning, tune the hash design, or
change evaluation. The old `compact-hash/` experiment and its 7d1f module are
historical predecessors; their measurements do not describe this module.

## Exact source and module pair

| Role | Commit | Fast WASM SHA-256 | Raw bytes |
| --- | --- | --- | --- |
| r85 full-scan baseline | `f27f05581c4be6bb35e230e1ffd01a62edf67541` | `a18affeb07590eaf5610c01a73701d745a05e1ed3f53a257ccc93c4176bd96d7` | 37,210 |
| Seeded compact-hash source | `173e06fd29f587f7de1ab9a84ad990760d7f23ae` | `4f63b8dd25b4ae6787d1720392417a60daab1066bef7d494060939cb2016f74c` | 37,934 |

The checked recipe is captured from the immutable Git object at
`3b32d2e7c23341d2245003c5324aa2ee6d07aa08`, the earlier r85 head used for
the actual build. The later focus fix at f27f055 changed none of the eight
engine/build inputs. Validation checks that equality and the complete
published candidate source inventory. The generated search source has SHA-256
`4db05a27ae42560d6f45920859f9916eb84d0df3d59ab3eca95a4e53ed75ffc4`.

`prepare.js` captures its own code and seeded test template, verifies all eight
Git-pinned source files and all three historical recipe files, executes the
retained checked recipe, and writes a fresh external crate. Git replacements
are disabled for object reads. All active hash code is the prior checked
`threaded` variant. The complete original seeded search remains under
`#[cfg(test)] mod reference_search`; the added test template is also test-only.

## Correctness before timing

The pinned native run passed 16 tests. It retains 7,097 authored legal hash
edges, 38,622 seeded legal sibling edges, 120 ordinary searches, 120 fixed
searches and 312 shared-budget exact-root/PV cases. The new seeded tests add
216 complete-result pairs over six u32 seeds, special moves and budget edges,
plus 108 pairs over legal reversible histories containing the root once,
twice or three times. Both engines must restore the root position.

The retained WASM preflight passes all 144 frozen ordinary signatures and
their paired exact-root/PV checks, two repeated-history cases, 16 declared
seeded panel cases, four explicit-default-seed cases and 16 seeded history
cases. It intercepts actual WASM export calls: each `rootSeed` must call
`search_seeded` with that exact u32. The declared panel produces distinct
results and moves across seeds, while candidate and baseline match per seed.
Default seed `0x00C0FFEE` matches ordinary search. No elapsed times are used
as correctness evidence or retained from this preflight.

`evidence/source.json`, `validation.json`, `native.log` and `build.log` retain
these inputs and outcomes. `probe.test.js` checks coherent source/receipt
tampering, incomplete cases, ignored seed evidence, changed module/runner
identities, complete timing panels and result mismatches. These are finite
checks; they do not prove universal equivalence.

## Prospectively frozen development protocol

`protocol.json` declares one complete run:

- The original 18 positions at 10,000, 36,000 and 230,000 nodes, four paired
  repetitions: 432 measured searches. Candidate/reference order balances
  within every position and budget.
- A separately summarized opening panel: initial White position and the
  Black position after 1.e4, seeds 0, 1, 12648430 and 4294967295, budgets
  10,000 and 230,000, four balanced paired repetitions: 128 searches.
- Two warmup rounds on both panels: 104 searches, excluded from summaries.
- Conditional follow-up only if the original 230k panel has a geometric
  mean elapsed-cost ratio of at least 1.02 and every phase median is at least
  1.00: Ruy Lopez and Lucena, two balanced pairs each, eight seconds per
  engine search, at most 64 seconds total. The seeded panel does not change
  this routing rule.

Ratios are baseline elapsed time divided by candidate elapsed time, first
paired, then median per case, then geometric mean across cases. All actual
node counts are retained, including early mate/terminal stops. The report
states whether every declared cap was used; an elapsed ratio is not relabeled
as throughput when its denominator represents different work.

`measure.js register` binds exact source, modules, preflight, protocol, runner,
loader and Node runtime identities before execution. The one-shot local
reservation is created with exclusive/no-replace semantics before searching.
Every completed row is durably journaled. Any mismatch or failure is retained,
with no retries, replacement samples or protocol changes. This is a
reproducibility mechanism for the local diagnostic, not a security attestation
against another process running as the same account.

The protocol was committed locally before timing at checkpoint
`ebf085d9f778138273a6bf625a2f4fa3956503b6`; the retained registration binds
the complete frozen protocol and measured-code hashes. This checkpoint is a
local research record, not a separately published admission approval.
The measured code, protocol and
registration stayed unchanged through the single completed run. The declared
download budgets remain 40 KiB raw and 20 KiB Brotli-11, with authoritative
compression pinned to Node 22.23.2 / Brotli 1.1.0. Fitting them does not grant
production admission. This package supplies no formal match, holdout, paid
compute, rating, physical-device or universal-equivalence claim.

## Completed local diagnostic

The one registered run completed all 672 rows: 104 warmups, 432 primary-panel
searches, 128 separately seeded searches and eight conditional Master
searches. All 280 measured fixed-node pairs have identical complete results;
every fixed-node search used its entire declared cap. There were no failures,
retries, replacement samples or post-measurement changes to the protocol or
measured implementation.

| Panel | Node budget | Geometric elapsed-cost ratio | Elapsed reduction |
| --- | ---: | ---: | ---: |
| Original 18 positions | 10,000 | 1.074064 | 6.90% |
| Original 18 positions | 36,000 | 1.084218 | 7.77% |
| Original 18 positions | 230,000 | 1.082121 | 7.59% |
| Separate seeded opening panel | 10,000 | 1.062545 | 5.89% |
| Separate seeded opening panel | 230,000 | 1.045620 | 4.36% |

Elapsed reduction is `1 - 1 / ratio`; it is not the ratio's percentage increase.
At 230k, the original panel's phase medians were 1.043550 for openings,
1.044167 for middlegames and 1.124418 for endgames. They triggered the
predeclared follow-up. Individual position/pair results remain in the report;
positive aggregate ratios do not establish a gain in every position.

The eight-second Master observations searched more nodes with compact hashing,
while retaining the same completed depth, move and White-POV score in every
pair. These four pairs are descriptive observations, not a strength test.

| Position | Pair | Baseline nodes | Candidate nodes | Completed depth, both | Move and score, both |
| --- | ---: | ---: | ---: | ---: | --- |
| Ruy Lopez | 1 | 5,434,367 | 6,730,751 | 8 | `f8d6`, 0 cp |
| Ruy Lopez | 2 | 5,946,367 | 7,081,983 | 8 | `f8d6`, 0 cp |
| Lucena | 1 | 9,592,831 | 11,127,807 | 13 | `c1e1`, +368 cp |
| Lucena | 2 | 11,220,991 | 11,451,391 | 13 | `c1e1`, +368 cp |

The actual runtime was Node **24.22.3**, recorded with CPU and runtime details
in the registration. Its Brotli **1.2.1** diagnostic measured 17,729 baseline
and 17,957 candidate bytes at quality 11, a 228-byte increase. Raw size rose
724 bytes, from 37,210 to 37,934. The compression observation is not the pinned
Node 22.23.2 / Brotli 1.1.0 authoritative size gate.

`evidence/measurement.json` and `rows.jsonl` preserve every raw result and
elapsed time. `summary.json` mirrors the derived summary, while `raw-logs.json`
retains exact log text. `evidence/identity.json` binds 17 measured-code,
source, preflight, registration and result artifacts. The separate post-run
`verify-evidence.js` pins that identity, reconstructs the entire balanced
schedule, independently recomputes summaries and routing, and checks each
seeded timed result against its actual-export preflight. It also replays legal
moves/PVs through the pinned JavaScript rules and checks the frozen r69
signatures. Its 25 mutation tests reject coherent row/journal changes, omitted
rows, altered seed forwarding, fabricated summaries and extra follow-up rows.
This verifier never imports the measured runner or executes a search.

The [static resource review](RESOURCES.md) binds the compiled memory and stack
accounting. [Activation readiness](ADMISSION.md) links the separate signature
proposal and records the remaining production requirements.

## Reproduce correctness

Keep the pinned source commits available as Git objects. Generate an external
crate, use a fresh Cargo home/target with no ambient Cargo config or Rust
wrappers, run the pinned native tests, and invoke the unchanged `build.sh`
through `sh` with Rust 1.97.1 and Binaryen 131.

```sh
node experiments/wasm/compact-hash-r86/prepare.js /absolute/new-crate
# Run cargo test --locked --offline and sh build.sh in that external crate,
# with the repository's unchanged pinned toolchain and isolated build paths.
node experiments/wasm/compact-hash-r86/validate.js /absolute/new-crate /absolute/new-validation.json
node experiments/wasm/compact-hash-r86/probe.test.js /absolute/new-crate
node experiments/wasm/compact-hash-r86/verify-evidence.js
node experiments/wasm/compact-hash-r86/verify-evidence.test.js
```

The validator compares the freshly built candidate with the frozen 4f63 module
identity, rather than accepting a newly self-consistent source/module pair.
Routine CI should reproduce source, build and correctness only; it must not
repeat the registered development timing run.
