# Versioned engine signatures (issue #155)

This is the mechanism and self-test stage. No candidate contract is activated.
The r69 generator and fixture are byte-for-byte immutable; the active manifest
still selects that ordinary-search behavior for the unchanged ABI-v2 runtime.

## Prepare an unapproved proposal

First land this mechanism. Use a clean checkout of that reviewed commit, the
pinned Rust 1.97.1 (`8bab26f4f68e0e26f0bb7960be334d5b520ea452`) and Binaryen
131 tools, and full 40-character source commits. Both commits must already
contain their exact rebuilt production module. The command never copies a
module to production and never selects a new active contract:

```sh
node test/engine-signatures-v2.js prepare /path/to/chessy \
  OLD_FULL_COMMIT_SHA NEW_FULL_COMMIT_SHA /tmp/new-signature-proposal
```

The output directory must not exist. Capture the content-addressed
`wasm-v2-<sha256>.json` plus `complete.json`; incomplete directories are not
completed publications. Add the proposal JSON to
`test/fixtures/engine-signatures/` in a dedicated evidence-review PR. Preparation
requires clean tracked and untracked state. It rejects abbreviated refs, changed
build/lock/toolchain files, unknown Rust source files, symlinks, ambient compiler
flags/wrappers, mismatched committed modules, and unequal independent builds.
Each side is compiled twice in separate temporary snapshots with fresh target
and Cargo directories. Build execution uses only the registered source inventory
and unchanged pinned build script; generated artifacts retain both build hashes.
A future source-layout or build-contract change needs a separately reviewed
mechanism update first.

The bundle binds source commit/tree and every source/build input, raw WASM,
source release, ABI 2, toolchain identity, generator commit and input hashes,
and the exact mirrored corpus and configuration. Every one of the 144 cases
has an old/new diff record, including unchanged cases. Ordinary-search move,
White-POV score, mate encoding, completed/attempted depth, nodes, qnodes,
cutoffs, re-searches, and stop reason are retained.

Ordinary search does not export a PV. Each nonterminal case therefore also
has a **separate** exact-root probe of the selected move at completed depth
clamped to 1–3, with a 5,000-node cap and requested PV length 16. It records
complete/aborted state, counters, score/mate, and a PV replayed through the
independent JS rules engine. An aborted root exposes an empty PV. These probes
are not mislabeled as ordinary-search trajectories.

## Review, then select in a separate PR

Review every changed field, together with independently required correctness,
runtime/device, and strength evidence. This mechanism does not establish any
of those gates. Merge approved evidence before a separate activation PR changes
`test/fixtures/engine-signatures/active.json` to this shape:

```json
{
  "schema": 1,
  "kind": "reviewed-abi-v2",
  "evidence": "test/fixtures/engine-signatures/wasm-v2-FULL_SHA256.json",
  "evidenceSha256": "FULL_SHA256",
  "sourceCommit": "NEW_FULL_COMMIT_SHA",
  "sourceRelease": "rNN",
  "abi": 2
}
```

The release-gate step extracts verifier code and dependencies from the trusted
base selected by the existing PR/main-push workflow. It requires proposal bytes
to already exist unchanged in that base, recomputes all 144 old/new signatures
and the full diff, and checks the old module against the base's active runtime.
A candidate-supplied `approved: true`, self-authored passing result, newly added
proposal, edited proposal, or caller-selected local ref is not CI authorization.
Existing evidence is never overwritten or relabeled. The active pointer itself
must also receive ordinary PR review.

Repository review and trusted-base selection are the authority. This is not a
cryptographic maintainer signature or a substitute for branch protection. The
repository's existing workflow is still subject to review: a PR that changes
that workflow must not bypass the base verifier. Local `verify REPO BASE_SHA`
commands are reproduction tools; their caller-selected SHA is not an independent
approval. The mechanism bootstrap accepts only the hard-pinned legacy module
and source. A new mechanism version must land before a proposal needs it.

The recorded `sourceRelease` is the release at the exact engine source commit.
Later UI-only release bumps do not change that historical source identity;
normal release-unit CI separately enforces the current app's coherent `rN`.
Every subsequent engine source/module change needs a new approved bundle.

## Tests and current limitations

```sh
node test/engine-signatures-v2.test.js
node test/engine-signatures-v2.js verify .
node test/wasm-signatures.test.js
```

The self-tests cover immutable history, the original generator's non-r69
rejection, dirty/unpinned sources, aliases, compiler overrides, complete case
inventory, deterministic signatures, visible move/score/node/depth/mate/PV
differences, malformed paths, self-approval, evidence absent from the trusted
base, and source/module drift. They execute the strict ABI-v2 loader and legal
PV replay. No paid compute is needed.

An evidence-review PR must independently reproduce preparation with the pinned
tools; a JSON hash is integrity evidence, not proof a claimed build occurred.
Current CI independently rebuilds the candidate production asset, while the
mechanism checks proposal records and replays both modules. Formal strength
admission remains separately governed by #175 and physical devices by #84.

### Mechanism validation, 2026-09-15

At generator commit `78c4fe6`, preparation compared
`d56a745c3bdb373e9fa23fca0d48b2b6e9f21114` with itself. All four independent
pinned builds reproduced
`57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f`.
The complete 144-case diff had zero changed cases; bundle SHA-256 was
`791142046cfc947e810cf1c6a2439e5b05a1b58e0fb56232b849c3f692e30145`.
This was a mechanism smoke, with $0 paid compute. No proposal fixture was
installed and the active manifest remained legacy. The self-tests also rebuilt
the historical fixture from exact r69 module bytes without changing its hash.
