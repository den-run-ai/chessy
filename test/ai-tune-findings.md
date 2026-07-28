# Evaluation-weight tuning — experiment log

Canonical record of Chessy's evaluation-tuning experiments. Two rounds so
far: the 2026-07-22 auxiliary-weight round (PR #63, closed unmerged) and the
2026-07-28 full-vector convex round (this branch). The tooling lives in
`test/ai-tune-gen.js` (self-play datasets), `test/ai-tune.js` (the fit),
`test/ai-tune-apply.js` (explicit apply for gate-testing); correctness is
CI-gated by `test/ai-tune.test.js`.

## Round 1 (PR #63) — auxiliary weights only: NO ADMISSIBLE CANDIDATE

Summary of the closed, unmerged PR #63 experiment (its full log lives in
that PR's history; the essentials matter here because round 2's design is a
point-by-point response):

- **Tuned surface**: only the 19 auxiliary constants (mobility, doubled /
  isolated, shield, passed arrays; 17 identifiable). The piece-square tables
  and material values — the mass of the evaluation — were frozen.
- **Data**: 600 self-play games, random 6-ply openings, 700 nodes/move,
  13,058 positions, labelled ONLY by final game outcome.
- **Objective**: squared error of sigmoid(K·q/400) vs outcome (not convex
  through the sigmoid), RMSProp + integer polish, L2 toward shipped values,
  lambda selected on validation with the baseline in the candidate set.
- **Result**: regularised fits stayed at the shipped weights (± one noise
  centipawn); the unregularised lambda = 0 fit lowered held-out loss ~1% with
  chess-nonsensical weights (zero knight mobility, cap-pinned shield,
  non-monotonic passed arrays) and FAILED the tactics gate — it could not
  convert K+Q vs K or K+R vs K. Objective misalignment, terminal.
- **Verdict recorded**: "a lower outcome-labelled Texel loss is not the same
  as playing strength"; the gate order (tactics first, then bench, then the
  predeclared clustered match) is the arbiter, and no candidate reached it.

Two later data points frame what a successful evaluation change looks like:
PR #79 (the shipped PeSTO tapered tables — themselves the product of a
large-scale external Texel-style tuning) PASSED the formal 800-game gate at
a 52.05% clustered lower bound, while PR #101 (a hand-crafted blocked-pawn
term that provably fixed its target positions) FAILED it at 47.60%.

## Round 2 (this branch) — full weight vector, convex objective, blended labels

### What changed vs round 1, and why

| Round 1 failure finding | Round 2 response |
| --- | --- |
| 19-weight surface too small to matter | The whole evaluation is tuned: all twelve piece-square tables (736 identifiable entries) + the 17 auxiliary weights = **753 parameters**. Material values stay fixed — a uniform table shift is exactly collinear with material, so tables absorb material retuning. |
| Outcome-only labels: one noisy bit per game | Each quiet position carries the game outcome AND the White-POV root search score computed during play (free). The training target blends them (default 50/50) through the fitted K calibration. Won-ending positions — where round 1's fit learned nothing and unlearned mate conversion — now carry their own decisive labels. |
| Random-opening self-play at 700 nodes/move | Openings drawn from the committed CC0 lichess sample (`eval/corpus/sources/openings-v1.tsv`) with seeded truncation + 2 seeded spread plies, played at 2,500 nodes/move. The training book is verifiably disjoint from the frozen 100-opening match manifest (CI-pinned), so training never touches the formal gate's openings. |
| Non-quiet positions polluted the fit | Classic Texel quiet filters: in-check positions, positions whose search PV starts with a capture/promotion, and positions the search already calls decided (|cp| > 2000, which also excludes the mate band) are excluded at generation. Exact duplicate positions are deduplicated at load. |
| MSE-through-sigmoid objective (non-convex) admitted a pathological optimum | The objective is now the log-loss (cross-entropy): for weights that enter the evaluation linearly this is **regularised logistic regression — convex, with a unique optimum for lambda > 0**. Deterministic full-batch descent + integer polish; no stochastic search anywhere. |
| The pathological candidate came from lambda = 0 | The lambda grid excludes 0 by construction (the baseline is always in the candidate set, so "no change" never needs lambda 0 to win). |

Everything else is carried over from round 1 unchanged: exact linear-feature
reconstruction with fidelity self-checks against `evaluate()` (baseline and
fully-perturbed distinct-weights oracle, now covering the tables and an
orientation witness), grouped train/val/test split by game, rounded scoring
for integer candidates, selection on validation only, final numbers on the
untouched test split, and the tuner never writing `assets/ai.js`.

### Pre-registered protocol

- Dataset: `node test/ai-tune-gen.js --games 1600 --nodes 2500 --out ...`
  (schema 5, seed 1; all defaults — stride 2, skip 4, book-min 4,
  rand-extra 2, cp-exclude 2000, max-plies 220).
- Fit: `node test/ai-tune.js --data ... --passes 6 --emit ...` (defaults:
  mix-out 0.5, lambda grid {0.02, 0.05, 0.1, 0.2, 0.5, 1.0}, lr 0.3,
  iters 1500, val/test 15%/15%, split seed 1). `--passes 6` was fixed before
  the experiment run: the 90-game smoke pre-flight showed the 753-dimension
  integer polish still improving after the default 3 passes.
- Selection: lambda by validation CE with the baseline seeded in; final
  report on the untouched test split.
- Admissibility gates, in order (a failure is terminal at its stage):
  1. tactics suite (`node test/ai-tactics.js`) at 100%;
  2. depth-5 node benchmark (`node test/ai-bench.js`) with no pathological
     regression;
  3. the predeclared formal 800-game clustered strict-strength match
     (#104 protocol; opening-clustered one-sided 95% lower bound strictly
     above 50%) — dispatched via the `ai-match.yml` workflow, NOT run
     locally.
- A bounded local diagnostic match may be reported for direction only; it is
  explicitly not merge evidence (README's match-protocol rules), and it is
  run AT MOST ONCE per selected candidate: match results are never used to
  iterate or re-select weights (the #104/#105 manifest rule — selection ends
  at validation CE, before any game is played).

### Results — 2026-07-28 run: NO ADMISSIBLE CANDIDATE

**Decision: no evaluation-weight change ships.** The validation-selected
candidate FAILED the first admissibility condition — it does not lower the
untouched test loss — so the gate sequence never started (no tactics run, no
bench, no match, no manifest spend). The shipped weights stand, now with a
much stronger negative result behind them than #63's.

- **Data**: 1,595 games (82.8% decisive), 54,356 sampled quiet positions,
  51,354 after dedup (3,002 book-shared duplicates dropped), 51.0% White to
  move. Grouped split: train 1,115 games / 35,726 positions, val 239 / 7,601,
  test 239 / 8,027. Exact regeneration:
  `node test/ai-tune-gen.js --games 1600 --nodes 2500 --seed 1 --out ...`
  (dataset sha256 `4bf2ecace4193fe2…`).
- **Calibration**: K = 0.6800 fitted on baseline weights against train
  outcomes (cf. ~0.41–0.48 on #63's 700-node data — the 2,500-node scores
  are substantially more outcome-predictive, as intended).
- **Fidelity**: reconstruction equals `evaluate()` on all 403 baseline and
  399 fully-perturbed-table positions before fitting.

Lambda sweep (fit on train, selected on validation, baseline in the
candidate set; blended targets, rounded scoring):

| lambda | train Δ% | val Δ% | moved (aux/table) |
|---|---|---|---|
| 0.02 | +0.860 | **+0.615** | 16 / 557 |
| 0.05 | +0.623 | +0.517 | 17 / 427 |
| 0.1 | +0.465 | +0.424 | 16 / 305 |
| 0.2 | +0.326 | +0.317 | 13 / 167 |
| 0.5 | +0.172 | +0.132 | 11 / 60 |
| 1.0 | +0.080 | +0.067 | 9 / 31 |

Validation preferred the least-regularised grid point (lambda = 0.02,
573/753 weights moved, max table delta 31 cp) — and the **untouched test
split refused it**: baseline CE 0.511040 vs candidate CE 0.511343
(−0.059%, i.e. *worse*; reference MSE 0.030527 vs 0.030894, also worse).
The candidate also tripped the sanity flags that #63 taught us to read as
objective misalignment: queen mobility driven to 0 and a non-monotonic
endgame passed-pawn ladder — the same pathology class as #63's
zero-knight-mobility fit, surfacing at the least-regularised corner even
with 4× the data, per-position blended labels, and a convex objective.

**Reading.** The validation gains grow monotonically as lambda shrinks while
the test set says "worse than baseline": at this data scale the val split
(239 games) rewards fitting self-play-distribution quirks that do not
transfer even to a *same-distribution* holdout — let alone to play. The
convex machinery did its job (unique optimum, exact gradients, deterministic
runs); what is missing is not optimization power but *signal*: within the
linear-in-features evaluation family, the shipped PeSTO-based weights are
already at or beyond what ~50k mid-budget self-play positions can improve
on. This materially strengthens #63's conclusion — round 1 could not move 19
auxiliary weights; round 2 could not move any of the 753 parameters, under a
strictly better objective, labels, and data.

**Implication for #105 (NNUE).** This is direct evidence for the capacity
hypothesis: the remaining evaluation headroom is not reachable by re-weighting
the existing linear features, however well optimised — it requires either new
hand-crafted feature terms (the #101 route, which failed its strength gate)
or a model family with feature interactions (the tiny-NNUE experiment #105
tracks, whose non-convex hidden layer is exactly what buys the capacity).
The convex-tuning question is now answered with data, not argument.

**Exploratory control (label ablation, not a selection run).** A second fit
with `--mix-out 1.0` (pure game-outcome targets, the #63 labelling) on the
same dataset/split isolates what the blended labels contributed. It emitted
no candidate and selected nothing; numbers for the record (absolute losses
are not comparable to the blended run — pure-outcome targets are noisier;
baseline test CE 0.532160 here vs 0.511040 blended):

| lambda | train Δ% | val Δ% | moved (aux/table) | untouched test |
|---|---|---|---|---|
| 0.02 | +3.027 | +1.960 | 17 / 642 | **−0.372% (worse)** |
| 0.05 | +2.148 | +1.635 | 17 / 535 | — |
| 0.1 | +1.583 | +1.297 | 17 / 432 | — |
| 0.2 | +1.087 | +0.944 | 14 / 284 | — |
| 0.5 | +0.628 | +0.609 | 13 / 132 | — |
| 1.0 | +0.351 | +0.243 | 11 / 62 | — |

Pure-outcome labels made everything worse in exactly the predicted
direction: apparent validation gains 3× larger, weight movement wilder
(659/753 moved, max table delta 61 cp vs 31), and the test refusal 6×
deeper (−0.372% vs −0.059%). The blended labels did the anti-overfitting
work they were designed for — and even so, no transferable gain exists.

### Interpretation limits

- Conclusions are specific to this data distribution (2,500-node self-play
  from corpus openings). A much larger dataset, deeper labels (e.g.
  10k-node re-labelling), or result-blended targets from *stronger external
  games* could still move weights — that would be a new preregistered round.
- The test split shares the self-play distribution; a test-loss improvement
  would still only have been a hypothesis pending the strength gates. Its
  absence, though, is terminal by design.

### Shipping constraints (why a passing candidate still does not auto-ship)

- The Rust/WASM engine duplicates every evaluation constant
  (`experiments/wasm/src/eval.rs`, shipped as the hash-gated
  `assets/chessy-ai-fast.wasm` with exact JS-parity tests). A shipped weight
  change must retune the Rust evaluator in lockstep and rebuild with the
  pinned toolchain (Rust 1.97.1 / Binaryen 131 per #126/#127), refreshing
  the canonical digest in `test/wasm-asset.test.js`.
- The PST provenance prose (assets/ai.js PeSTO attribution block and
  `THIRD_PARTY_NOTICES.md`) describes the shipped coefficients; tuned tables
  change what that prose must say (they remain PeSTO-derived — the L2 pull
  is toward PeSTO — but are no longer PeSTO verbatim).
- Any `assets/` change requires the release-unit bump (sw.js release token +
  versioned asset refs).
- Deterministic coaching/analysis identity: evaluation changes alter
  analysis outputs, so the analysis-core engine version / config hash and
  cached-result identity need bumping per that contract (#105 notes the same
  for any evaluator change).
