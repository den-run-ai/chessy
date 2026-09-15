# Hybrid evaluator research — 2026-09-15

This document preserves the **pre-experiment rationale**. The subsequent
[hybrid report](../neural-hybrid-v1/REPORT.md),
[compiled cost report](../training/hybrid-runtime-results-2026-09.md) and
[match evidence report](../training/hybrid-match-results-2026-09.md) contain
the measured findings. The NNUE test was subsequently opened once under its
separate registration; statements below describe the earlier review stage.

The next useful experiment is a compiled hybrid using the existing frozen H8
and expanded HCE, followed by development games at equal elapsed budgets.
Additional training labels and GPU fitting are not prerequisites. This document
motivates the experiment; its numerical registration and measured report are
separate. No sealed NNUE-test positions or formal opening outcomes were read
for this review.

## What the current evidence actually predicts

The [v4 report](../neural-h4-v4/REPORT.md) gives aggregate CE 0.396092 for H8,
versus 0.406480 shipped and 0.403504 expanded HCE. In the 332 coarse-endgame
validation rows H8 scores 0.274708 versus expanded HCE's 0.271050. Thus H8 is
better than shipped in endgames, but misses the stronger comparator's guard.
The coarse endgame definition is material phase below 7, where
`phase=min(24,N+B+2R+4Q)` counts both colors and excludes kings and pawns.
It is not a seven-piece definition.

Using the published rounded numbers, replacing H8 by expanded HCE on exactly
these 332 rows would give aggregate CE approximately
`0.396092 - (332/2374)*(0.274708-0.271050) = 0.3955804`:
about 2.68% below shipped and 1.96% below expanded. This is an **algebraic
hard-routing reference**, not a measured model or a forecast for a smooth
transition. It provides a useful independent sanity check for the hard gate.
Passing the endgame comparator under exact routing follows by construction;
it does not establish new generalization or stronger endgame play.

## Sources and transferable decisions

| Primary evidence checked | Implication for Chessy |
| --- | --- |
| [Stockfish 12 evaluation source](https://github.com/official-stockfish/Stockfish/blob/sf_12/src/evaluate.cpp), Git blob `09f36513047c05b873cd9b6850a5d9d4d52103db`, selects classical or NNUE evaluation using score and rule-50 conditions. The [release note](https://stockfishchess.org/blog/2020/stockfish-12/) describes both evaluators and whole-engine tuning. | Conditional use of HCE and NNUE has precedent. Its exact routing differs from our proposed phase gate, and its strength gains cannot be transferred to Chessy. |
| The [Stockfish NNUE technical guide](https://official-stockfish.github.io/docs/nnue-pytorch-wiki/docs/nnue.html#multiple-psqt-outputs-and-multiple-subnetworks) describes a direct PSQT contribution and cheap piece-count routing among output stacks. | Cheap material-dependent routing is reasonable to test. It does not require a larger hidden trunk, nor does it prove that a smooth blend is better than a hard gate. |
| [Stockfish's net-testing procedure](https://official-stockfish.github.io/docs/fishtest-wiki/Creating-my-first-test.html#nnue-net-tests) tests a new network in its engine at short and long time controls. [Fishtest mathematics](https://official-stockfish.github.io/docs/fishtest-wiki/Fishtest-Mathematics.html) uses color-paired outcomes and prospective sequential testing. | Teacher loss and isolated inference cost are screens. Compare the compiled evaluator in full search at identical elapsed budgets; retain both colors as one observational unit. Do not transplant a sequential test without its sampling model and stopping rule. |
| The [Syzygy generator documentation](https://github.com/syzygy1/tb) lists 378 MB of WDL and 561 MB of DTZ tables for up to five pieces, and distinguishes search WDL from root DTZ use. | Full tables remain disproportionate to Chessy's payload. First measure piece-count and material-signature coverage on development data, then consider external labeling or a narrowly scoped optional table subset. No large table download is needed to answer the hybrid question. |

The earlier [Stockfish/Reckless/Leela training review](../neural-h4-v2/RESEARCH.md)
still applies. These references motivate an original experiment; no third-party
engine source or network is incorporated by this document.

## Keep the meaning of the residual intact

Let `E` be expanded HCE and `N` the complete frozen H8 evaluator, including
the shipped HCE on which its residual was trained. A hybrid is
`H=(1-g)*E+g*N`. Adding H8's residual directly to expanded HCE is a different,
untrained evaluator and should not be mistaken for that mixture.

Freeze a small gate grid before scoring. Keep one hard-routing reference and
one or a few transition widths; choose once using the declared development
selection rule. An exact `g=0` branch should return the expanded integer score
without evaluating H8; an exact `g=1` branch should reproduce the complete H8
score. Specify whether mixing occurs before or after each integer rounding and
check Python/JavaScript/Rust against the same specification, including negative
half-way values and color/rank mirrors.

Validate captures, every promotion kind and make/unmake through the gate.
A legal capture can change the true evaluation by hundreds of centipawns;
large parent/child score differences alone do not demonstrate a blend defect.
Report the change attributable to routing separately, for example the
gate-only term `(g_child-g_parent)*(N_parent-E_parent)`, along with ordinary
search/tactics results. Phase can increase on promotion, so routing must work
in both directions and after restoration.

## Runtime and development games before scaling

Use the fused research implementation first. The existing
[synthetic runtime study](../training/nnue-incremental-results-2026-09.md)
found eager incremental H8 search slower than fused H8 on its fixture set,
despite faster repeated evaluation of an already loaded position. This is
evidence against assuming that an accumulator automatically saves time in
Chessy's move-generation and legality path. Actual trained weights still need
measurement.

Compare shipped, expanded-only and frozen hybrid at equal elapsed budgets on
an explicitly exposed development corpus. Report complete paired W/D/L,
timeouts, completed depths, nodes, measured wall time and size. Benchmark the
same authored positions in alternating candidate/base order to separate
evaluation overhead from changed game trajectories. Include a stronger search
budget only if the lower-budget screen warrants it and the extension rule was
frozen beforehand. Keep material-phase breakdowns descriptive.

A 20-opening/40-game screen is useful for bugs, cost and gross regressions.
Its attainable outcomes and correlated openings cannot establish a small Elo
gain. Repeating a deterministic game does not add an independent opening.
The [admission proposal](ADMISSION.md) separates this practical screen from a
prospective strength claim. Training saturation is not playing-strength
saturation and does not by itself qualify production adoption.

## When new data becomes useful

The 33,103 training rows and reused 2,374-row validation set can answer the
immediate routing and runtime questions. Use only explicitly admitted train
and exposed validation roles for coverage audits. Count all pieces including
kings, separately tabulate up to 5/up to 6/up to 7 pieces, material signatures,
castling rights and phase. Counts are eligibility upper bounds until a probe
actually succeeds with the required tables and rule semantics.

If the hybrid survives runtime/development games but residual errors remain
concentrated around the transition, a useful **new, separately registered**
collection would combine 20,000 transition/late-middle-game rows with 20,000
unbiased natural-game rows. These are proposed quotas, not collected data.
Select one row per new source game, split by source game and the complete
family map before teacher queries, and bind source-license receipts, exact
raw source bytes, exclusion ledger, teacher executable/network/UCI identities
and full search histories. Do not add or relabel the immutable old splits.
Report targeted and natural-distribution metrics separately; their mixture
does not estimate the original population without declared weights.

For covered endgames, tablebase WDL is an exact outcome under specified rules;
it is not a Stockfish centipawn value or the same probabilistic target. Retain
original teacher targets, add a separately typed tablebase label, and register
any target mixture. DTZ and the halfmove clock matter to rule-50 decisions;
draw-preserving moves can still differ in progress. Tablebase training can
improve a model but cannot make its compressed predictions exact.

Spend follows the measured bottleneck: CPU screening first, then bounded
teacher generation or broader games if warranted. The user's $30 Modal cap
is a ceiling, not a reason to allocate a GPU to a model whose complete earlier
31-fit screen took about 870 fitting seconds on CPU. Any paid dispatch needs
an observed throughput pilot, reserved worst-case charge and preserved raw
failure evidence within the remaining monthly allowance.
