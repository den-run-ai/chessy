# Sparse PeSTO: 17,280 coefficients on one million positions

## Result

The expanded sparse interaction model improves static teacher agreement on
both the untouched main holdout and newly labelled natural-game positions.
An exact pair-sweep optimization makes the selected model 1.41–1.48 times
faster in search than the initial implementation, leaving about a 20% search
throughput cost versus the shipped HCE. Lower fitting loss is not evidence of
stronger equal-time play. This is a research prototype, with reproducible
code, fitted weights and measured negative results. No Elo or
production-admission claim is made.

- **Capacity:** 17,280 candidate coefficients, 17.9 times the earlier 965-term
  design. The selected model retains **2,621 nonzero integer coefficients**.
- **Main data:** one million admitted positions, grouped into 549,270
  structural families. The held-out model comparison uses **100,691 positions**.
- **Main holdout:** mean absolute CP error **134.407 → 124.796** (7.15% lower);
  RMS error **221.194 → 201.040** (9.11% lower); teacher-score CE
  **0.679713 → 0.674451** (0.774% lower). All three phases improve.
- **Fresh teacher transfer:** on 2,425 accepted positions from distinct
  natural games, MAE **153.575 → 146.835** (4.39% lower), RMS error
  **203.198 → 192.688** (5.17% lower), CE **0.590496 → 0.588112** (0.404% lower).
  Overall sign accuracy is essentially flat: 89.94% → 89.90%.
- **Storage:** the selected residual is **10,492 bytes** in sparse SPV1
  storage, versus 34,560 bytes dense. It expands into tables at load time;
  the fast native model retains **64,544 bytes** of coefficient/table payload
  before metadata. Compressed storage alone does not accelerate evaluation.
- **Search cost:** the optimized full model achieves **0.801× / 0.793×**
  HCE nodes per second at 10k / 36k nodes. All 192 reference/optimized search
  signature comparisons and 100,164 validation score comparisons are exact.
- **WSP/LP:** actual edits of both a pretrained NNUE output head and the
  expanded table improved their respective repair objectives. Both rounded
  edits violated their five-CP preservation bound and were rejected.

The [frozen plan](PLAN.md), [complete fit results](fit/results.json),
[storage evidence](MODEL-STORAGE.json), [initial runtime observations](RUNTIME-RESULTS.json),
[optimized runtime observations](RUNTIME-FAST-RESULTS.json), and
[OOD results](OOD-EVAL-RESULTS.json) carry the precise figures and identities.
The numerical choice was frozen before opening the main holdout and before
computing OOD performance. “Opened once” describes this completed run; the
generic command does not implement a global cross-directory access lock.

## What this model computes

The score is the exact shipped HCE plus a sparse, board-dependent correction:

\[
E(B)=E_{\mathrm{HCE}}(B)+\operatorname{round}_{\mathrm{sym}}
\left[\frac{p(B)w_{\mathrm{MG}}^T\phi(B)+(24-p(B))w_{\mathrm{EG}}^T\phi(B)}{24}\right].
\]

The feature map is nonlinear in the board but fixed independently of the
weights. Phase is determined by board material. Fitting the real-valued
coefficients is convex; learning embeddings, both factors of a low-rank
decomposition, or all NNUE layers would not share that guarantee.

| Feature family | MG + EG capacity | Meaning |
| --- | ---: | --- |
| Shared PST residual | 768 | Piece type and oriented square |
| Own king × piece-square | 6,144 | Eight own-king locations modulate piece-square value |
| Enemy king × piece-square | 6,144 | Eight opposing-king locations modulate piece-square value |
| Pawn context × piece-square | 3,072 | Own-pawn support and opposing-pawn attack bits |
| First occupied ray relation | 1,152 | Source/target types, relationship color and direction |
| **Total** | **17,280** | Sparse active lookups, not 17,280 operations per position |

The ray family records the nearest occupied square on each ray. It is a
geometric interaction, not a claim that every source piece legally attacks
that target. Color/rank orientation, integer tapering, special positions and
feature IDs are covered by independent Python/native comparisons. A zero
residual exactly preserves the HCE, including its existing conversion terms.

This borrows NNUE's king-conditioned sparse representation and shared factors.
The shared PST factor is coalesced with own-king residuals at load time. It
does not run a neural hidden layer. The
[official NNUE documentation](https://github.com/official-stockfish/nnue-pytorch/blob/master/docs/nnue.md)
describes the underlying sparse-input, king interaction and factorization
ideas. Rare or unsupported cells retain zero corrections and fall back on the
shared factors and fixed HCE.

## Why this differs from earlier attempts

The repository's [round-three tracker](https://github.com/den-run-ai/chessy/issues/137)
records small self-play data, objective misalignment and missing interactions
in the earlier 19- and 753-parameter studies. The clean September pilot used
33,103 training rows and six additional pawn-attack terms. This experiment
uses 799,145 training rows and a substantially larger feature map.

However, small data does not explain every previous result.
[PR #187](https://github.com/den-run-ai/chessy/pull/187) already used 20.4 million
positions for wider NNUEs. Its best nets were stronger at equal nodes but did
not establish an equal-time improvement. That source also used shallower mixed
teacher labels, included mapped mate scores and split by FEN hash. This
experiment is smaller than that NNUE corpus, uses stricter label admission,
excludes mate scores and splits by exact symmetry/structural families. It
still lacks upstream game lineage for the evaluation dump and remains
exploratory rather than a pinned-teacher training certification.

The positive result here supports richer fixed interactions plus cleaner,
larger-scale fitting. It does not prove that capacity, data quality or one
particular optimizer independently caused the improvement: those factors were
not fully separated in a factorial experiment.

## Data quality and actual game counts

The declared 512 MiB CC0 evaluation-dump prefix contains **7,231,317 complete
source records**. The frozen stream-order rule admitted the first one million
eligible, distinct symmetry clusters, capped at eight positions per structural
family; remaining complete lines were inventoried after that cap. This is a
prefix sample, not a random sample of the complete database.

Each admitted label comes from the deepest available evaluation, at depth at
least 20 and at least 100 thousand searched nodes, with finite non-mate
|CP|<=2000. The board and complete PV must be legal, the position must not be
in check or insufficient material, and the teacher's first move must be a
nonchecking, noncapture, nonpromotion move. Existing evaluation/incident/match
clusters and families are quarantined.

| Role | Positions | Opening | Middlegame | Endgame |
| --- | ---: | ---: | ---: | ---: |
| Train | 799,145 | 461,709 | 172,253 | 165,183 |
| Validation | 100,164 | 57,668 | 21,911 | 20,585 |
| Holdout | 100,691 | 58,044 | 22,019 | 20,628 |

Independent auditing matched **all one million labels to source records**,
verified role hashes and counts, found zero cross-role family overlap, and
compared 973 sampled feature-grouping keys with the independent JavaScript
implementation. See [data audit](DATA-AUDIT.json) and [source manifest](DATA-MANIFEST.json).

The separate, complete January 2014 archive contains **697,600 actual games**.
Legal replay and label-blind selection yielded **407,732 positions from
distinct games**. These are an additional prepared natural-game corpus, not
407,732 new teacher-labelled training rows. A frozen 4,096-game subset with no
observed primary family/cluster overlap was labelled once by the pinned
official Stockfish 18 binary at 100,000 nodes, using complete game histories.

Strict admission accepted 2,425 labels and excluded 1,671, primarily because
the final score was a bound rather than an exact search score. No rejected
root was retried. This 40.8% exclusion rate restricts the transfer population.
Independent audits checked every source/label/raw-UCI join and legal PV.
The evaluation dump lacks game IDs, so even this separate archive and verified
family separation cannot prove that no upstream game supplied both sources.
See [OOD collection and limitations](OOD.md).

## Fitting and validation selection

Five recipes were fixed before fitting. Each minimizes teacher-score logistic
cross entropy at a fixed 400-CP scale plus positive L2 and optional L1 penalties.
This is **not** squared error after a sigmoid. Train families receive equal
total weight; columns seen in fewer than 32 training rows stay at zero.
Coefficients have fixed bounds; ray/pawn-context L1 costs discourage expensive
families. Numerical convergence includes projected-gradient diagnostics.

All five fits converged; total solver time was **376.45 seconds**. The selected
model is the minimum-validation-CE integer candidate that passes the frozen
overall, phase and CP-error guards. The baseline remained selectable.

| Recipe | Nonzero integer coefficients | Validation CE | Eligible under frozen quality rules |
| --- | ---: | ---: | --- |
| Shipped HCE | — | 0.679371 | Baseline selectable |
| PST correction | 724 | 0.676569 | No: minimum gain not met |
| King interactions | 2,118 | 0.675298 | Yes |
| Full interactions | **2,621** | **0.674071** | **Selected** |
| Full, stronger L2 | 3,046 | 0.674772 | Yes |
| Full, stronger L1 | 383 | 0.676377 | No: minimum gain not met |

Stronger sparsity is not automatically better. The 383-coefficient fit loses
too much predictive quality, and retaining any ray coefficient still activates
the reference implementation's complete ray traversal. Support selection and
integer rounding are outside the continuous convex-optimum claim.

## Untouched holdout and independent teacher transfer

Only the selected full model was evaluated on the primary holdout and the
newly labelled OOD sample. No weights were adjusted afterwards.

| Set / phase | Rows | HCE MAE | Sparse MAE | HCE RMSE | Sparse RMSE |
| --- | ---: | ---: | ---: | ---: | ---: |
| Main holdout, all | 100,691 | 134.407 | 124.796 | 221.194 | 201.040 |
| Opening | 58,044 | 98.042 | 88.692 | 164.996 | 141.368 |
| Middlegame | 22,019 | 142.533 | 136.517 | 218.680 | 203.459 |
| Endgame | 20,628 | 228.058 | 213.875 | 333.432 | 311.231 |
| Fresh SF18, all | 2,425 | 153.575 | 146.835 | 203.198 | 192.688 |
| Fresh opening | 713 | 130.512 | 127.781 | 178.442 | 167.436 |
| Fresh middlegame | 855 | 155.945 | 154.179 | 205.243 | 200.071 |
| Fresh endgame | 857 | 170.399 | 155.359 | 219.811 | 204.455 |

All CP figures are in the source teacher's units. The fixed sigmoid is an
evaluation transform, not a certified human/game-winning probability model.
Fresh-source sign accuracy is flat overall and slightly lower in opening and
middlegame despite improved MAE/RMSE/CE. These results support error reduction,
not a universal improvement in every chess decision. The fresh-source CE gain
of 0.404% is below the primary study's 0.5% selection threshold; this OOD run
is a diagnostic of the already frozen model, not a further selection gate.

## Reference implementation cost

The standalone Rust bridge includes the exact unmodified **r84** engine, HCE
and search sources used when this experiment began. They are now pinned in
[`tools/sparse_eval/baseline/`](../../tools/sparse_eval/baseline/) so the later
r85 main-branch advance cannot silently change the experiment. The reference
wrapper computes the HCE and then the residual;
its extra board scan is an implementation cost, not an unavoidable property
of a king-conditioned table. Five models match Python integer predictions on
all 100,164 validation rows: **500,820 exact candidate parity checks**.

The declared timing run used 24 label-blind roots, eight per phase, two
balanced-order repetitions at two node budgets, and 6,000-pass static blocks.
All **960 search observations** reached their requested budgets.

| Recipe | Candidate/HCE NPS at 10k nodes | At 36k nodes |
| --- | ---: | ---: |
| PST correction | 0.920 | 0.894 |
| King interactions | 0.871 | 0.843 |
| Full interactions | 0.559 | 0.576 |
| Full, stronger L2 | 0.571 | 0.569 |
| Full, stronger L1 | 0.593 | 0.583 |

The full reference's static-evaluation time is roughly four times HCE on this
small balanced sample. Its ray geometry dominates cost. Scalar coefficient
sparsity saves payload bytes but does not eliminate extraction for a partly
active family. The learned full model is therefore not ready for activation
on this evidence. Whole-search ratios also include different search trees;
they are not pure evaluator-throughput measurements.

### Exact pair-sweep optimization

The optimized evaluator replaces eight independent ray walks per occupied
square with one ascending board scan. It tracks the last occupied square on
each rank, file and diagonal, so each adjacent occupied pair is visited once.
Both directed contributions are combined in load-time tables. This changes
the cost of computing the same integer function, without changing a weight,
feature definition or evaluation result. Compile with `--cfg sparse_fast`.

A fresh, separately frozen cost protocol compares the reference and optimized
binaries on the same 24 roots, budgets and balanced ordering. All 384 search
observations completed. All **192 old/new score, move, node, qnode and depth
signatures** match. Both binaries also match on all **100,164 validation
positions**. The original timing results remain unchanged.

| Cost measure | Optimized / reference speed | Optimized / HCE speed |
| --- | ---: | ---: |
| Whole search, 10k nodes | 1.480× | 0.801× |
| Whole search, 36k nodes | 1.412× | 0.793× |
| Static evaluator, balanced sample | 1.467× | 0.460× |

The optimized model still costs about **20% native search throughput** against
HCE. The king-only candidate is cheaper and remains an interesting separate
quality/cost point, but it was not substituted after looking at the selected
model's holdout. A joint cost-and-quality selection protocol would be a new
study. See [implementation details and checks](FAST-RUNTIME.md) and the
[complete optimized timing record](RUNTIME-FAST-RESULTS.json).

These are native desktop diagnostics, not WASM, WebKit, physical-iPhone or
equal-time playing-strength evidence. No matched NNUE inference-speed
comparison was performed, so the measurements do not establish a speed
advantage over a particular NNUE implementation. They describe the pinned r84
search baseline, not the later r85 release. Packaging relocates exact baseline
source bytes and preserves old measurement receipts; it does not rerun or
relabel the original timings.

The packaged runtime matches the measured fast binary's score triples on all
100,164 validation FENs after the relocation. Its separate
[packaging receipt](PACKAGING-RECEIPT.json) records the new executable hash and
unchanged output hash. No timing result is assigned to this rebuild.

## Direct weight editing and the LP limitation

The WSP/LP implementation uses fixed features, bounded sparse edits, a weighted
absolute-error objective, exact L1 cost and explicit preservation constraints.
Both real LPs reached optimal status and passed independent primal/dual checks.

| Diagnostic | Integer changes | Error result | Decision |
| --- | ---: | --- | --- |
| Chatarunga NNUE final linear head | 28 / 16,384 output weights | Validation MAE 85.943 → 85.670 CP on 4,096 positions | Rejected: 8 CP preservation drift > 5 CP |
| Full sparse table | 62 coefficients | Training repair MAE 122.809 → 121.698 CP | Rejected: 8 CP preservation drift > 5 CP |

The NNUE's transformer and output biases remain frozen. The table correction
never opened validation or holdout. Original and edited NNUE outputs each
match the pinned upstream engine on 128 positions; table scores match native
Rust on 4,096 positions each. This is actual direct editing of pretrained
NNUE weights, not an HCE fit renamed as a neural edit.

The failure is precise: continuous preservation constraints do not survive
coefficient rounding and native integer truncation automatically. A future
integer-aware or rounding-robust edit needs a new declared experiment; neither
rejected patch was adjusted after validation. The original WSP references do
not make all-layer NNUE optimization convex. DWE was not uniquely identifiable
from the request, so this work treats direct weight editing as an explicit
interpretation, without inventing a paper attribution.

Details: [NNUE edit](CHNN-RESULTS.md), [table edit](TABLE-EDIT-RESULTS.md),
[method and references](WSP.md).

## Run the prototype

Install research-only dependencies; nothing is added to the offline app:

```sh
python -m pip install numpy==2.3.5 scipy==1.17.0 chess==1.11.2 zstandard==0.25.0
rustc --edition=2021 -O --cfg sparse_fast tools/sparse_eval/runtime.rs -o /tmp/chessy-sparse
printf '%s\n' 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1' \
  | /tmp/chessy-sparse eval eval/sparse-pesto-v1/fit/full.spv
```

Output columns are baseline, candidate and correction, all White POV. The
native binary supports `features`, `baseline`, `eval`, `bench` and
paired `search` diagnostics. `search` takes independent roots with cleared
history; it is not a repetition-aware game-match runner.

The [pipeline](../../tools/sparse_eval/pipeline.py) packs authenticated complete
roles, fits the frozen grid and publishes the validation choice before holdout
scoring. The [data importer](../../tools/sparse_eval/data.py),
[OOD teacher](../../tools/sparse_eval/label_ood.py),
[runtime runner](../../tools/sparse_eval/measure.py),
[sparse codec](../../tools/sparse_eval/export.py) and LP adapters are separate
research tools. Historical input snapshots and measured source receipts are
retained; post-run reader hardening is identified without relabelling old
measurements. Reproducing an exposed diagnostic is not new independent evidence.

All computation was local CPU, with **$0 paid compute**. Equal-time matches,
WASM/browser integration, mobile cost and production admission remain open.

See [reproduction and data archive instructions](REPRODUCTION.md) and
[retained historical source identities](source-snapshots/SNAPSHOTS.json).
