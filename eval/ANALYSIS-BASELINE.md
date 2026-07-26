# eval-v1 analysis & coaching baseline (E3, first published)

The **first published analysis/coaching score vector** for the evaluation
tracker ([#87](https://github.com/den-run-ai/chessy/issues/87)) — the **E3**
slice, on the same frozen, license-clean corpus the E1/E2 slice froze. Where
the correctness scorecard ([`BASELINE.md`](./BASELINE.md)) asks *"is the
engine's output legal and deterministic?"*, this one asks *"is the analysis the
coaching panel shows actually **good**?"* — answered as a **score vector, not
one headline number**, per the tracker's central rule.

Machine-readable copy: [`ANALYSIS-BASELINE.json`](./ANALYSIS-BASELINE.json).
Reproduce with `node test/eval/analysis-scorecard.js --json`.

Every number is measured at a fixed **node** budget, so it is
machine-independent and bit-reproducible — not a wall-clock or Elo figure.
Strength / level-calibration baselines (E4) remain **deferred** until the
active #72 engine changes settle, per §7 of the tracker.

## Two gate classes

The axes are split by what they actually measure, so a quality number can never
silently become a build-breaking assertion — or vice versa:

| Class | Axes | Gate |
| --- | --- | --- |
| **STRICT** — output *contracts*, version-independent | `rootComplete`, `playedRank` | **100%, blocks the PR** |
| **QUALITY** — position-quality measurements | `puzzleTop1`, `puzzleRecall3`, `pvStability`, `budgetStability`, `regret` | **ratchet**: may improve, may never regress |

An unsolved puzzle is therefore a *measured quality level*, not a broken build —
it fails only if a later change makes it worse. The engine is deterministic
(proven by the E2 `determinism` axis), so the ratchet is **exact** — no
tolerance band. Coverage is part of the score: the fraction axes' `checked`
counts and the regret sample `n` fail the ratchet when they shrink.

| Axis | What it measures |
| --- | --- |
| `rootComplete` | The **whole result** passes the shipped `ChessyAnalysisResult.validate` (provenance against an independently derived identity, `complete === true`, depth/stability integrity, top-level and per-line evaluations, full line resolution, ordering, duplicates) — **plus** the E3-specific requirement that `bestLines` covers **every** legal root: a true MultiPV, not a shortlist |
| `playedRank` | The shipped-width result also passes `validate` (with `requirePlayed` + the expected `playedMove`), **plus** the key move's reported `rank` equals its **true** rank over all roots — the tracker's *equivalent-move recognition* |
| `puzzleTop1` | Acceptable top-1: the crowd-validated CC0 Lichess key move is the engine's #1 line |
| `puzzleRecall3` | Oracle best recall@3: the key move is among the top 3 |
| `pvStability` | Best move unchanged one ply shallower — **derived independently** (a fixed-depth search at d−1), never read off the engine's own stability flag |
| `budgetStability` | Best line unchanged at **¼×** the scan budget (`--full` adds the **4×** tier). A tier is graded only if the shipped validator accepts its result — an incomplete or malformed auxiliary analysis is a miss, and its regret counts as catastrophic, never a skip |
| `regret` | Median / p90 (/ p99 in `--full`) centipawn regret of the quick-scan pick re-scored at full depth, plus a catastrophic-miss count |

Per the tracker, oracle comparison deliberately **avoids exact centipawn/PV
equality**: acceptable-move sets, set overlap, budget invariance and a regret
*tail distribution*. The only external oracle is the CC0 Lichess puzzle key
move, so the run stays offline and needs no GPL engine.

The shipped candidate width used by `playedRank` is **derived from
`assets/reflection.js` at run time**, never duplicated: if the app changes its
coaching width, `e3_opts` changes with it, the committed baseline goes
incompatible, and the gate forces a conscious re-baseline — and if the CFG
declaration ever moves, the run fails loudly rather than silently testing a
stale width.

## Baseline — frozen E3 PR shard (34 train/val cases)

```
eval-v1 ANALYSIS scorecard — shard (34 cases)
  corpus eval-v1 @ eval-v1.0.0
  rootComplete     strict  ok   34/34
  playedRank       strict  ok   12/12
  puzzleTop1       ratchet score 9/12
  puzzleRecall3    ratchet score 10/12
  pvStability      ratchet score 18/27
  budgetStability  ratchet score 26/34
  regret cp        ratchet score median 0  p90 5  catastrophic 0/34
  STRICT gate           PASS (0 strict failures)
```

The shard is every **train/validation** shard puzzle (all five difficulty bands
stay represented) plus the core, live generated fixtures — **~9 s**, small
enough to run on every PR. The corpus's held-out **test** split is excluded: a
per-PR ratchet is selection pressure, and the tracker's rule is *never tune on
the test split* — test records are measured only by the `--full` nightly /
pre-release run below.

## Full corpus (`--full`, 103 live cases)

```
  rootComplete     strict  ok   103/103
  playedRank       strict  ok   40/40
  puzzleTop1       ratchet score 27/40
  puzzleRecall3    ratchet score 34/40
  pvStability      ratchet score 56/81
  budgetStability  ratchet score 68/103
  regret cp        ratchet score median 0  p90 17  p99 440  catastrophic 0/103
  STRICT gate           PASS (0 strict failures)
```

**407 checks, 0 strict failures**, ~95 s — a nightly / pre-release run.

### The solve curve declines with puzzle difficulty

Top-1 solve rate over all 40 CC0 puzzles, by **puzzle-difficulty** band (not an
Elo estimate):

| Band | `<1000` | `1000–1399` | `1400–1799` | `1800–2199` | `2200+` |
| --- | --- | --- | --- | --- | --- |
| top-1 | 7/8 | 8/8 | 7/8 | 5/8 | **0/8** |
| recall@3 | 8/8 | 8/8 | 7/8 | 7/8 | 4/8 |

The trend is strongly decreasing and tracks genuine difficulty, but it is
**not strictly monotonic**: the two easiest bands invert by a single puzzle,
which at n = 8 per band cannot be distinguished from chance. Establishing the
strict *monotonic puzzle curve* the tracker names under level calibration needs
a materially larger per-band sample and is **E4** work — this baseline does not
claim it. What the curve does establish is that the corpus spans the engine's
competence boundary (the hardest band is unsolved at top-1 yet half-recalled at
top-3), so the ratchet has headroom in both directions.

### Reading the quality misses

The `pvStability` / `budgetStability` misses concentrate on the deliberately
balanced castling and en-passant fixtures, where several roots are
near-equivalent and a cheaper search legitimately prefers a different one —
exactly the *bounded, near-equivalent* variation the tracker wants
distinguished from a real blunder. That is why these axes ratchet rather than
gate, and why `regret` is reported alongside: **median regret is 0 cp with no
catastrophic misses**, so the disagreements cost essentially nothing.

## The gate has teeth (not a vacuous 100%)

`node test/eval/analysis-scorecard.js --self-test` simulates fifteen distinct
shapes of engine regression in three assertion classes. Thirteen must turn the
strict gate red — **line-level** (MultiPV truncated, missing, unscored; an
invalid mate distance; a mate field absent rather than explicitly null; a
desynchronized centipawn pair; a corrupted SAN; a `move` disagreeing with its
own UCI), **result-level** (headline score desynchronized from `bestLines[0]`;
`stability.depths` not matching the reported depth; tampered provenance; a
`complete` flag truthy but not `true`) and **coaching-level** (corruption
confined to the played line):

```
self-test (truncate-multipv): RED ✓ (37 strict failures; rootComplete 34/34, playedRank 12/12)
self-test (empty-multipv):    RED ✓ (34 strict failures; rootComplete 34/34, playedRank 0/12)
self-test (strip-scores):     RED ✓ (46 strict failures; rootComplete 34/34, playedRank 12/12)
self-test (zero-mate):        RED ✓ (11 strict failures; rootComplete 34/34, playedRank 12/12)
self-test (absent-mate):      RED ✓ (46 strict failures; rootComplete 34/34, playedRank 12/12)
self-test (skew-white):       RED ✓ (46 strict failures; rootComplete 34/34, playedRank 12/12)
self-test (bad-san):          RED ✓ (46 strict failures; rootComplete 34/34, playedRank 12/12)
self-test (skew-move):        RED ✓ (46 strict failures; rootComplete 34/34, playedRank 12/12)
self-test (top-eval-skew):    RED ✓ (40 strict failures; rootComplete 34/34, playedRank 12/12)
self-test (stability-depths): RED ✓ (36 strict failures; rootComplete 34/34, playedRank 12/12)
self-test (tamper-provenance):RED ✓ (46 strict failures; rootComplete 34/34, playedRank 12/12)
self-test (complete-truthy):  RED ✓ (46 strict failures; rootComplete 34/34, playedRank 12/12)
self-test (played-san):       RED ✓ (12 strict failures; rootComplete 34/34, playedRank 12/12)

self-test (incomplete-aux, ratchet):  fully VISIBLE ✓ (budgetStability 0/34, regret catastrophic 34/34, strict gate correctly unaffected)
self-test (liar-stability, immunity): pvStability correctly UNMOVED ✓ (18/27 — measured independently, not read off the result)
```

Each fault must produce strict failures **while still having checked every
case** — a run that quietly checked nothing would itself be a vacuous pass —
and coverage is asserted **per axis, never pooled** (summing `rootComplete` and
`playedRank` would let an entire subset escape while still hitting the
threshold). The faults are engine regressions, not corpus-label edits: the
strict axes grade self-consistency, so a swapped-but-legal key move would
rightly stay green.

The last two lines are different assertion classes. `incomplete-aux` corrupts
only the auxiliary ¼×/4× tiers (`complete: false` with a partial line list),
which never touches the graded results — so it cannot turn the strict gate red,
and the requirement is full **ratchet visibility** instead: every tier scored
as a miss with coverage intact, and every quick-scan regret counted
catastrophic with the sample not shrunk, so `--baseline` fails on the fallen
counts. A silently trusted (or silently skipped) tier would leave the numbers
clean. `liar-stability` makes the engine claim `bestMoveStable: true`
everywhere — a corruption that moves a quality number **upward**, which a
ratchet (failing only on falling numbers) would record as progress. The
requirement there is that `pvStability` does **not move at all**: the axis
measures the shallower best move itself rather than echoing the engine's claim
about it.

The quality ratchet is separately verified: replaying the shard against a
baseline holding one extra solve and a lower p90 correctly reports

```
  puzzleTop1       10/12 → 9/12  (-1)  ← REGRESSION
  regret cp        n 34→34 med 0→0 p90 1→5 catastrophic 0→0  ← REGRESSION
```

and exits non-zero — so a lost solve **or** a fattened regret tail fails the PR.
A statistic the baseline defines that the current run no longer reports (or
reports as null/NaN) regresses the same way — the full-mode `p99` cannot
silently disappear from the published vector.

## Decision

**Adopt the analysis scorecard as a PR gate — strict at 100% on the two output
contracts, ratcheted from this baseline on the five quality axes — and publish
this vector as the frozen eval-v1 analysis baseline.**

- The 34-case train/val shard runs on every PR (wired into `.github/workflows/test.yml`)
  with `--baseline eval/ANALYSIS-BASELINE.json`.
- The full 103-case corpus is available via `--full` for nightly / pre-release runs.
- **Deferred, on purpose:** level calibration and the adjacent-level ladder
  (E4, waiting on #72 per the tracker), the tuning protocol (E5), and the
  cache/cancel/progress runtime tests — which live in the analysis *service
  worker* rather than the pure core graded here.
