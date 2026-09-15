# Prospective hybrid admission design — proposal only

This proposes design choices for a future implementation of
[#175](https://github.com/den-run-ai/chessy/issues/175). It does not change an
existing runner, estimator, manifest or acceptance result. No formal dispatch
is admitted by this document alone. The selected hybrid can be compiled and
measured in an isolated research runner now; production integration still
needs the actual numerical, source/build, size, signature and device evidence.

## Preserve the existing bank as diagnostic

The immutable 400-opening bank has SHA-256
`bda65b3253951863f2b01187b2a44becb8d36d29a7917780f6d920a92f4d7dab`.
The [complete dependency map](../match-v2/family-map.json) has literal file
SHA-256 `f954a03c2d3243106e4e26adc6537d915236442232d584e6fb8fb5dc34440225`.
Its 52 connected components include 374 endpoints connected to known
historical exposure. The other 26 endpoints are not a fresh holdout because
the exposure ledger is incomplete for that purpose. Keep the current bank,
its diagnostic estimator and `formalPass:false` unchanged.

## Proposed fixed-node claim and sampling policy

Use a **new finite bank**, with a new identity, for one frozen evaluator
candidate against one frozen shipped base at the existing 10,000-node
evaluator profile. The estimand is the endpoint-weighted average of the
candidate's two-color mean scores over that exact bank. It is not a
family-weighted average, universal chess strength or human Elo.

The bank must contain at least 8,192 admitted endpoints, drawn by an
outcome-blind, frozen procedure from authenticated permissively licensed
natural games. Prefer one endpoint per source game. Preserve exact/mirror,
static-family, named-family where available and prefix relationships using
the current deterministic dependency algorithm with its source hash pinned;
include source-game joins for new data. Produce the complete bank-plus-
training/development exposure map and ledger, and exclude directly exposed
endpoints plus components linked to exposure **before** freezing the bank.
If the algorithm cannot supply enough unexposed endpoints, revise its proposed
bank size or collection procedure before sampling or candidate measurements;
do not relax exposure rules after scores are seen.

Freeze the candidate, base, bank and implementation before generating the
sampling seed. Quarantine bank positions against further fitting and gate
selection. A bank collected after model freeze can meet this boundary; there
is no reason to repeat completed training just to move its calendar date.
Generate one OS-entropy-backed seed in the trusted dispatcher, preserve its
literal receipt and sample exactly 4,096 endpoints uniformly without
replacement using a specified, unbiased integer sampler. No seed search,
hash-ranking of a public bank, discarded draws or replacement sample is
permitted. The entire exact two-color schedule is frozen before search.

Use one candidate/profile and one-sided `alpha=0.05` for this initial claim.
The conservative bound is
`LCB=max(0, mean - sqrt(log(1/alpha)/(2*n)))`; admission requires `LCB>0.50`.
Under sampling without replacement, bounded **fixed** finite-population
outcomes satisfy this Hoeffding bound without treating related endpoints as
independent. The source is [Bardenet and Maillard, Proposition 1.2](https://arxiv.org/abs/1309.4029).
The deterministic fixed-node runtime must therefore be authenticated and
verified; deadline-based aborts cannot silently replace node-limited games.
The map remains necessary for exposure accounting and interpretation, not to
invent an effective sample size. Unequal family sizes retain their literal
endpoint weights. A missing or modified map invalidates the run.

This deliberately simple first estimator avoids an unsupported normal or
cluster-bootstrap model. A tighter finite-population bound or a properly
specified sequential test may be proposed **before** results, but cannot be
selected retrospectively because it passes. A second candidate/profile or
another formal attempt requires an advance error-budget amendment; it does
not silently receive a fresh 5% allowance.

## Feasibility and what this can detect

| Paired endpoints | Games | Conservative one-sided radius at alpha .05 | Score needed to pass |
| --- | ---: | ---: | ---: |
| 400 | 800 | 6.119 percentage points | Above 56.119% |
| 1,024 | 2,048 | 3.825 percentage points | Above 53.825% |
| 4,096 — proposed | 8,192 | 1.912 percentage points | Above 51.912% |
| 16,384 | 32,768 | 0.956 percentage points | Above 50.956% |

These are conservative observed-score thresholds, not power calculations.
At the proposed size, a tiny genuine gain can remain inconclusive. There is
no defensible guarantee that $30 can resolve it.

Estimate total runtime on exposed development games first. For `n` endpoints,
mean `p` searched plies/game and mean `t` seconds/ply, engine time is roughly
`2*n*p*t`, plus warmup, load, validation and artifact overhead. For example,
4,096 endpoints at 100 plies and 20 ms/ply require approximately 4.55 CPU-hours
before overhead. This is a planning example, not a Chessy timing result or
Modal price quote. Freeze the measured projection, resource rates, paid cap
and reserved failure overhead before dispatch. If this registered sample
cannot fit, stop at diagnostic findings; never shrink the sample after scores
or substitute repeated games for endpoints.

## Equal-time and physical-device evidence remain distinct

The design above would address a fixed-node statistical question once
implemented and validated. It does not prove
an Elo/time improvement. Run a separately registered equal-time development
comparison of the compiled hybrid with shipped and expanded HCE, using the
same hardware, alternating execution order, identical time allowance, complete
repetition history and the actual clock-abort path. Preserve overshoot and
failure data. Such results can reject a costly candidate and justify the
formal investment. Do not apply the fixed-population bound above to a noisy
deadline-based game schedule without a separately justified execution-noise
model and prospective protocol.

Issue [#84](https://github.com/den-run-ai/chessy/issues/84) already requires
physical iOS/WebKit and Android/Chromium runtime evidence, including startup,
all levels, fallback/offline behavior and sustained thermal behavior. Existing
owner iPhone evidence establishes a historical Master path, not measurements
of a new hybrid. Hosted Chromium/WebKit checks can verify compatibility and
provide hosted timings; they cannot manufacture battery or thermal evidence.
This boundary blocks a production NNUE release, not research code, CPU fits,
compiled research modules, development matches or reviewable evidence PRs.

## Minimal implementation needed before formal use

Implement the new bank builder/admission inventory, sampler/receipt,
registration and estimator under a new protocol identity. Independently
recompute the sample, pair scores and bound, with adversarial fixtures for
uniform integer sampling, exact sample inventory, duplicate family outcomes,
unequal family sizes, altered/missing maps, mixed candidate/build/runtime
identities, late candidate changes and incomplete games. Artificial rules-only
fixtures must not search either holdout.

Retain current v2 legal replay, complete two-color schedules and raw failure
records. Invalid output, deadline abort, missing artifact or infrastructure
interruption makes the entire formal result invalid; preserve the evidence
and do not retry automatically. Complete the declared sample even if the
running score looks decisive. No score-based exclusions, extensions, candidate
switches, automatic restarts or optional stopping are permitted.

Bind the accepted bank/map/sampler/estimator, source/model/build identities and
the existing numerical, size, signature and runtime prerequisite receipts in
registration and aggregation. A diagnostic score above 49% is never an
evaluator strength pass. Only the implemented, authenticated protocol plus
all separate product gates can change the production verdict.
