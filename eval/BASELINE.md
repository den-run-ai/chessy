# eval-v1 correctness baseline (first published)

This is the **first published baseline** for the evaluation tracker
([#87](https://github.com/den-run-ai/chessy/issues/87)): the correctness score
vector over the frozen, license-clean corpus. Per the tracker, strength and
position-quality baselines are **deferred** until the active engine changes in
#72 settle — but the **correctness** vector is version-independent (a correct
engine scores 100% regardless of playing strength), so it is safe to publish and
gate now.

Machine-readable copy: [`BASELINE.json`](./BASELINE.json). Reproduce with
`node test/eval/scorecard.js --json`.

## Before → after (what this PR upgrades)

This PR upgrades the project's *evaluation capability*, not the engine. The
before/after is measured against what the harness could report about correctness
before this change.

| Metric | Before (main @ r36) | After (this PR) |
| --- | --- | --- |
| Release questions answered | 1 — *"did the engine change win a paired match?"* | 2 — win-rate **plus** an 8-axis correctness score vector |
| Correctness axes measured on a frozen corpus | 0 | **8** (`legalRoot`, `terminalStatus`, `specialMoves`, `expectedLegal`, `pvReplay`, `perspectiveMate`, `symmetry`, `determinism`) |
| License-clean frozen eval cases | 0 (tactics/match positions are inline, unprovenanced) | **117** committed with full provenance — **80 real CC0** (40 Lichess puzzles + 40 openings) + 37 MIT fixtures (shard: **64**) |
| Correctness checks per PR (deterministic) | 0 | **177** on the frozen 64-case shard, `<1 s` wall time |
| Legal-root oracle | none | independent (chess.js, a separate rules impl) in CI, folded into `legalRoot` |
| Corpus integrity / provenance | none | sha256-verified ndjson + per-record `license`/`source`/`sha`, and sha256-verified raw CC0 sources |
| Gate on lost checks / broken PV / mate-sign / colour-symmetry regression | none | **strict, blocks the PR** (`--baseline` runs in CI) |

Score vector on the frozen shard (this PR):

```
eval-v1 correctness scorecard — shard (64 cases)
  legalRoot        ok  64/64
  terminalStatus   ok  60/60
  specialMoves     ok  22/22
  expectedLegal    ok  13/13
  pvReplay         ok  6/6
  perspectiveMate  ok  4/4
  symmetry         ok  4/4
  determinism      ok  4/4
  TOTAL                 177/177 checks  →  gate PASS
```

Full corpus (`--full`): **310/310** checks across all 117 cases (adds the
remaining live-position, puzzle key-move and opening legality checks), gate PASS.

### The gate has teeth (not a vacuous 100%)

`node test/eval/scorecard.js --self-test` injects one deliberately wrong
expectation (a flipped mate sign / distance) and confirms the gate turns red:

```
self-test (inject a wrong mate expectation): gate correctly went RED ✓
```

The same mechanism that detects the injected discrepancy is what would fire on a
real engine regression: an illegal PV move, a mate reported for the wrong side,
a colour-asymmetric best move, or a non-deterministic result would each drop its
axis below 100% and fail the PR. On every subsequent change,
`--baseline eval/BASELINE.json` prints the per-axis before/after and fails on any
axis that regresses.

## Decision

**Adopt the correctness scorecard as a strict, blocking PR gate at 100%, and
publish this vector as the frozen eval-v1 correctness baseline.**

- The frozen 64-case shard runs on every PR (wired into `.github/workflows/test.yml`),
  along with a check that the committed corpus matches a fresh **offline**
  generation from the committed CC0 sources.
- The full corpus (117 cases) is available via `--full` for nightly / pre-release runs.
- **Deferred, on purpose:** the strength, position-quality, and level-calibration
  baselines (and the Syzygy exact-WDL + rotating OOD corpus tranches) wait for the
  #72 engine work to settle, per the tracker — this baseline captures only the
  version-independent correctness axis.
