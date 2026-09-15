# Synthetic phase-head runtime probe

This diagnostic answers a narrow engineering question: what do the registered
H4/H8 shared-input, dual-head arithmetic and parameter storage cost in a compiled
copy of Chessy's engine? It does not evaluate trained parameters or establish
Elo, candidate acceptance, practical performance saturation, or device readiness.
The CLI generates deterministic, nonzero synthetic parameters from a fixed seed;
it accepts no trained-model input. No natural corpus, unopened NNUE test set,
formal opening suite, or incident is read.

The two implementations use the same parameters and integer arithmetic:

| Implementation | Accumulation |
| --- | --- |
| `refresh` | A separate occupied-piece pass after HCE evaluation |
| `fused` | Accumulate both perspectives during HCE's existing piece pass |

Both recalculate the neural accumulators for each evaluation. Neither is an
incremental make/unmake implementation. Each adds the rounded residual to the
unchanged shipped HCE score, including its existing mop-up term. The neural
clipped activations use int32, the tapered heads and rounding use int64, and the
White sign is applied after rounding from side-to-move perspective. The same
independent BigInt reference used for training generates authored Rust test
expectations and checks the complete compiled evaluator against shipped WASM.

Preparation creates a fresh directory outside all Git checkouts, copies the
captured engine source and pinned build configuration, and emits the synthetic
source plus a no-replace receipt. Trained parameters and generated modules are
never written to tracked production paths. The probe records source, template,
reference, loader, parameter, baseline and compiled-module hashes. This is a
trusted isolated-runner diagnostic, not hostile same-account attestation.

Run the existing **Tests** workflow manually with `nnue_synthetic_probe=true`
to build all four H4/H8 × refresh/fused configurations using the existing pinned
Rust/Binaryen toolchain. Alternatively, apply the `nnue-synthetic-probe` PR label
before the next normal PR push/check; labeling alone does not dispatch a run.
The default is false, so unlabeled ordinary PR checks only run
the inexpensive exporter tests. The optional run first reproduces the shipped
WASM byte-for-byte; it then runs generated native Rust parity tests, compiles
each copied crate through its pinned build script, and measures its module.
The `nnue-synthetic-probes` artifact contains all four completed JSON reports,
source receipts and diagnostic WASM modules. A failed/incomplete probe emits no
completed measurement report.

For one configuration with the pinned tools already installed:

```sh
probe_parent=$(mktemp -d)
node tools/training/nnue-phase-runtime.js prepare "$probe_parent/h4-fused" 4 fused
(cd "$probe_parent/h4-fused" && cargo test --locked --offline nnue_research_parity)
sh "$probe_parent/h4-fused/build.sh"
node tools/training/nnue-phase-runtime.js measure "$probe_parent/h4-fused" "$probe_parent/h4-fused.json"
```

The fixed diagnostic plan uses eight already exposed authored legal evaluator
positions, four alternating-order paired repetitions, 10,000 direct WASM
evaluation calls per measurement after warm-up, and search budgets of 4,096 and
16,384 nodes. Complete raw records are retained. Search NPS divides by actual
visited nodes; reports also count pairs consuming the complete requested
budget, because mates can stop earlier. Synthetic scores change search paths,
so fixed-node NPS is not a strength or matched-trajectory result. Desktop V8
measurements do not satisfy the physical-device admission requirement in #84.
Two historical adjacent-king mop-up fixtures remain in static parity only;
their invalid game positions never enter timing or search. Native Rust parity
checks the complete exported evaluator as well as the neural refresh function,
so it covers fused accumulation before the WASM comparison runs.

No compiled results are claimed before the optional workflow succeeds. A real
candidate needs its separately registered quality, quantization, parity, size,
runtime and strength gates; this mechanism-only probe cannot satisfy them by
being relabeled or by omitting its synthetic status.
