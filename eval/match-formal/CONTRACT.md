# Fresh finite-bank formal admission

The software for #175 is implemented under the new identity
`chessy-finite-bank-4096-pairs-v1`. **No campaign is admitted.** The trusted
[registry](registry.json) contains `campaign: null`, so the new manual workflow
fails preflight before it reserves an opportunity, draws a sample or searches.
The current 400-endpoint bank, complete family map, v2 runner and diagnostic
`formalPass: false` result remain unchanged. Its 374 endpoints in components
linked to known exposure make it unsuitable for this fresh-bank contract.

This implementation follows the [hybrid admission proposal](../hybrid-research/ADMISSION.md).
It does not create a fresh bank, manufacture physical-device evidence, measure
a candidate, change production, or close the remaining evidence work in #175.
Research and infrastructure can be merged while those prerequisites are absent.

## Claim, grouping and uncertainty

The target is the **endpoint-weighted average two-color candidate score over
one exact fresh finite bank**, against one exact base at one fixed-node budget.
Each endpoint's score is the mean of its white and black games in `[0,1]`.
It is not a human Elo claim or a guarantee on chess positions outside the bank.

Freeze a bank of 8,192–10,000 unique, nonterminal endpoints before selection.
One endpoint per authenticated source game is required. Legal exact/mirror
position duplicates are forbidden. Named opening, static structural, exact/
mirror and complete-prefix relationships of at least six plies use the
transitive algorithm in `test/ai-match-family-map.js`, whose code digest is
bound in the harness. Because source games occur only once, within-bank
source-game joins are unnecessary; any overlap with an exposed source-game
identity rejects the bank. Reject the entire proposed bank if its complete
map has any component linked to declared training, validation, development or
historical formal exposure. Exclude such components in an outcome-blind bank
builder before freezing; never drop endpoints from a measured schedule.

Bank provenance, source licenses, the full exposure ledger and quarantine are
reviewed evidence. The code verifies complete map reproduction, exact/mirror
uniqueness, source-game uniqueness, declared exposure and identity. It cannot
infer omitted training history or prove that a claimed source ID is truthful.
The required `bank-provenance-exposure` receipt must establish that independently.
The initial format admits CC0 natural-game sources only. An alternate license
or collection procedure needs a prospective reviewed protocol revision.

A family with `k` of `N` endpoints has target weight `k/N`; unequal families
are not averaged equally or silently downweighted. All groups, including
singletons, stay in the complete map. Their counts never become an effective
sample size. An independent fixed-population sampling argument supplies the
uncertainty, so similar or identical outcomes within a family are allowed.

After candidate, base, bank, implementation and prerequisites are frozen, the
trusted dispatcher performs exactly one partial Fisher–Yates sample using
Node's OS-backed [`crypto.randomInt`](https://nodejs.org/api/crypto.html#cryptorandomintmin-max-callback)
rejection sampler. Retained integer draws
independently reproduce the exact 4,096-endpoint sample without replacement.
The complete sample and both-color schedule are registered before any search.
No seed input, hash ranking, discarded draw, resampling or optional stopping
exists. Cryptographic OS randomness and an honest runner are trust assumptions;
retained draw integers alone cannot prove entropy quality against a malicious
operator.

For `n=4096`, one-sided `alpha=.05`, the bound is:

```
radius = sqrt(log(1 / alpha) / (2 * n))
lower  = max(0, mean - radius)
```

The Hoeffding inequality for sampling without replacement applies to bounded
**fixed finite-population outcomes**, without iid opening/family outcomes;
see [Bardenet and Maillard, Proposition 1.2](https://arxiv.org/abs/1309.4029).
It remains conservative when a substantial fraction of the bank is sampled;
this implementation does not substitute a tighter bound after seeing results.
Fixed-node determinism is therefore a separately required verified receipt.
Time-limited or nondeterministic execution cannot use this protocol.

The radius is approximately **1.912 percentage points**. Evaluator acceptance
requires observed score above approximately **51.912%** to make the lower bound
strictly greater than 50%. This is a threshold calculation, not a power claim.
It may fail to resolve a small real improvement. If exposed development timing
or cost cannot support 8,192 games, keep the candidate experimental; do not
shrink the sample after results or replace endpoints with repeats.

| Profile | Nodes/move | Admission condition |
| --- | ---: | --- |
| `evaluator-easy` | 10,000 | Lower bound strictly greater than 50% |
| `selective-hard` | 230,000 | Behavior-changing selective search only: lower bound strictly greater than 49%, plus reviewed product-budget efficiency evidence |

### Pure search-cost improvements need a different admission policy

The selective-search profile is **not a usable noninferiority gate for an
exactly behavior-preserving optimization**. At the same fixed-node budget,
identical play produces a 50% score in every color pair. The current bound
then gives `50% - 1.912% = 48.088%`, which cannot exceed 49%. Its observed
score must instead exceed approximately **50.912%** to pass. This threshold
also makes it conservative for a behavior-changing search candidate whose
true bank score is merely equal to the base.

Consequently, campaign preflight now requires `changeClass: "evaluation-change"`
for `evaluator-easy` or `changeClass: "selective-search-change"` for
`selective-hard`. Missing, mismatched or `behavior-preserving-search-cost`
classes are rejected before reservation or sampling. Trusted campaign review
must verify the class; declaring it is not evidence of changed behavior.
The selective profile remains available for search changes with credible
**playing-strength gains as well as measured runtime benefit** in development.

The unchanged bound would require at least 14,979 sampled endpoints for a
50% mean to exceed the 49% lower-bound threshold. That exceeds this protocol's
10,000-endpoint bank cap and is a theoretical limitation, **not authorization
for a larger match**. No estimator, alpha, sample size, old-bank identity or
already registered result is changed by this clarification. No formal sample
has been drawn, and the registry remains empty.

Admission of pure search-cost work stays open in #175/#84. A separately
reviewed equivalence/runtime policy must establish what behavioral equivalence
is claimed and how it is verified, plus product-budget and physical-device
benefits. Passing a finite set of signatures or paired development games
alone does not prove equivalence on every chess position. Until that policy
exists, preserve such improvements as research and infrastructure rather than
route them through the unsuitable selective profile. A tighter uncertainty
method would need its own prospective mathematical review and feasibility
assessment; none is introduced here to make a current candidate pass.

Both profiles use depth ceiling 30, quiescence, exact repetition history and
180 searched plies after the opening. Rules-terminal adjudication precedes
artificial ply-cap draws. The single campaign chooses one profile in advance;
the >49% condition never passes evaluator admission.

## One lifetime opportunity and failure handling

The registry fixes one global opportunity, `initial-formal-opportunity-v1`,
with total alpha `.05`, shared across every candidate/profile/name. There is
no automatic second attempt or fresh alpha for a new candidate. Any future
amendment must prospectively account for the consumed error budget.

The default-branch-only workflow has four stages:

1. Authenticate the complete campaign and prerequisites without search. Scan
   the workflow's complete prior run/job history. Failed preflights spend no
   alpha. Unavailable history fails closed.
2. Upload the immutable preflight as the reservation. A successful reservation
   consumes the opportunity even if the draw, execution or later uploads fail.
   Its trusted job-step conclusion remains the authority when artifact bytes
   expire. The global concurrency group prevents two simultaneous reservations.
3. Draw once, preserve literal canonical registration bytes, then run all 32
   shards of 128 endpoint pairs. Every record and failure is preserved.
4. Authenticate every shard and independently replay every legal move, history,
   terminal result and paired score. Missing, duplicate, extra, mixed,
   noncanonical, truncated, failed or invalid-counter records invalidate the
   whole run. Only the complete aggregate can emit a formal verdict.

No selective reruns, extensions, score-based exclusions, partial summaries or
cross-dispatch combinations are admitted. All rerun attempts are rejected.
A statistical miss fails the formal job while its full summary is preserved.
There is no automatic merge or deployment. Like existing trusted workflows,
this design does not defend against an administrator deleting run history,
rewriting trusted main or compromising a runner. Unavailable historical job
metadata blocks use; it is never treated as proof of an unused opportunity.

## Authenticated prerequisite boundary

A later reviewed campaign must supply canonical JSON attachments under
`eval/match-formal/`, each referenced by literal path and SHA-256. Candidate
and base are exact 40-character Git SHAs. The trusted harness reads retained
Git blobs with replacement objects disabled and binds complete source,
build, raw-module, helper, estimator, grouping and workflow identities. Both
registration and aggregation reauthenticate those same identities. The pinned
runtime is Linux x64, Node 22.23.2 and its recorded V8 version.

Every evidence receipt is bound to exact candidate/base module, source and
build digests and the selected profile. Required kinds are:

- Source/build reproduction and numerical/model parity (including an explicit
  reviewed not-applicable explanation for a non-neural evaluator).
- WASM size, tactics/correctness and governed signature admission (#155).
- Physical-device runtime (#84), deterministic fixed-node execution and the
  bank provenance/exposure review.
- Full-sample development runtime/cost projection, with paid cap at most $30
  and predicted shard time at most 35 minutes within the 45-minute timeout.
- For selective search, a frozen product-budget wall-time/depth benefit.

The machine requires every receipt, `result: "pass"`, its evidence pointer,
and all exact identities. Trusted-main campaign review must inspect the
underlying evidence; self-authored receipt text does not manufacture a
measurement. Hosted Chromium/WebKit cannot substitute for physical devices.
A digest is artifact authentication, not proof that an observation is true.

The bank and map are separate authenticated attachments. The bank contains
`schema: "chessy.fresh-finite-bank.v1"`, a new `id`, canonical ID-sorted
`openings` with legal `pgn`, matching `fen`, `family` and `sourceGame`, plus
`sourceLicense: "CC0-1.0"`, the frozen selection string and a complete exposure
ledger. Campaign `quarantine` binds bank digest and frozen candidate and
forbids any further model or gate selection. The map is the exact canonical
result of `buildFormalMap(bank.openings, bank.exposureSources)`, not a selected subset. This wrapper adds named-family and source-game exposure
where the fresh ledger supplies it, preserving the historical mapper unchanged.
Implementation schemas and strict checks are in `test/ai-match-formal.js`;
no example campaign with fabricated passing evidence is committed.

## Validation and outstanding work

`node test/ai-match-formal.test.js` uses synthetic rules-only trajectories,
finite-population exhaustive fixtures, independent Python arithmetic,
uniform-sampler enumeration and adversarial bank/map/evidence/schedule
mutations. It searches neither the historical holdout nor a fresh bank.
The ordinary PR CI runs these checks. The lightweight
`node test/ai-match-formal-planning.test.js` separately verifies the threshold
limitation and rejects unsupported campaign classes before engine/prerequisite
work. Existing v2 replay/grouping tests remain separate and unchanged.

Still outstanding before a formal dispatch: collect/admit the fresh bank,
finish exposure/source provenance, freeze one development-qualified candidate,
obtain physical-device/signature and remaining candidate-specific evidence,
and measure the complete execution cost on exposed development positions.
No formal workflow was dispatched to build or test this infrastructure; paid
compute was $0. Issue #175 remains open for those concrete prerequisites.
