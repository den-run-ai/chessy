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

PR #146's exact head `1e01c0b` still lacks canonical NNUE E4 admission and the
authenticated exact partition of selected records into labels/exclusions.
Its executable snapshot is retained but not sealed against a hostile process
with the same user ID; that threat must be implemented or explicitly scoped
to an isolated trusted runner. These are substantive remaining boundaries,
not a reason to repeat resolved inventory/publication reviews.

Signature rotation (#155), formal v2 family/estimator admission (#156), and
device/runtime evidence (#84) also remain open. The historical signature
fixture and prior rejected strength trials must not be overwritten or reused
as evidence for a new candidate. Level labels remain provisional (#113).

## Concrete next data experiment

Prepare a separately versioned natural-game pilot before another fit; do not
silently change the June-2026 production source in PR #146. A practical small
source is the complete official CC0
[January 2013 archive](https://database.lichess.org/standard/lichess_db_standard_rated_2013-01.pgn.zst)
(121,332 games, about 17.8 MB), with published SHA-256
`aa40b3671fa3cf1072eb182892cd90b0e1e003a4a5943492f64b77e7f3fd1635`.
See the [official checksums](https://database.lichess.org/standard/sha256sums.txt)
and [CC0 policy](https://database.lichess.org/). This source has been identified,
not downloaded, admitted or fitted in this follow-up. Old metadata sufficiency
and phase coverage must be checked before committing to an eligible row count.

Preregister a bounded 40–50k-position pilot, at most one quiet position per
source game, with source/structural-family isolation and frozen incident,
scorecard and match-family quarantine. Authenticate the whole compressed
archive; a hash of a downloaded prefix cannot authenticate the pinned full
June archive. Freeze the selection, roles, target, quietness, coverage, teacher
and exclusion rules before 100k-node Stockfish labelling. Preserve all raw
transcripts and exclusions with a completion manifest.

Compare strongly constrained existing weights against only six additional
pawn-attack terms first, retaining the baseline in the candidate set. Select
on validation, apply exact integer parity, then open the test once. Define
coefficient/coverage/CP-error stop rules before seeing results. An H4/H8 screen
needs a separate preregistration and untouched NNUE test role; this pilot
would not complete #137's million-position study.

Use CPU preparation/convex fits first. Check remaining monthly usage and
benchmark throughput before authorizing any charge-bearing shard. A proposed
allocation is at most $3 for data/teacher/HCE, $2 for an optional tiny-network
screen, and $15 for matches, leaving $10 unallocated within the user's $30
monthly ceiling. These are limits, not a claim of actual cost or scheduled
spending. No paid job or formal match has been dispatched.
