# Evaluator production pipeline

This directory builds production-compatible candidates and measures their
strength at equal wall-clock budgets. It does not choose a production default.
See the [completed report](../../eval/eval-production-v1/REPORT.md),
[retained evidence](../../eval/eval-production-v1/EVIDENCE.md),
[prospective study plan](../../eval/eval-production-v1/PLAN.md),
[historical timing evidence](../../eval/eval-production-v1/HISTORY.md), and
[build/export contract](BUILD.md).

## Sequence

1. `prepare.py` captures an explicit production Git commit, checks the selected
   integer model, embeds constant narrow tables, and builds the real ABI-v2
   modules with the pinned toolchain. The unchanged control must reproduce the
   shipped asset exactly. Candidate memory increases require an explicit flag.
2. Native parity, actual WASM ABI, and browser Worker contracts check scores,
   history, seeds, legal moves, exact roots, PVs, errors, and memory. The original
   HCE-specific starting-position tie fixture is not a universal property of a
   learned evaluator; candidate tests verify exact best roots independently.
3. `cost.py` freezes a complete matched-root cost grid and selects an efficient
   implementation for each unchanged evaluator. All requests, warmup, source,
   binary identities, timing, and exact same-model signatures are audited.
4. `games.py` freezes the complete game schedule, then runs both candidate
   colors on the same opening bank across several time controls. It retains
   complete histories and PGNs. Analysis is forbidden until the whole schedule
   finishes and independent Python/JavaScript rules replay passes.
5. `frontier.py` reports paired cluster uncertainty across the registered time
   grid. `plot.py` renders an audited result without fitting a crossover curve.
   A point-estimate crossing never enables a model.

The browser contract is documented in
[WORKER.md](../../eval/eval-production-v1/WORKER.md). The current Play Worker
keeps its first WASM instance (or failed loading promise). A future time-based
policy must use a Worker bound to the selected module/model or recreate it;
changing `wasmUrl` on a warm Worker does not change its evaluator.

## Run the cost screen

Use the paths from the successful build receipt and pinned Node 22.23.2.
Output directories are exclusive. Do not reuse or erase a failed attempt.

```sh
python3 tools/eval_pipeline/cost.py register \
  --build /absolute/build/BUILT.json \
  --roots eval/sparse-pesto-v2/COST-ROOTS.json \
  --host tools/eval_pipeline/host.mjs \
  --loader /absolute/build/runtime/wasm-engine.js \
  --rules /absolute/build/runtime/engine.js \
  --node /absolute/node-v22.23.2/bin/node \
  --output /absolute/new-cost
python3 /absolute/new-cost/source/cost.py run /absolute/new-cost
python3 /absolute/new-cost/source/cost.py audit /absolute/new-cost
```

Run measurements alone on the registered CPU, after compilation/fitting ends.
The frozen Node flags select optimized steady-state V8 execution. These data
do not establish cold browser startup, mobile performance, or game strength.

## Run a time-control frontier

The JSON configuration follows `frontier.validate_config`. It binds both module
hashes, an increasing time grid, every opening identity, coarse cluster mapping,
complete-history policy, maximum depth/ply cap, bootstrap settings, and runtime
settings. `nodeLimit` must be zero. Register the same completed openings for
both colors at every budget; the schedule interleaves budgets by opening.

```sh
python3 tools/eval_pipeline/games.py register \
  --config /absolute/game-config.json \
  --openings eval/sparse-pesto-v2/game-openings.jsonl \
  --base-wasm /absolute/build/modules/SELECTED-HCE.wasm \
  --candidate-wasm /absolute/build/modules/SELECTED-FULL.wasm \
  --host tools/eval_pipeline/host.mjs \
  --loader /absolute/build/runtime/wasm-engine.js \
  --rules /absolute/build/runtime/engine.js \
  --node /absolute/node-v22.23.2/bin/node \
  --source /absolute/build/BUILT.json \
  --source /absolute/new-cost/RESULTS.json \
  --output /absolute/new-games

# Use the exact digest printed by register, retained externally before play.
python3 /absolute/new-games/source/games.py run /absolute/new-games \
  --registration-sha256 REGISTERED-DIGEST
python3 /absolute/new-games/source/games.py audit /absolute/new-games \
  --registration-sha256 REGISTERED-DIGEST
python3 -m tools.eval_pipeline.plot --results /absolute/new-games/audit.json \
  --output /absolute/new-figures/equal-time-frontier --score-axis
```

The closed-ledger audit reconstructs every request, complete repetition
history, move, termination, and PGN. Capped draws are reported separately.
Its independent rules checks do not prove that the old training corpus had
complete source-game separation; the original corpus lacks those IDs.

## Refit cheaper executable architectures

`refit.py` registers two fixed recipes, rebuilds only authenticated training and
validation features, verifies their original packed hashes, and refits the
remaining coefficients using the original convex objective and family weights.
It keeps the original full reference and all integer validation predictions.
No holdout or OOD labels are read. Its protocol, source snapshot, convergence,
quality, integer-export, and table-range gates are retained with the results.

The optional `prepare.py --refit-manifest ... --recipe ...` import is separate
from default full-model preparation. It independently verifies the closure and
quality guards without executing imported source. Compile-time family removal
eliminates the learned table and feature work. HCE pawn/mobility work remains
when required by the baseline evaluation.

`refit_cost.py` separately compares the two accepted architectures with the
already selected full/HCE references on the registered 648-observation grid.
Its score/cost diagnostics do not add models to a completed game campaign.
New architectures require a new prospective equal-time game comparison.

## Promotion remains a separate decision

A production policy needs fresh confirmation at the relevant budgets and
device profiles, coherent release/model/cache identity, actual Worker lifetime
handling, coaching score-scale checks, latency/memory limits, and an HCE
fallback. Select one evaluator for a whole search; mixing scores without
retuning or identity separation can invalidate search assumptions. Existing
deployment assets and default HCE behavior are unchanged by these tools.
