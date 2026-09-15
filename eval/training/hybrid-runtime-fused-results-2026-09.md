# Exact-score optimization results

Both registered optimizations preserved complete evaluation and every returned
fixed-node search field, but **neither met the prospective 5% overall paired-median 16K NPS
improvement requirement**. No optimized implementation was selected and the
conditional 200-game follow-up was not triggered. No threshold, phase weights,
model, selection metric or timing run was changed after observing costs.

The [prospective mechanism plan](hybrid-runtime-fused-v1.md) was committed in
`e4154da` before these optimizations were executed and before original game
outcomes were analyzed. Commit `2a4afed` clarified that timing may select an
implementation while the model remains frozen, also before execution. The
[complete aggregate receipt](hybrid-runtime-fused-results-2026-09.json) binds
source, weights, compiled modules, raw timing evidence and every gate.

| Mechanism | Fast WASM bytes | Brotli bytes | Overall 16K NPS vs concurrent original | Eligible? |
|---|---:|---:|---:|---|
| Original hybrid | 58,085 | 28,857 | baseline | control |
| Raw phase cache | 59,769 | 29,185 | +0.402% | no |
| Phase cache + shared HCE work | 55,047 | 28,766 | +0.418% | no |

The shared implementation removed duplicated HCE feature extraction inside
the blend band. It made the middlegame stratum substantially faster and reduced
raw module size by 3,038 bytes, but that benefit did not extend across enough
positions to pass the registered overall median gate.

| Phase stratum | Cached 16K NPS vs original | Shared 16K NPS vs original |
|---|---:|---:|
| Opening | −0.25% | −1.26% |
| Middlegame | +3.24% | +20.90% |
| Endgame | −1.56% | +0.33% |

Both mechanisms passed the guard against any phase stratum regressing more
than 5%. In the separate 40 ms diagnostic, the shared implementation improved
middlegame NPS by 18.08%, but its overall paired-median NPS gain was only 0.26%.
The prospectively registered eligibility statistic remained the 16K paired
median; no alternative aggregate was substituted to select a candidate.

Validation:

- The concurrent original module reproduced the previous hybrid SHA-256
  `18c69302d9aaecc0078a5b398e68789f24adb66e525c99f8bc9ac9ddc60e9493` exactly.
- Original, cached and shared crates passed 11, 16 and 13 native tests,
  respectively. No numerical or implementation fixes were needed during
  execution. Each optimization matched an independent original scalar evaluator
  and a raw board-summed phase on 13,919 authored tree states, plus promoted
  material and a parser-only phase-256 fixture.
- `Position` grew from 74 to 76 bytes; `Undo` stayed at 10. The phase cache is
  never clamped during transient move writes, including queen moves and
  promotion; clipping occurs only for evaluation.
- Both optimized WASMs exactly matched all 501 complete-evaluation cases and
  all 96 returned original fixed-node search result objects per mechanism,
  including moves, scores, depth, stop reasons and node counters.
- **Validation deviation:** the protocol also required PV comparison, but
  `engine.search()` did not return a PV field and this experiment did not fetch
  it separately. PV equality was not established. Thus the complete prospective
  search-validation requirement remains unfulfilled; the observed result-object
  equality must not be described as full PV/search equivalence. Both mechanisms
  independently fail the throughput gate, so this omission cannot permit a
  candidate or trigger the conditional game follow-up.
- The single quiet-host run retained all 768 registered timing records and
  all three mechanisms. There was no selective timing retry.

These are two bounded engineering ablations of the same tested model. They
establish a useful improvement in the transition-heavy stratum and a smaller
research module, while rejecting both candidates under the registered broad
throughput criterion. They do not establish universal runtime saturation or
change the separate teacher-test evidence. The original hybrid's cost remains
material: its concurrent 16K paired-median NPS was 13.94% below shipped HCE in
this run, versus 17.82% in the earlier distinct run. Comparisons used concurrent
controls; these one-host diagnostic samples are not confidence intervals or
physical-device admission.

No new weights or labels, paid compute, production assets, level changes or
formal strength claims resulted from this mechanism study. All research
modules retain the one-page memory allowance; production memory limits remain
unchanged. The initial 400-game evidence failure and subsequent capture
infrastructure repair are documented separately and provide no valid game
score for these implementations.
