# Prospective admission decision — no formal dispatch

Keep the immutable 400-opening bank and its v2 workflow **diagnostic only**.
Issue [#175](https://github.com/den-run-ai/chessy/issues/175) remains open.
This proposal and the static map below consume opening metadata, legal replay
and known historical exposure only; they consume no candidate outcomes and do
not change the runner, schedule, estimator or `formalPass: false` result.

The practical next step is to saturate model choices on development data, then
measure the selected compiled candidate's strength and elapsed time on a
separately registered exposed development corpus. That can reject a slower or
weaker model without opening the formal bank. A positive development result
justifies preparing formal admission; it does not replace it.

## Complete dependency map

[family-map.json](family-map.json) binds every one of the 400 endpoints to a
reproducible connected component and hashes the complete map. The identity is
`chessy.match-family-map.v1`, separate from the historical grouping audit and
all execution protocols. The file binds its implementation, chess/replay
helpers and the exact retained bytes of both historical exposure sources.

Join two endpoints when they share any of:

1. The exact or color/rank-mirrored legal repetition position.
2. The frozen static pawn/king/material family.
3. The catalog's literal named opening family.
4. A complete line of at least six plies, where one is a strict prefix of the
   other. Both ancestor and descendant relationships count.

Take the transitive closure. Sort endpoint IDs lexicographically and hash each
component's complete ID list for its ID. Record a deterministic spanning forest
of joins and every endpoint's component. Mark direct historical exposure under
rules 1, 2 or 4, then propagate that mark through the entire component. The old
sources do not supply the same named taxonomy, so named matches with them are
not silently inferred.

| Static result | Count |
| --- | ---: |
| Complete opening endpoints | 400 |
| Connected components | 52 |
| Largest component | 63 endpoints |
| Endpoints directly linked to known exposure | 253 |
| Endpoints in components with known exposure | 374 |
| Components with no known exposure | 19, containing 26 endpoints |

These are conservative dependency descriptors, **not independent samples**.
The different direct-exposure count from the older audit also includes
ancestors of exposed lines and unions the exposure reasons. A known link does
not prove a particular candidate was biased. Conversely, the 26 remaining
endpoints are not a fresh formal holdout: absence of exposure covers only the
two authenticated historical sources, not later model training, source games
or all development measurements. Do not drop the other 374 endpoints from the
existing schedule or treat the remaining 19 components as independent trials.

Reproduce without engine search:

```sh
node test/ai-match-family-map.js > eval/match-v2/family-map.json
node test/ai-match-family-map.js --check
node test/ai-match-family-map.test.js
```

## A viable future statistical design

A future proposal should target a **declared finite opening population**, not
an undefined population of all chess or a human Elo rating. Freeze a new bank
with a new identity and a full training/development exposure ledger; quarantine
it before fitting. Name whether the target is an endpoint-weighted mean or a
family-weighted mean. They are different estimands when families have unequal
sizes; neither can be substituted after results are known.

One defensible endpoint-weighted design freezes candidate and base first,
then draws a genuinely random simple sample of endpoint IDs **without
replacement** from that bank, using an authenticated, unrepeated random draw.
Both candidate colors form one endpoint score in `[0, 1]`. Deterministic game
outcomes are fixed finite-population values: uncertainty comes from randomized
selection, so no assumption that similar openings produce independent outcomes
is needed. Hash-ranked selection from the existing public bank cannot be
retroactively called such a prospective random draw. The claim would apply
only to the declared bank and frozen execution budget.

For planning, the conservative one-sided Hoeffding bound for sampling without
replacement is `mean - sqrt(log(1/alpha) / (2*n))`; tighter finite-population
bounds can be specified before measurement. This is supported by
[Bardenet and Maillard, Proposition 1.2 and subsequent finite-population bounds](https://arxiv.org/abs/1309.4029).
At `n=400`, `alpha=0.05`, its radius is 6.12 percentage points: a strict
strength pass needs more than 56.12% points. For two planned opportunities
with Bonferroni `alpha=0.025` each, the radius is 6.79 points. This is a
conservative planning bound, not a power calculation or a claim that 800
games will detect a small evaluator improvement. A full census instead gives
an exact finite-bank mean, with no sampling interval; changing the product's
admission rule to that narrower descriptive claim would need explicit review.

Before implementing any formal protocol, settle the new bank, sampling
mechanism, minimum worthwhile effect, sample size and finite-population bound
together. Estimate runtime using exposed development positions. If no feasible
sample under the available budget can answer the desired question, retain the
candidate as research. Repeating deterministic games does not add endpoints.

## Required final registration

The eventual formal contract must bind bank and full grouping/exposure map,
sampling receipt, candidate/base/build/runtime identities, exact endpoint and
color schedule, budgets, estimator, confidence level, and candidate/profile
multiplicity. Freeze failure handling, complete raw preservation and the ban
on score-based retries, exclusions, extensions and optional stopping. Any
repeat attempt consumes the same predeclared family-wise error budget; a
changed candidate cannot silently restart the 5% allowance.

Evaluator acceptance stays strictly above 50%. The >49% selective-search
noninferiority threshold additionally requires its predeclared product-budget
wall-time/depth benefit and can never stand in for evaluator strength. Missing
or mixed identities, incomplete schedules, unknown exposure provenance or
unauthenticated admission prerequisites must fail closed.

The estimator is only one gate. Reproducible source/module/build evidence,
quantized model parity, size, tactics/correctness, governed signature admission
[#155](https://github.com/den-run-ai/chessy/issues/155), and physical-device
runtime evidence [#84](https://github.com/den-run-ai/chessy/issues/84) remain
separate. Hosted speed tests cannot supply missing physical-device observations.
Research code and diagnostic infrastructure may be reviewed and merged while
an evaluator remains experimental; training saturation alone does not qualify
that evaluator for production.
