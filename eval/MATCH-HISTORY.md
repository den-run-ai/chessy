# Historical v1 match protocols

These contracts are retained for reproducing archived evidence. New candidates
must use the current [admission path](README.md#calibration-and-matches).

The v1 fixed-node schedule used 100 openings × four seed slots × both colors:
800 games, but only 100 opening clusters. The historical Rust/WASM search
ignored those seed slots, making them deterministic repeats. Existing
clustered results retain that interpretation; the repeats do not create 400
independent openings. Do not dispatch v1 for new candidates or relabel its
artifacts as v2.

## Strength and efficiency

Both historical fixed-node contracts used 10,000 nodes per move and a 180-ply
cap. Thresholds apply to the opening-clustered, one-sided 95% lower bound.

| Change | Runner | Historical acceptance |
| --- | --- | --- |
| Evaluation or playing strength | `test/ai-match.js --formal --nodes 10000 --plies 180` | Lower bound strictly above 50%, against a distinct base commit |
| Search efficiency with a separately demonstrated material benefit | `test/wasm-efficiency-match.js` | Lower bound strictly above 49% |

The efficiency threshold cannot substitute for a strength gate. Its runner
compares exact candidate and frozen base modules across the reviewed
ABI-v2/v1 ordinary-search boundary; production remains ABI-v2-only. See the
[WASM guide](../experiments/wasm/README.md) for the maintainer-label-gated
`WASM fixed-node efficiency gate` workflow. Adding a harness does not itself
authorize or launch the 800-game run.

Custom node budgets or ply caps produce a separate diagnostic protocol.
`--nodes` and `--time` are mutually exclusive.

## Equal-time diagnostics

`test/ai-match.js --time 5000 --seeds 1` used the same 100 openings in both
colors, for 200 games at five seconds per move. It remains draft diagnostic
infrastructure, separate from formal fixed-node evidence.

The prior opening-level variance implied about 12% power to clear a
one-percentage-point non-inferiority margin with 100 clusters. A pass is
useful evidence, but neither a pass nor a miss replaces the fixed-node result.
These artifacts also lack per-move deadline, elapsed, and overshoot records,
so their equal-compute premise is not independently auditable.

## Workflow and result handling

The `AI fixed-node strict-strength gate` and
`AI equal-time diagnostic (DRAFT)` workflows each use 20 shards and automatic
aggregation. Their check contexts cannot substitute for one another.

Only the complete 800-game formal aggregate emits a strength verdict; formal
shards report statistics without PASS/FAIL. A valid statistical miss fails the
strict-strength check and remains informational in the equal-time diagnostic.
Malformed, mixed, or incomplete artifacts fail either workflow.

Never selectively rerun shards, combine dispatches, retry a valid statistical
miss, or change the protocol after seeing results. Historically exposed
openings support only separately registered development diagnostics. New
formal shipping evidence requires the fresh-bank campaign and candidate
prerequisites in [#175](https://github.com/den-run-ai/chessy/issues/175).
