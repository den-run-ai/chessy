# Compact evaluator experiment audit — 2026-09-14

## Decision

The original 4.71% exploratory teacher-loss reduction reproduces exactly.
It is not evidence of an Elo or move-time improvement. Keep the shipped
evaluator, WASM bytes and all five difficulty budgets unchanged. No network
or fitted vector is admitted. This follow-up uses local CPU only; Modal spend
is $0. Credentials were not needed.

## Independent checks of the preserved pilot

- Reproduced all 30 fits with the pinned NumPy 2.3.5 / SciPy 1.17.0 versions:
  all five selected lambdas, integer-weight hashes and cross-entropy values
  match exactly.
- All 10,911 accepted boards and complete teacher PVs are legal under an
  independent chess implementation. Saved feature vectors, cluster keys and
  structural-family keys all recompute exactly.
- All 102 source seeds occur across split boundaries. There are 732 roots in
  check. The data are legal but include tactical random continuations, with
  shared source dependence. Their split/bootstrap cannot establish clean
  natural-game generalization.
- The 215 `seldepth < depth` records are **ineligible under the frozen rule**,
  not necessarily invalid Stockfish scores. Stockfish's selective depth and
  nominal iteration depth need not be ordered. The frozen admission rule has
  not been changed; excluding those rows is a post-hoc sensitivity analysis.
- A real research reconstruction defect affected 153 rows by one centipawn:
  divided floating-point coefficients accumulated around half-integer ties.
  Exact integer numerators followed by Rust's final taper rounding fix this;
  all 10,911 baseline scores now match WASM. Runtime assets are untouched.

The historical `rounded` loss rounded the **weights**, but left the tapered
score smooth. It was not exact runtime loss. New `runtimeRounded` metrics
distinguish these two operations. The original JSON evidence is unchanged.

The filtered sensitivity retains 7,517 train / 1,593 validation / 1,586 test
rows. These are refits of the same predefined surfaces on the same exposed
corpus, not a new candidate-selection or strength experiment:

| Surface | Validation CE | Test CE |
| --- | ---: | ---: |
| Frozen coefficients | 0.452572 | 0.437485 |
| Existing 753-weight retune | 0.437415 | 0.423358 |
| Retune + pawn attacks | 0.430836 | 0.417455 |
| Retune + king-bucket pawn PSTs | 0.436662 | 0.422548 |
| Both cheap groups | 0.430248 | 0.416486 |
| Full R3 | 0.429270 | 0.415009 |

Every surface still chooses lambda 0.02. Full R3 still rounds all four raw
mobility coefficients to zero and saturates four pawn-attack coefficients at
96 cp. This behavior calls for a clean data/feature ablation; it does not prove
an optimizer defect or a playing-strength loss. No Elo, speed, or recalibration
claim follows from either set of teacher losses.

Research code, reproduction and forensic results remain on the
[separate research branch](https://github.com/den-run-ai/chessy/tree/codex/pesto-synthetic-pilot-2026-09/eval/training).

## Measurement corrections

The new [holdout audit](match-v2/holdout-audit.json) reproduces 400 distinct
endpoint/mirror groups, 340 static pawn/king/material families, and 60 named
opening families. Sixty-one selected endpoints share a static family with
historical exposed openings; zero share an exact endpoint/mirror key. Neither
340 nor 60 is a proven effective sample size. Source-game identities do not
exist for this opening catalog. The manifest stays unchanged and unmeasured;
family policy remains a prerequisite for formal adoption.

The Brotli gate now pins Node 22.23.2 / Brotli 1.1.0, the encoder used by the
successful original CI run. It still permits at most 37,172 raw / 17,690
Brotli-11 bytes. Other runtimes can report explicitly diagnostic sizes without
impersonating the authoritative gate.

Issue #156's follow-up execution work is a separate diagnostic-only change:
400 openings × two colors, no inert seeds, full repetition histories, exact
commits/module/source/build identities, legal move replay, every failure
retained, and all 20 shards required. Easy's 10k-node evaluator threshold and
Hard's 230k-node selective-search threshold must remain distinct. A passing
diagnostic cannot authorize production, regardless of its numerical bound.

## What still blocks a releasable evaluator

[PR #171](https://github.com/den-run-ai/chessy/pull/171) fixed canonical NNUE
E4 selection/certification admission and merged into PR #146's foundation at
`a2a8eb8625cd4b56f8cefdba9f6768ef7dc9eaf2`, **not into main**. The tools now
explicitly require a trusted isolated runner; retained executables and input
snapshots are not claimed sealed against a hostile process with the same user
ID.

PR #146 remains draft and blocked: its HCE/NNUE consumers must authenticate
the actual raw UCI transcript and exclusion ledger, then prove the exact,
disjoint partition of selected records into labels or exclusions with matching
shared fields. Complete shard inventories and canonical manifest admission
alone do not establish that transformation. The full foundation still needs
conflict resolution, final-head validation and review before a main merge.

Signature rotation (#155), formal v2 family/estimator admission (#156), and
device/runtime evidence (#84) also remain open. The historical signature
fixture and prior rejected strength trials must not be overwritten or reused
as evidence for a new candidate. Level labels remain provisional (#113).

## Natural-game follow-up

The separately preregistered natural-game pilot has authenticated the complete
official CC0
[January 2013 archive](https://database.lichess.org/standard/lichess_db_standard_rated_2013-01.pgn.zst)
(121,332 games; 17,761,302 compressed bytes), SHA-256
`aa40b3671fa3cf1072eb182892cd90b0e1e003a4a5943492f64b77e7f3fd1635`.
Selection is complete: 50,000 positions from distinct source games, with
49,381 structural families assigned to disjoint roles. Known incident,
scorecard and opening boundaries are quarantined under the frozen rules;
unknown incident upstream lineage and broader player/opening dependence remain
limitations. The June 2026 production source is unchanged.

The disclosed full replacement produced 47,203 admitted labels and 2,797
frozen-rule exclusions; independent raw source/UCI/partition auditing found
zero mismatches. The selected constrained existing weights plus six pawn-attack
terms reduced validation CE by 1.375% and once-opened HCE test CE by 1.493%,
with improved CP errors and all phases improving. The family-bootstrap interval
for test CE difference is wholly negative. This is clean predictive evidence,
not an Elo/time claim; broader player/opening dependence remains unmeasured.
The exact selected vector passed private compiled parity, size and throughput
gates. Its complete independently replayed development screen scored 42.5% at
50 ms and 58.75% at 200 ms, with both 95% intervals including 50%. The candidate
stops here without an established Elo/time gain or a larger dispatch.

See the [natural-pilot evidence and decision](NATURAL-PILOT-2026-09.md) for
completion status, final metrics and preserved failure evidence. This research
does not satisfy #146's generic consumer admission gap or #137's million-row
study. The evaluator, difficulty levels and WASM remain unchanged; Modal spend
is $0 and no paid job or formal match has been dispatched.
