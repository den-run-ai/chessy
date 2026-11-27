# E3 analysis baselines for provider 2.0.1

The [versioned JSON fixture](ANALYSIS-BASELINE-v2.0.1.json) records the actual
34-case train/validation scorecard from compact hashing with coaching engine
identity `chessy-wasm` **2.0.1**, provider `rust-wasm-abi-v2`. Its only difference
from the retained [2.0.0 fixture](ANALYSIS-BASELINE.json) is
`/analysis_engine/version`: `2.0.0` becomes `2.0.1`.

Every other field is identical: corpus and options, all counts and quality
values, accepted-move criterion v1, all 12 per-puzzle equivalence records and
their diagnostics, regret samples, totals and the strict gate. There is no
numerical rebaseline, missing coverage or tolerance change.

The separately measured [full 103-case fixture](ANALYSIS-FULL-BASELINE-v2.0.1.json)
also preserves every score, option, coverage field and all 40 equivalence
records from [its 2.0.0 baseline](ANALYSIS-FULL-BASELINE.json). Its declared
differences are the same provider-version update and omission of the old
archival `baseline_release: r73` and
`baseline_commit: 07b29d39c07761bd9e1cec242ac16e0435e15f7a` annotations.
The unchanged CLI does not emit those annotations. They remain in the original
file and are never relabeled onto a new result.

## Provenance and preserved history

Both runs used the r86 activation's compact WASM module from source commit
`173e06fd29f587f7de1ab9a84ad990760d7f23ae`, with module SHA-256
`4f63b8dd25b4ae6787d1720392417a60daab1066bef7d494060939cb2016f74c`
and analysis engine version 2.0.1. Each JSON is the unmodified output of
`test/eval/analysis-scorecard.js --out`, not a manually relabeled historical
result. Both original comparisons against their old baselines correctly failed
provider compatibility even though every measured value matched.

| Retained file | SHA-256 |
| --- | --- |
| `ANALYSIS-BASELINE-v2.0.1.json` | `5bd289a2e781102295960a475478ea3e87ab3fe3115f308377f51a85ff6640b9` |
| `ANALYSIS-BASELINE.json` | `20d3a1d1c302886b3dc2a558ed5887435c38af9cab4c0d884e5b4b6f3b8cd8d0` |
| `ANALYSIS-BASELINE.md` | `5067241a8c66d00769bc8fb80fd07253d9d880c5b66c62009da4aa0ad534fe18` |
| `ANALYSIS-FULL-BASELINE-v2.0.1.json` | `d1f25be76f8fd9bb0441c03d84444ffcfa9306d28b54c2df4d3a8b71e740eabd` |
| `ANALYSIS-FULL-BASELINE.json` | `5f4b4675220f449256cce6d489f2d769796ac66c86c5ed3b31b380aa18ce7e98` |

The original JSON files and [baseline report](ANALYSIS-BASELINE.md) remain byte
for byte unchanged, retaining their historical provider, measurements and
fault inventory. The separate versioned fixtures are the PR-shard and
weekly/manual full comparisons for
2.0.1. The full analysis run reports 103/103 complete-root checks, 40/40
played-rank checks and zero strict failures. The accompanying 117-case rules
check passes all 310 checks against its unchanged correctness baseline.

## Gates and reproduction

```sh
node test/eval/analysis-baseline-transition.test.js
node test/eval/analysis-scorecard.js --baseline eval/ANALYSIS-BASELINE-v2.0.1.json
# Weekly/manual pre-release comparison of the already-consulted full corpus:
node test/eval/analysis-scorecard.js --full --baseline eval/ANALYSIS-FULL-BASELINE-v2.0.1.json
```

The transition test authenticates all five retained files and compares each
entire score vector after the declared provider-version update and, for full
mode only, verifying and removing the two exact old archival annotations.
Mutation cases reject altered provenance, budgets, criterion, coverage,
quality in either direction, regret including full-mode p99, per-case grading,
diagnostics and misattributed old release/commit annotations. This
test checks fixture preservation without searching. The real scorecard still
enforces provider identity, strict output contracts, directional quality
ratchets and exact accepted-move outcomes; its comparison code is unchanged.

The [accepted-move criterion](EQUIVALENCE-CRITERION.md) requires a reviewed
version and fixture change when grading semantics change. This transition
changes provider identity only; criterion v1, its 30 cp policy and every
recorded outcome remain unchanged. Stored historical analysis and grading
evidence retain their original identities.

These are the existing 34-case shard and 103-case full development/compatibility
corpus. Full results, including test-tagged records, were already consulted
before criterion v1; this required pre-release comparison does not use a fresh
lockbox or formal match bank. It supplies no new holdout, strength, timing or
physical-device evidence. No full-corpus result is inferred from the shard.
