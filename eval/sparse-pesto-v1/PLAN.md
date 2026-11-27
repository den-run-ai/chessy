# Sparse PeSTO interaction experiment v1

This is a new, owner-requested research experiment dated 2026-11-26 (Pacific).
It does not reopen a completed historical experiment or its locked test sets.
No production evaluator, release, difficulty, calibration or admission changes
are authorized by these measurements. CPU only; paid compute budget is $0.

## Question and frozen representation

Can a much larger, sparse, linear-in-parameters interaction table improve on
PeSTO-sized retuning without the inference cost of a wide NNUE?

Keep the exact shipped HCE, including endgame conversion terms, as a fixed
offset. Fit White-POV corrections. Each board determines its own MG/EG phase;
phase never depends on fitted weights. The fixed 17,280 coefficients are:

| Family | MG + EG coefficients |
| --- | ---: |
| Shared piece-square residual | 768 |
| Own king bucket × piece-square | 6,144 |
| Opposing king bucket × piece-square | 6,144 |
| Pawn support/threat state × piece-square | 3,072 |
| First occupied ray: source/target type, color, direction | 1,152 |

Eight king buckets use four two-file bands and two four-rank bands. Each
piece uses its own color's rank orientation. Ray features describe geometry,
not legal attacks. Sparse positions activate a small subset of coefficients.
Shared PST factors may be coalesced into own-king tables at export. Integer
corrections round symmetrically; the unchanged HCE retains its own arithmetic.

## Data and separation

Declare a 512 MiB compressed prefix of the official CC0 Lichess evaluation
export, retaining every complete source record and reporting the incomplete
tail separately. Admit at most one million rows: deepest available session,
depth >=20, >=100 thousand nodes, finite non-mate |CP|<=2000, valid legal
position, no check, legal complete PV, quiet first PV move, no insufficient
material. Deduplicate exact/color/file mirrors; cap eight rows per structural
family. Assign families, not FEN strings, to salted 80/10/10 train/validation/
holdout roles. Quarantine the repository's existing evaluation, incident and
match banks, including all reachable prefixes, by cluster and family.

This is a bounded prefix, not a representative random sample of the entire
database. Mixed teacher versions and missing game lineage make it exploratory.
Report positions and actual games separately. In parallel, inventory the
complete CC0 January 2014 natural-game archive (new source relative to the old
January 2013 pilot) and select one position per eligible game without looking
at scores. A bounded newly labelled source-disjoint OOD sample is optional
diagnostic evidence, not a replacement for the sealed primary holdout.

## Convex fit and comparisons

The primary objective is fixed-scale teacher-score logistic cross entropy,
with target sigmoid(teacher_CP/400), prediction sigmoid((HCE+Xw)/400), positive
L2 regularization and optional cost-weighted L1 regularization. This is convex
in w. It is not squared error after a sigmoid and makes no calibrated WDL claim.
Train families have equal total weight. Columns present in fewer than 32 train
rows stay at zero. Coefficients are bounded to +/-128 CP (rays +/-64 CP).

The five predeclared fits are:

| ID | Feature families | L2 | L1 |
| --- | --- | ---: | ---: |
| pst | shared PST | 0.0001 | 0 |
| king | PST + own/opposing king | 0.0001 | 0.00001 |
| full | all | 0.0001 | 0.00001 |
| full-ridge | all | 0.001 | 0.00001 |
| full-sparse | all | 0.0001 | 0.0001 |

Regularization acts on coefficients in units of 400 CP. Ray L1 cost is 4;
pawn-context cost is 2; other costs are 1. Use bounded L-BFGS-B on nonnegative
positive/negative parts for exact L1. Maximum 400 iterations, with objective
and projected-gradient diagnostics. Do not describe an iteration-limit result
as a certified numerical optimum. Integer output is selected on validation;
the baseline remains a selectable candidate. Choose minimum validation CE
among converged fits with >=0.5% overall gain, no phase CE regression >1%, and
no overall MAE/RMSE regression >2%. Do not retune after the holdout is opened.
Report all five runs, support/coverage, phase errors, tails, and quantization.

A train-only LP correction may fit 2,048 repair rows and preserve 2,048 other
train rows with <=5 CP drift, using at most 128 train-selected coordinates and
bounded edits. This is a separately reported mechanism diagnostic, not an
additional validation-selected candidate. Support selection itself is not a
convex operation. The LP is convex conditional on that frozen support.

## Direct NNUE weight editing

Implement and test the WSP-inspired sparse LP for a frozen nonlinear trunk's
linear output head. Hidden-layer editing is not covered by the convex claim.
If an authenticated available checkpoint can be decoded and matched to its
original runtime, run a bounded, separately documented output-head diagnostic.
Preserve original checkpoint bytes, report license and provenance, and compare
actual quantized forward outputs. Integer truncation may break a float LP's
constraints; report observed violations and do not claim exact integer
preservation from the relaxed solve. DWE is an unresolved acronym in this
request; direct weight editing is an interpretation, not a paper attribution.

Primary references: [Stockfish NNUE documentation](https://github.com/official-stockfish/nnue-pytorch/blob/master/docs/nnue.md),
[Weight-Space Programming](https://rikiyat.github.io/blog/weight-space-programming/),
[Weight-Space Programming with Linear Programming](https://nathan.rs/posts/weight-space-lp/).

## Runtime and evidence

Use a standalone native bridge including unchanged Chessy engine/eval/search
sources. Zero residual must exactly reproduce baseline. Test Python/Rust feature
and integer-score parity, special moves, color symmetry and promoted material.
For each reported model, measure alternating paired static evaluation and
fixed-node search on a deterministic, label-blind validation subset. Record
nodes, completed depth, score and move; changed trees prevent interpreting NPS
as pure evaluator cost. These are development measurements, not physical-iPhone
or WASM performance. No Elo is inferred from loss or throughput.

Capture implementation/config/data hashes before long work; consume the same
retained bytes that are authenticated; publish related outputs under a single
no-replace reservation and write completion metadata last. Test/holdout remains
sealed until the single validation choice is frozen. Preserve complete negative
results. No formal match dispatch or production activation is part of this
prototype.
