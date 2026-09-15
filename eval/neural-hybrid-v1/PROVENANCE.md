# Hybrid execution and publication provenance

The locally committed execution trees were published through the authenticated
GitHub connector. The publication commits have different authorship timestamps
and therefore different commit IDs; the corresponding complete Git trees are
identical. Execution receipts retain the original local IDs and exact source
hashes. These mappings avoid treating a publication timestamp as an experiment
start timestamp.

| Stage | Local execution/source commit | Public mirror commit | Identical tree |
| --- | --- | --- | --- |
| Original registration; stopped before scores on comparator dtype | `d94e95b` | [4fc5afa](https://github.com/den-run-ai/chessy/commit/4fc5afa9142948bdee09c9de5d6c76cb30cc2ae1) | `2aeaf7aec58fcfe43408ba1ae5c916e21235c4ab` |
| Separately registered integral-score recovery and completed screen | `cd39d44` | [7e61901](https://github.com/den-run-ai/chessy/commit/7e61901bdfcaf89d477aa7f85bc27f2aa5bdbcce) | `6c6d4c642b12a88ac7883b392c0601f405428e5d` |
| Compiled runtime and full two-arm match registration | `5098859` | [577d4ab](https://github.com/den-run-ai/chessy/commit/577d4abcaee6c86099120963023ad6bcef1a3401) | `199d4e238858c208882ada2577d4927aa07260dc` |
| Final match input/IPC implementation | `92a608a` | [300984d](https://github.com/den-run-ai/chessy/commit/300984dbb8277551f5e80e6e3ca74620be2c9e87) | `3b19cc313d0d8d5f1ddfb9f2301dbb5bdd57ef48` |
| One-shot test contract and development report | `a5c27ba` | [5eb2f56](https://github.com/den-run-ai/chessy/commit/5eb2f56924e47b8acba69df5d82505694ceb9835) | `ef61eb31e420f195f91e8f512156d06fbd27d06b` |
| Independent screen audit, measured compiled cost, CI gates | `59010ee` | [0987787](https://github.com/den-run-ai/chessy/commit/098778739409059d23513ceca1067c29a4393d18) | `0b9c67eee62115b40300565bde293f918efd829f` |
| Two prospective runtime mechanisms and conditional follow-up | `2a4afed` | [5bc370c](https://github.com/den-run-ai/chessy/commit/5bc370cc3c39b99e9c6c8aac28a6978603892938) | `58d3ed8f2f27711cd2522e85fd24e49c0dda7083` |
| Audited one-shot test and bounded mechanism results | `6cf2902` | [c935ba6](https://github.com/den-run-ai/chessy/commit/c935ba69c36014e6ff9414f803d3684fb4afaa43) | `abec6f987ef8e87d9037c24f8ff4799014c371e3` |
| Separate match infrastructure recovery and capture fault tests | `bf80f8d` | [58fa742](https://github.com/den-run-ai/chessy/commit/58fa74268835faaacaefeed2bfda75daf044f75d) | `ca3142131c73e750dbbcde8a8e8ccec64275fc39` |
| Independent recovery archive replay, frozen before new game outcomes | `12b8369` | [b4785d2](https://github.com/den-run-ai/chessy/commit/b4785d27f3dedfe2f07ca305cbdadc02e6456b61) | `99abdcea7831352b99e2c48b4e6baa33cfafe61e` |
| Prospective lazy accumulator and separate conditional game protocol | `b4e4e26` | [8ce1c03](https://github.com/den-run-ai/chessy/commit/8ce1c034a073d3518394dce521b8d23b626a1b10) | `0bc6760558b02e5d7eabce02996c3a506d392d4b` |
| Reviewed lazy source and native validation, before execution | `9d01299` | [1f61789](https://github.com/den-run-ai/chessy/commit/1f61789e1a21c5be1bf7f9493956f6a2e005ffd7) | `5d22145143e6f8baaa80695baddae2e3f631d0ef` |

The frozen H8 checkpoint is the earlier v4 full-data refit, SHA-256
`3a759a37d3af0beed0dda352a05294686d286176a4dcbdfa85a3fabef0083f25`.
The separately retained development checkpoint selected the gate; the refit was
not used to score its own training rows for gate selection. Both development
sets were previously exposed. The separately registered once-only test provided
the fresh teacher-loss measurement; its opening and completion markers are now
consumed and preserved.

The first screen failure, its original executable, registration and consumed
state are retained. The offline-screen dtype recovery changes only an input adapter: finite,
bounded, exactly integral comparator values are converted from float64 to
int64. No gate scores existed before that failure, and the six configurations,
model identities, selection rule and quality thresholds stayed unchanged.

The separate [match capture incident](../training/hybrid-match-results-2026-09.md)
invalidated the original 400-game batch before score analysis: 62 files were
truncated despite their earlier verified close receipts. Its missing tails
were never reconstructed. The separately registered match infrastructure
recovery uses the identical original models and 400-task schedule with retained
canonical bytes and a new once-only marker. It does not change the skipped
conditional 200-game extension or make the original batch valid.

The replacement completed with all 400 games independently replayed from its
401-member archive. Its hybrid score was 41.5% against shipped HCE; expanded HCE
scored 49.0% in its separate arm. The later lazy-accumulator plan and conditional
game trigger were frozen before these outcomes and before lazy cost measurement.
That implementation gained 3.696% overall NPS versus the original hybrid and
missed its 5% gate; its separate 200-game extension was skipped too.

Paid-compute accounting is scoped to this continuation: no Modal jobs were
launched and no paid compute was incurred. The user's monthly $30 ceiling was
not treated as a spending target. Local CPU work and repository CI are reported
separately and do not establish an account-wide billing balance.

Private evidence contains fitted parameters, emitted fitted Rust source,
compiled modules, full measurement records, state and authenticated recovery
receipts. Public reports contain code and aggregate evidence without the
trained parameter values. No production evaluator, level, release token,
memory cap or shipped WASM is changed by these research experiments.
