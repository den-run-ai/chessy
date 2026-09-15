# V4 factorial and bounded training-budget screen

V3 did not include H8 single-head residuals in its factorial. That omission
matters because the earlier H8 single-head development result was promising.
V4 includes both widths and architectures under the already established 13 KB
offline parameter ceiling. It also corrects the phase comparison's doubled
output regularization without changing either numerical inference model.

| Parameters only | H4 | H8 |
| --- | ---: | ---: |
| Single head | 6,180 bytes | 12,356 bytes |
| MG/EG phase heads | 6,200 bytes | 12,392 bytes |

The first stage is the complete `H4/H8 × single/MG-EG × endgame weight 1/4`
factorial: eight recipes, three fixed seeds, 300 epochs, 24 fits. Trunk L2
remains `.01`; single-head output/bias L2 is `.01` and each phase head/bias
uses `.005`. Identical phase heads therefore recover exactly the single-head
objective and the gradient along the tied-head direction. This equality is
tested for every material phase, both widths, and float and QAT execution.

The recipe with best median unweighted inner CE among phase-eligible recipes
is frozen before the second stage. Only that recipe receives fresh 900- and
1,800-epoch schedules, each with three seeds. If the latest eligible budget
improves the best shorter eligible median by more than 0.1%, a registered
3,600-epoch extension runs with three seeds. If that still improves by more
than 0.1%, a final 7,200-epoch extension runs with three seeds. All numerical gates remain
mandatory even for losing budgets. Among phase-eligible budgets, choose the
shortest within 0.1% of the best median CE. The final seed is the median seed
at that chosen budget; one fresh full-train refit uses its recipe and the
median selected checkpoint epoch. At most 36 development fits plus one refit
are allowed: 37 total.

There are no optimizer restarts within a fit. All longer-budget fits start
independently from their fixed initialization and stretch the
cosine/QAT schedule. Their comparison measures a finite compute-budget change,
not continuation convergence. It describes the selected recipe only; other
factorial recipes are not exhaustively searched at longer budgets. Each stage
publishes a bound progression receipt. `saturationReached` is true only when
the latest eligible budget improves by at most 0.1%, with
`endReason=bounded-budget-plateau`. A phase, numerical, elapsed-time or maximum
epoch cap without this plateau is explicitly **not saturated**. After this
registered grid, no additional recipes or threshold adjustments are allowed.

The same development split has already informed earlier experiments. Shipped
HCE alone gates inner phase eligibility because expanded HCE trained on these
inner labels. Both frozen comparators remain mandatory for the unchanged
outer and test guards. Outer validation has also been exposed previously and
is exploratory. One final candidate is frozen before its single outer read.
Test remains sealed until a separate opening command, with the same global
dataset marker and restored-legacy-marker protection as v3.

`h4_v4_recipe.py` adapts weighted loss and group regularization. All binary
formats, phase inference, quantization and independent JavaScript oracles
remain those of the frozen v2/v3 models. The v4 executable loads an isolated
v3 helper module and explicitly binds its own contract and adapters. Its
implementation receipt includes both new source files and all reused sources.
The shared test receipt retains the v3 format schema; the frozen v4 contract
digest identifies the actual experiment.

After a reviewed, clean, committed implementation:

```sh
python tools/training/natural-nnue-h4-v4.py --bundle /absolute/audited-bundle --output /absolute/new-v4-output
```

Only an eligible frozen selection can subsequently be opened once:

```sh
python tools/training/natural-nnue-h4-v4.py --bundle /absolute/audited-bundle --open-test-from /absolute/new-v4-output
```

No model, runtime integration, level calibration, or formal playing-strength
claim follows from the offline screen alone. Prior experiments and numerical
source files are unchanged. Paid compute is planned at $0 within the user's
$30 ceiling; the registered elapsed bound is 5,400 seconds after authentication.
