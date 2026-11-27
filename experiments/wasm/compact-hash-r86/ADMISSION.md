# Seeded compact hashing: evidence and activation readiness

Status: **prepared for evidence review; production activation is pending**.
This package binds the combined implementation to its source, reproduced
module, finite correctness checks, static resources and complete development
measurements. It does not approve its own activation or supply physical-device
observations.

## Candidate identity

| Item | Identity |
| --- | --- |
| Reviewed baseline | `f27f05581c4be6bb35e230e1ffd01a62edf67541` (r85; same tree as merged `1efcb98d23d22fe379c1e727682e4d04a380e264`) |
| Baseline WASM SHA-256 | `a18affeb07590eaf5610c01a73701d745a05e1ed3f53a257ccc93c4176bd96d7` |
| Prepared source snapshot | `173e06fd29f587f7de1ab9a84ad990760d7f23ae` (source release r86) |
| Candidate WASM SHA-256 | `4f63b8dd25b4ae6787d1720392417a60daab1066bef7d494060939cb2016f74c` |
| Candidate search source SHA-256 | `4db05a27ae42560d6f45920859f9916eb84d0df3d59ab3eca95a4e53ed75ffc4` |
| Reviewed signature generator | `5e3558378deab8ba21f648cc2cca98195b1beced` |
| Signature bundle SHA-256 | `fbd74c91e12209d8c3ee6281b254a2d837b44e6b34eeef87f3b33ece4f9ea46b` |
| Raw download | 37,934 bytes; current ceiling 40,960 bytes |
| Fixed linear memory | 26,542,080 bytes |

The source snapshot is a preparation artifact, not a deployment. Keep it
reachable while its evidence is retained. A later UI release may have a higher
number without changing this historical source-release identity. The generator
is an ancestor of reviewed main; its five implementation inputs are unchanged
through the r85 baseline.

The [signature bundle](../../../test/fixtures/engine-signatures/wasm-v2-fbd74c91e12209d8c3ee6281b254a2d837b44e6b34eeef87f3b33ece4f9ea46b.json)
records two independent pinned builds of each source and **144 comparisons
with zero changed fields**, including separate exact-root/PV probes. A second
reviewer independently repeated all four builds and reproduced the entire
bundle byte for byte. CI repeats that preparation using the unchanged reviewed
generator before the evidence PR is eligible to merge. This reproduction is
not an activation receipt.

## Equivalence argument and finite coverage

The original two 32-bit piece-square streams occupy disjoint halves of one
64-bit value. XORing packed keys and splitting the result preserves the two
original XOR reductions. For each searched legal edge, removing old
piece-square keys and adding new ones gives the same board component as a
full scan. The checked update covers captures, the separate en-passant square,
both castling-rook squares and the actual destination piece after promotion
or underpromotion.

Each recursion receives an immutable local value. Siblings, unmake, aborts,
legality probes and PVS re-searches cannot invalidate a shared hash cache.
Root setup, loaded repetition history and PV reconstruction retain full scans.
Turn/castling suffixes and the distinct raw-EP TT versus legal-EP repetition
semantics are unchanged. The implementation retains r85's seeded root order,
evaluation, move ordering, pruning, replacement policy and node accounting.

The exact original seeded search remains as a separate test-only reference.
The [correctness package](README.md#correctness-before-timing) records 16 native
tests, 45,719 legal-edge checks, 120 ordinary and 120 fixed-search comparisons,
312 shared-budget exact-root/PV cases, 216 seeded special-position/budget pairs
and 108 legal-history pairs. The compiled preflight checks all 144 frozen
ordinary signatures and paired roots, plus explicit seed transport, seed
effect, default-seed equality and history-sensitive cases. Independent source
review inspected the update invariant and its callers. These are finite
observations and a local source argument, not a universal proof of equivalence.

## Software and resource preparation

- [x] Exact checked source and unchanged Rust 1.97.1 / Binaryen 131 build.
- [x] Native differential tests and independent signature reproduction.
- [x] Source-bound [static resource audit](RESOURCES.md): the same conservative
  8,352-byte linear-stack allowance and fixed memory for baseline and candidate.
- [x] One prospectively frozen development comparison, with every raw row,
  failure rule and registration retained; no reruns or revised thresholds.
- [x] Historical compact-hash correctness adapters read their original r82 Git
  inputs, without changing or relabeling old measurements.
- [x] Production accounting checks exclude test-only reference copies while
  retaining all required guards and mutation-sensitive bypass tests.
- [x] Separate activation patch advances coaching identity to 2.0.1, preserving
  old analyses while preventing their reuse for the changed engine.

The evidence CI independently regenerates source, reruns native and compiled
correctness, reproduces the static report, and checks the current 40 KiB raw /
20 KiB Brotli-11 limits with Node 22.23.2 / Brotli 1.1.0. Local Node 24 compressed
sizes remain diagnostic. The static bound is not browser-native-stack or
physical process-memory evidence.

The [development results](README.md) belong only to the exact r85/combined
module pair above. The earlier unseeded compact-hash and original incremental
hash experiments retain their distinct identities. No result here is an Elo
claim or a formal finite-bank admission result.

## Remaining production requirements

The merged [formal contract](../../../eval/match-formal/CONTRACT.md#pure-search-cost-improvements-need-a-different-admission-policy)
keeps pure search-cost changes outside its selective-search/strength campaign.
The [separate proposal](../SEARCH-COST-ADMISSION-PROPOSAL.md) has no admission
authority. Faster execution can complete a different iteration before a
deadline, so matching fixed-node results alone do not establish product-runtime
readiness.

- [ ] Separately review and adopt the concrete equivalence/runtime admission
  decision and its trusted enforcement for this candidate.
- [ ] Before admission measurements, freeze actual target devices, sample
  inventory, runtime criteria, uncertainty treatment and failure rules.
- [ ] Supply authentic candidate-bound iOS/WebKit and Android/Chromium evidence
  for required startup/search/delivery, sustained operation, pressure,
  background/retry and offline/upgrade behaviors under
  [#84](https://github.com/den-run-ai/chessy/issues/84).
- [ ] Review those receipts separately, then activate the already-reviewed
  signature bundle in a coherent release with full final-head CI.

The development timing protocol cannot be retroactively promoted into the
missing admission schedule. Historical r63/r69 phone sessions do not measure
this candidate. No physical observations are newly complete; no formal match,
fresh holdout search or paid compute was run.

## Merge sequence

The evidence PR retains deployed Rust, WASM, release tokens and the active
signature pointer. Its review can complete independently of production
activation. The separate activation PR carries the exact search implementation,
module, coaching identity, provenance assertion, active pointer and coherent
release. The existing [signature procedure](../SIGNATURE-ROTATION.md#review-then-select-in-a-separate-pr)
requires the approved evidence to be present unchanged in the trusted base
before that activation. Full engine/browser checks and the remaining runtime
decision still apply; merging this evidence does not mark them satisfied.
