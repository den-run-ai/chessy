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
| TT saturation | [#192](https://github.com/den-run-ai/chessy/pull/192) | The tested four-way replacement candidate passed 300 correctness checks but took 4.10% longer in its fixed-node screen, with mixed timed results. Preserve the negative evidence; do not activate it. |

Chatarunga's fast-check test compares its predicate with full move application
for every legal move across 100 seeded games of up to 80 plies. Its random
playout suite also checks incremental hashes against full recomputation.
These oracle comparisons are useful patterns for Chessy's existing research.

Its move picker returns an already computed quiet-history score to search.
Chessy should remove demonstrated duplicated work while retaining stable
tie ordering. The paper's reported throughput increase was bundled with
node-reducing search changes; it cannot be attributed to caching alone.

## Follow-up cost prototypes

After #191 merged, two separate prototypes were prepared against r82 at
`f65224dece688f23d00429c148715262dd3c9b79`. Each froze one implementation and
protocol before a single local CPU screen. Measurements ran sequentially;
local compilation and long-running tests were paused during both windows.
All positions are exposed development inputs; no holdout or formal match was
used. Complete sources, build logs, registrations and raw results are retained
with each experiment.

| Candidate | Measured change | 230k-node elapsed ratio (baseline/candidate) | Raw WASM | Decision |
| --- | --- | ---: | ---: | --- |
| [Compact hashing](compact-hash/README.md) | Thread two unchanged Zobrist streams as one value through searched edges | 1.090172 (8.27% less elapsed time) | 37,885 bytes, +713 | Fits the new download budgets; resource/device/admission checks remain |
| [Pawn-rank masks](pawn-ranks/README.md) | Replace repeated enemy-pawn scans with per-file rank masks | 1.012753 (1.26% less elapsed time) | 37,272 bytes, +100 | Small, uneven gain; longer diagnostic skipped under the frozen rule |

Both screens used 18 positions, three node budgets and four balanced pairs per
position/budget: 216 pairs per candidate. Every fixed-node search consumed its
declared node budget and every pair retained identical complete search output.
The summary first takes the median of each position's four elapsed ratios,
then the geometric mean across positions. These are descriptive development
statistics, not independent strength samples or proof on all positions.

Compact hashing also met its predeclared routing condition for four paired
eight-second searches on Ruy Lopez and Lucena. All four pairs kept the same
move and completed depth while searching more nodes. It is 474 raw bytes
smaller than #184's prototype and exceeded the historical 37,172-byte ceiling.
Two size-directed alternatives were retained; the 15-byte saving from an unchecked
private lookup was not selected over the checked implementation.

Pawn masks missed the 1.02 ratio threshold at 230k nodes and had an endgame
phase median of 0.984906, equivalent to about 1.53% longer elapsed time.
Consequently its conditional Master follow-up did not run. Neither its
small positive aggregate nor a faster result at 36k nodes waives that outcome.

The subsequently authorized download-budget policy allows **40 KiB raw
(40,960 bytes)** and **20 KiB Brotli-11 (20,480 bytes)**. Compact hashing's
37,885 raw / 17,937 compressed bytes and pawn masks' 37,272 raw /
17,739 compressed bytes fit those budgets. Compression in the local screens
used Node 24.22.3 / Brotli 1.2.1; the independent
[CI check](https://github.com/den-run-ai/chessy/actions/runs/45940247899/job/140312676492)
reproduced those sizes with the authoritative Node 22.23.2 / Brotli 1.1.0 encoder.
The archived protocols, experiment READMEs and size
verdicts (including `rawGatePassed: false`) describe the historical limits and remain
unchanged. The new size policy does not change the measured outcomes or
authorize either candidate's activation.

CI rebuilds the candidates with pinned tools, checks the exact measured module
hashes, and repeats correctness and evidence checks. It does not rerun timing.
The [separate admission proposal](SEARCH-COST-ADMISSION-PROPOSAL.md) supplies
reviewable local invariants and an evidence plan for the pure-cost policy gap
in #175/#84. It changes no active policy, signature pointer, resource ceiling,
formal registry or production code. Authentic phone measurements and a
reviewed admission mechanism remain outstanding.

## NNUE and platform tradeoffs

Chatarunga embeds a **25,200,704-byte** network and uses native NEON/AVX2
kernels. Its headline configuration also uses Lazy SMP. Chessy's production
WASM now has a 40,960-byte raw download budget and an unchanged 26,542,080-byte
fixed memory ceiling, with no SIMD, threads, allocator, or external runtime
dependencies.
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
