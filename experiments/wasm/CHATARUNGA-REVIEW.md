# Chatarunga review and Chessy refresh

Reviewed 2026-11-26. This note separates reference-engine observations from
measured Chessy results. It is not a strength certificate or permission to
relax the existing release, signature, or evaluation gates.

## Pinned reference

The review uses Chatarunga commit
`4f389446c685e011bcc2550c682e26bdb9f7a96b` throughout:

- [14-page technical report](https://github.com/deedy/chess-chatarunga/blob/4f389446c685e011bcc2550c682e26bdb9f7a96b/docs/paper.pdf)
- [README and match table](https://github.com/deedy/chess-chatarunga/blob/4f389446c685e011bcc2550c682e26bdb9f7a96b/README.md)
- [Search and move picker](https://github.com/deedy/chess-chatarunga/blob/4f389446c685e011bcc2550c682e26bdb9f7a96b/src/search.rs)
- [Board and incremental hashes](https://github.com/deedy/chess-chatarunga/blob/4f389446c685e011bcc2550c682e26bdb9f7a96b/src/board.rs)
- [Fast-check and NNUE differential tests](https://github.com/deedy/chess-chatarunga/blob/4f389446c685e011bcc2550c682e26bdb9f7a96b/tests/search_nnue.rs)
- [Rules and random-playout invariants](https://github.com/deedy/chess-chatarunga/blob/4f389446c685e011bcc2550c682e26bdb9f7a96b/tests/rules.rs)

## What the headline result establishes

The reported approximately 3,533 rating is the author's extrapolation from
60 games at 150 ms per move: **Chatarunga Search v8 on four threads against
Stockfish 18 on one thread**, with 4 wins, 36 draws, and 20 losses. That is
a 36.7% score and 6.7% wins, with a reported implied rating interval of
approximately 3,533 +/- 45. The seven Stockfish wins showcased in the paper
come from a separate version-2.0 match, which scored 7/28/25, or 35%.

These are short-time author-run measurements, not an official CCRL rating
for Chatarunga or a calibration of Chessy. The hardware, thread counts,
opening set, and time control matter. Chessy's displayed bands remain
provisional; no rating gain is claimed by this refresh.

## r82 correctness work and dedicated regression checks

The refresh contains three independently checkable changes:

1. **Promotion after a flag fall:** stop a pending promotion choice from
   committing a move after the clock has ended the game; preserve the
   terminal result and saved state.
2. **WASM loader boundaries:** invalidate an old exact-root analysis phase
   before attempting new inputs, including inputs rejected before entering
   WASM; reject a nonzero reserved word in the ABI-v2 result record.
3. **Independent rules oracle:** compare the JavaScript rules engine with
   WASM fixed-search results on terminal and special-move positions, so a
   matching search signature alone cannot hide a shared result-contract bug.

`test/wasm-loader.test.js` passes 17 phase/ABI checks. The new
`test/wasm-search-oracle.test.js` passes 174 checks, including 164 independent
fixed-score cases (41 positions at depths 0–3), all legal roots on four
special-move positions, exact-budget boundaries, and repetition. Its oracle
uses JavaScript for rules/search and a separate WASM instance only for static
leaf evaluation; it is not an independent evaluator or strength measurement.
Promotion lifecycle regressions are in `test/browser/clocks.test.js`.
Both new Node suites are registered in CI. Full acceptance still requires
the existing release, engine, Chromium, and WebKit gates on the final PR head.
The production Rust/WASM bytes, evaluator, and search budgets are unchanged.

## Portable performance priorities

| Priority | Existing Chessy work | Reference lesson and admission requirement |
| --- | --- | --- |
| Quiet-check cost | [#183](https://github.com/den-run-ai/chessy/pull/183) | Avoid making quiet moves solely to detect checks. Compare any fast predicate against make/check/unmake, including discovered checks, en passant, castling, and promotions. Preserve move order and all fixed-node signatures. |
| Board hashing | [#184](https://github.com/den-run-ai/chessy/pull/184) | Maintain piece-square hash state instead of scanning all 64 squares repeatedly. Differentially check full recomputation after every make/unmake; preserve Chessy's legal-en-passant repetition normalization. |
| Small NNUE | [#187](https://github.com/den-run-ai/chessy/pull/187), [#105](https://github.com/den-run-ai/chessy/issues/105) | Validate score scale, quantization, incremental updates, and data provenance before a bounded strength experiment. Lower teacher loss does not establish stronger clock-limited play. |
| TT saturation | Separate candidate | Clustered bounded replacement may avoid the current full-table early stop, but changes search behavior. It needs explicit correctness, signature-rotation, runtime, and strength admission. |

Chatarunga's fast-check test compares its predicate with full move application
for every legal move across 100 seeded games of up to 80 plies. Its random
playout suite also checks incremental hashes against full recomputation.
These oracle comparisons are useful patterns for Chessy's existing research.

Its move picker returns an already computed quiet-history score to search.
Chessy should remove demonstrated duplicated work while retaining stable
tie ordering. The paper's reported throughput increase was bundled with
node-reducing search changes; it cannot be attributed to caching alone.

## NNUE and platform tradeoffs

Chatarunga embeds a **25,200,704-byte** network and uses native NEON/AVX2
kernels. Its headline configuration also uses Lazy SMP. Chessy's production
WASM has a 37,172-byte raw size ceiling and a 26,542,080-byte fixed memory
ceiling, with no SIMD, threads, allocator, or external runtime dependencies.
The reference network alone nearly fills that entire memory allowance,
before Chessy's existing TT and scratch state. A wholesale import therefore
does not fit the present offline/mobile contract.

The report records cases where wider or lower-loss networks lost on the
clock, and where training on one opening distribution improved that test
while regressing on balanced openings. Continue the small-network research
with independent data groups and declared budgets; verify scalar/quantized
agreement, both colors, special moves, and representative mobile throughput.

## Validation and release boundaries

- Reproduce each corrected failure and cover recovery, cancellation, and
  terminal-state preservation where they cross worker or UI boundaries.
- Preserve the pinned WASM bytes and accepted signatures for loader/UI-only
  work. Rebuild with pinned tools for any Rust change; use the documented
  signature-rotation mechanism for a deliberate search behavior change.
- Run the applicable engine/eval, release-coherence, Chromium, and WebKit
  checks. Preserve all existing deployment dependencies.
- Keep performance diagnostics separate from formal strength admission.
  Existing [#175](https://github.com/den-run-ai/chessy/issues/175) prerequisites
  and fresh-evidence policy still apply; do not reuse exposed openings as
  new independent evidence or revive rejected LMR/SEE/NMP patches unchanged.
- Record candidate/base identities, budgets, results, and negative outcomes
  before expanding an experiment. No paid training is part of this refresh.

## Reuse and attribution

Chatarunga is [MIT licensed](https://github.com/deedy/chess-chatarunga/blob/4f389446c685e011bcc2550c682e26bdb9f7a96b/LICENSE),
copyright Deedy Das, 2026. This review imports no code or network weights.
Any later substantial code reuse must retain its copyright and permission
notice; model and training-data provenance require their own review.
