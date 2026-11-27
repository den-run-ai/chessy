# Compact hashing with seeded openings: static resource review

This package reviews the combined compact-hash and seeded-opening module as
a separately identified candidate. It records static resource accounting;
it runs no searches or timing campaign and grants no production admission.
The earlier unseeded compact-hash candidate and its preparation records are
unchanged. Their identities and measurements are not reassigned to this module.

## Exact inputs

| Input | Seeded baseline | Combined candidate |
| --- | --- | --- |
| Published source commit | `3b32d2e7c23341d2245003c5324aa2ee6d07aa08` | `173e06fd29f587f7de1ab9a84ad990760d7f23ae` |
| WASM SHA-256 | `a18affeb07590eaf5610c01a73701d745a05e1ed3f53a257ccc93c4176bd96d7` | `4f63b8dd25b4ae6787d1720392417a60daab1066bef7d494060939cb2016f74c` |
| WASM bytes | 37,210 | 37,934 |
| Initial / maximum memory pages | 405 / 405 | 405 / 405 |
| Linear memory bytes | 26,542,080 | 26,542,080 |
| Reserved linear stack bytes | 1,048,576 | 1,048,576 |

[`resource-audit.js`](resource-audit.js) reads both modules and both source
guard pairs (`search.rs` and `lib.rs`) from the exact Git commits above with
replacement objects disabled. It verifies every expected hash before
disassembly. The separately supplied candidate build must equal the candidate
module retained in its source commit. This also works from an evidence-only
checkout whose current production source or module differs.

Binaryen 131 disassembles the retained buffers. The report binds the audit
implementation, disassembler binary, source inputs, module bytes and complete
disassembly hashes. Both modules import only `env.now_ms`; neither grows
memory or uses indirect calls. Unexpected stack-pointer forms, unknown call
targets and mutual-recursion cycles are rejected.

## Stack argument for these modules

Both generated modules have two directly recursive functions, `$8` and `$12`,
with 32-byte linear-stack frames. Removing their self-edges leaves an acyclic
call graph. Compact hashing adds a nonrecursive helper with no linear-stack
frame. The ordinary `search` entry is a zero-frame wrapper around the guarded
`search_seeded` entry: `$24` → `$25` in the baseline and `$25` → `$26` in the
candidate. Its fixed default seed and the variable Play seed do not alter
the depth guards or recursion limits.

The inspected ABI admits search depth at most 111. Fixed search can therefore
have 112 simultaneously active search calls, at depths 111 through 0. At the
leaf, quiescence can have 17 calls, at qply 0 through 16. Ordinary and exact-root
search enter one ply deeper and cannot have a longer chain. Every recursive
search call decreases depth; every quiescence call increases qply toward its
guard. PVS re-searches occur sequentially.

The audit sums **all** nonrecursive function frame allowances once. This
deliberately includes functions that cannot all be active on one call path.
The seeded search entry's 1,152-byte allocation and its additional 16-byte
scratch area are included, giving a total allowance of 4,224 bytes. The
conservative bound is identical for baseline and candidate:

```text
4,224 + (112 + 17) × 32 = 8,352 bytes
```

This is approximately 0.80% of the unchanged 1 MiB reservation. It assumes
admitted ABI calls, the standard clock import returning without re-entering
WASM, normal stack restoration, and retirement of trapped instances.

The syntax checks supplement inspection of the fixed prologues, restoring
normal exits, and recursion guards for these exact bytes. They are not a
general control-flow proof for arbitrary compiler output or arbitrary memory
bugs. The result is an upper accounting bound, not an observed peak or a
bound on the browser engine's native/operand stack. No physical-device,
thermal, battery, browser-tail-latency, strength or search-cost result follows
from it.

## Reproduction

Both pinned commits must be available in the local Git object database. Given
the separately rebuilt candidate module and the Binaryen 131 disassembler:

```sh
node experiments/wasm/compact-hash-r86/resource-audit.js /absolute/built/chessy-ai-fast.wasm /absolute/binaryen-131/bin/wasm-dis
```

[`resources.json`](resources.json) retains the output, including every compiled
function's frame allowance and direct call list, the checked exported entry
points, all input identities, and the arithmetic above. Signature evidence,
correctness tests, browser verification and any new search-cost observations
remain separate records for the combined candidate.
