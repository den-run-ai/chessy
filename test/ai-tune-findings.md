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
- Fit: `node test/ai-tune.js --data ... --emit ...` (defaults: mix-out 0.5,
  lambda grid {0.02, 0.05, 0.1, 0.2, 0.5, 1.0}, lr 0.3, iters 1500,
  passes 3, val/test 15%/15%, split seed 1).
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
  explicitly not merge evidence (README's match-protocol rules).

### Results — 2026-07-28 run

RESULTS-PENDING (filled in by the experiment run; this section is committed
with the run's exact numbers).

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
