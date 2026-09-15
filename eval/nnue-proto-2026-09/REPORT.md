# NNUE prototype: pure 768→H nets versus the shipped HCE — 2026-09-15

**Result: at equal time the best nets reach parity with the shipped tapered
HCE, not a demonstrated improvement.** In 584-game development matches at
50 ms per move, H64 scored 51.6% (95% interval 47.7–55.5%) and H128 51.2%
(47.3–55.1%); at 200 ms per move H128 scored 49.8% (46.1–53.5%). At equal
nodes H128 is clearly stronger (58.6% at 10,000 nodes, one-sided lower bound
55.5%), but its scalar inference costs about 30% of throughput and that
cancels the gain. H16 and H32 lose about 50 Elo under
every budget. **Nothing ships**: the production module, release token, level
budgets and formal holdout are untouched. Every number here is development
evidence on exposed openings, not a formal admission (#175) and not an Elo
certification (#87/#113).

The [preregistered plan](PLAN.md) was committed before any net was trained
on the final dataset; its addenda A–C were registered before the runs they
describe. Machine-readable evidence, weight-free, is in
[`results.json`](results.json); the development opening bank is
[`dev-openings.json`](dev-openings.json). Weights, datasets and per-game
records stay outside Git.

## Is the evaluation data/setup good?

The owner asked for this to be confirmed before anything else. Findings:

| Aspect | Before this prototype | What this prototype used | Still open |
| --- | --- | --- | --- |
| Correctness gates | Strong: scorecards, perft, PV replay, signature fixtures, byte-reproducible build | Reused unchanged; the default build is byte-identical after the source changes | – |
| Training data | 12k–51k positions in every earlier evaluator study; residual nets on 33k rows | 20.4M quiet positions from two CC0 Lichess evaluation shards, family-disjoint from every quarantine input and from the new opening bank | Labels are exploration-grade Lichess evaluations (mixed Stockfish builds, depth ≥ 15); no game lineage, so transpositions can straddle splits |
| Strength screen | 100 exposed openings (200 games, about ±6 points); 20 ms per move, where the engine's 1,024-node clock check is ~10% of the budget | 292-line CC0 dev bank disjoint from the frozen boundary (584 games, about ±4 points); ≥ 50 ms per move; identical completed depth verified per side | Still development evidence; the 400-endpoint formal holdout is untouched and #175's estimator is unfinished |
| Cost measurement | Fused per-leaf refresh (−1 NPS point per hidden unit) or eager accumulators inside legality probes | Per-ply accumulator updated only on searched edges; paired NPS benches; in-match NPS ratios | Sandbox Node timings, not device timings (#84) |
| Offline metric | Teacher cross-entropy on 2,374 rows | Same metric on 511k rows plus a fitted-scale comparison with the HCE | The offline metric does not predict play (below); it screens, it does not decide |

Verdict: the correctness side of the evaluation setup is sound and was
reused as is. The strength-measurement side was under-powered and the data
side was two to three orders of magnitude too small to test the NNUE
hypothesis; both were fixed here at development grade. The remaining gaps
are the ones the repository already tracks: a pinned certification teacher,
formal family-clustered admission, and physical-device timing.

## What was built

- `tools/nnue/nnue.rs` plus `tools/nnue/engine-nnue.patch`: a 768→H
  two-perspective SCReLU evaluator behind the Cargo feature `nnue` (plus
  `nnue-mopup`), weights embedded with `include_bytes!`, a per-ply
  `[130][2][H] i16` accumulator stack pushed only after a legal searched
  child and refreshed at every search root, and the
  `static_eval`/`eval_push`/`eval_refresh` shims in `search.rs`/`lib.rs`.
  The production crate under `experiments/wasm` is not modified: the
  release gate's engine-signature verifier rejects any source change there
  without a reviewed rotation, so `tools/nnue/prepare-crate.sh` applies the
  patch to a copy (the repository's established research-runtime pattern).
  With the feature off, the patched copy reproduces
  `assets/chessy-ai-fast.wasm` byte for byte (verified after every change).
  Tests in the patched copy: incremental equals refresh over random playouts
  covering promotions, castling and en passant; colour-mirror antisymmetry;
  exporter goldens; and an in-search assertion that every evaluated slot
  equals a fresh rebuild through `run()`, `run_fixed()` and
  `analyse_root()`.
- `tools/nnue/`: dataset builder (deepest session, best line, depth ≥ 15,
  quiet filter, quarantine through the repository's own cluster/family key
  functions, SHA-256 hash split), PyTorch trainer/exporter with an exact
  integer reference, research build script, paired NPS bench, mate-conversion
  diagnostic, dev-bank match runner with opening-clustered statistics,
  offline loss comparison, HCE and shallow-search relabel tools, summariser.

## Data

- Source: `Lichess/chess-position-evaluations` parquet shards `data_0000`
  (SHA-256 `c004ce90acd8…`, 54,372,489 rows) and `data_0001`
  (`f913b7e17f00…`, 52,196,762 rows); CC0.
- 106,569,251 rows → 30,366,771 unique FENs → 20,444,722 kept after: depth
  < 15 (495,621), in check (2,495,266), best move a capture/promotion
  (6,371,637), malformed (234,539), quarantined by exact/symmetry cluster
  (3,486) or structural family (258,267) against the natural-pilot boundary
  (2,179 clusters, 1,085 families: scorecard corpus, puzzle sources, both
  incident fixtures, the 100-opening v1 bank, every prefix of the 400-endpoint
  v2 holdout), and by the dev bank's own prefixes (650 clusters, 62,583
  families).
- Split by SHA-256 of the four-field FEN: 19,422,291 train / 511,525
  validation / 510,906 test. Train phases: 9.60M opening, 4.70M middlegame,
  5.12M endgame. 12.7% of labels are mates (mapped to ±3000 cp); 52.2% white
  to move.
- The dev bank: 292 lines (6–12 plies, |HCE static| ≤ 120 cp) from the CC0
  `lichess-org/chess-openings` catalog retrieved 2026-09-15; 199 catalog
  lines were rejected for touching a quarantined cluster and 109 for sharing
  a v2 endpoint family.

## Models

Identical recipe for every width: AdamW 1e-3 with cosine decay, 10 epochs,
batch 16,384, seed 10601, MSE between sigmoid(out) and sigmoid(cp_stm/400),
weights clipped to ±1.98; quantised to i16 at QA=255/QB=64 with the output
bias at QA·QB.

| Net | Params (bytes) | Val MSE (float) | Val MSE (quantised) | Test MSE (quantised) | Val cp MAE | Quantisation cp MAE / max | Accumulator bound (of 32,767) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| H16 | 24,676 | 0.01607 | 0.01609 | 0.01623 | 142.4 | 6.96 / 43 | 6,155 |
| H32 | 49,348 | 0.01478 | 0.01481 | 0.01494 | 137.2 | 7.13 / 40 | 6,270 |
| H64 | 98,692 | 0.01384 | 0.01385 | 0.01399 | 132.1 | 5.80 / 36 | 6,431 |
| H128 | 197,380 | 0.01296 | 0.01297 | 0.01307 | 128.5 | 5.33 / 45 | 6,369 |

H128's training process was killed by the sandbox memory limit during the
export step after its tenth epoch (the full-set integer check gathered a
17 GB intermediate); the checkpoint was re-exported with a batched evaluator
and the weight file is byte-identical to the one the killed process had
already written. Every exported net reproduces its 256 goldens both in the
Rust test suite and through the production loader's `evaluate` path.

## Offline loss does not predict play

Expected-score MSE on the validation/test rows, with a scale fitted per
evaluator on validation (so the HCE's centipawn scale is not penalised):

| Evaluator | fitted k | validation | test | val opening | val middlegame | val endgame |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| shipped HCE | 1.14 | 0.02413 | 0.02438 | 0.01543 | 0.03237 | 0.03291 |
| H16 | 1.00 | 0.01609 | 0.01623 | 0.00810 | 0.02177 | 0.02589 |
| H32 | 1.00 | 0.01481 | 0.01494 | 0.00728 | 0.01984 | 0.02433 |
| H64 | 1.00 | 0.01385 | 0.01399 | 0.00662 | 0.01864 | 0.02306 |
| H128 | 1.00 | 0.01297 | 0.01307 | 0.00607 | 0.01739 | 0.02186 |
| constant predictor | – | 0.05328 | 0.05333 | | | |

H16 already predicts the Lichess labels 33% better than the HCE and still
loses about 50 Elo. The repository's earlier observation that teacher-loss
gains do not translate into play holds at this scale too; only the width-64
and width-128 nets convert their offline advantage into play, and only at
equal nodes.

## Runtime cost

| Module | Pages | Raw bytes | Brotli bytes | Paired NPS ratio, 16k nodes, median (p25–p75) | In-match NPS ratio (10k / 50 ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| shipped HCE | 405 | 37,172 | 17,690 | 1 | 1 |
| H16 | 407 | 58,636 | 28,613 | 1.120 (1.017–1.489) | 1.28 / 1.28 |
| H32 | 408 | 82,388 | 42,107 | 1.029 (0.889–1.323) | 1.15 / 1.13 |
| H64 | 409 | 131,556 | 66,725 | 0.850 (0.770–1.076) | 0.96 / 0.93 |
| H128 | 411 | 230,245 | 111,466 | 0.643 (0.560–0.799) | 0.73 / 0.70 |
| H128 + mop-up | 411 | 230,393 | 110,617 | 0.618 (0.544–0.780) | 0.72 / – |

The bench corpus is endgame-heavy, where the HCE is cheapest, so it reports
lower ratios than the games do. Research modules need 2–6 extra 64 KiB
memory pages beyond the production 405-page ceiling (weights plus the
accumulator stack); the production limits are unchanged. H64 and H128
exceed the 37,172/17,690-byte size ratchet by 3.5× and 6×; a shipping
decision would have to admit that explicitly.

## Strength: development matches against the shipped HCE

Dev bank, both colours, 584 games per row, 180-ply cap, opening-clustered
two-sided 95% intervals, Elo by the logistic formula. Completed depth was
identical for candidate and base in every fixed-node run (3.4 plies at 10k,
4.3 at 36k), so differences are evaluation quality, not tree efficiency.

| Net | 10,000 nodes | 36,000 nodes | 50 ms / move | 200 ms / move |
| --- | --- | --- | --- | --- |
| H16 | 43.5% (39.6–47.4), −46 Elo | 42.2% (38.5–45.9), −55 | 42.4% (38.5–46.2), −53 | – |
| H32 | 43.8% (40.0–47.6), −43 | 38.6% (35.0–42.3), −81 | 42.6% (38.9–46.4), −52 | – |
| H64 | 52.6% (48.9–56.2), +18 | 51.5% (47.8–55.3), +11 | 51.6% (47.7–55.5), +11 | – |
| H128 | **58.6% (54.9–62.4), +61** | 52.7% (49.0–56.5), +19 | 51.2% (47.3–55.1), +8 | 49.8% (46.1–53.5), −1 |
| H128 + mop-up | 58.6% (54.9–62.4), +61 | 52.9% (49.1–56.7), +20 | – | pending |

Reading: width matters (H16 ≈ H32 < H64 < H128 at equal nodes); the nets'
edge shrinks as the search deepens (H128: +61 at 10k, +19 at 36k); and the
scalar inference cost converts H128's fixed-node lead into equal-time
parity. The product's Hard and Master levels search far deeper than either
screen budget, so the trend is the more important number.

The mop-up variant (rule R1 selected H128) is indistinguishable from
net-only at both fixed budgets: the term is at most 76 cp against outputs
near ±1700 cp in the positions where it applies. Its paired NPS bench is
0.618 (0.544–0.780).

At 200 ms per move H128 reaches mean completed depth 5.50 against the HCE's
5.86 and scores 49.8% (251–80–253): the 30% throughput deficit costs about a
third of a ply and the evaluation gain buys it back, no more.

Pending at the time of writing and added below when complete: H128+mop-up
at 200 ms per move, and diagnostic D3 (H128 at the Hard profile's 230,000
nodes on half the bank).

## Diagnostics

**D1, HCE student (Addendum A).** The same 768→32 recipe trained on the
shipped HCE's own static evaluations of the same positions reproduces the
HCE to a mean error of 8 cp (quantised validation MSE 4e-5). It still
scores 45.5% (42.3–48.6) at 10,000 nodes and 47.0% (43.8–50.2) at 36,000,
with a draw rate twice that of the other runs. By the registered rule the
width-32 family cannot reproduce the HCE closely enough for search even at
that static error: the residual errors are concentrated where search
decisions are made. D2 (shallow-search distillation, Addendum B) was
therefore skipped by rule.

**Lone-king conversion** (attacker at 36,000 nodes, 200 plies, defender is
the shipped HCE):

| Evaluator | Converted | KQK | KRK | KBBK | KBNK | KPK | KQK (black) | KRK (black) | KRR v KR |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| shipped HCE | 5/8 | 15 | 29 | 57 | – | – | 15 | – | 11 |
| H16 | 5/8 | 13 | 27 | – | – | – | 15 | 27 | 11 |
| H32 | 6/8 | 23 | 27 | 47 | – | – | 17 | 27 | 11 |
| H64 | 6/8 | 33 | 25 | 69 | – | – | 21 | 33 | 11 |
| H128 | 4/8 | 41 | – | – | – | – | 41 | 95 | 11 |
| H128 + mop-up | 4/8 | 29 | 91 | – | – | – | 23 | – | 11 |
| D1 student | 4/8 | 19 | – | 47 | – | – | 19 | – | 13 |

Numbers are plies to mate; “–” is a fifty-move, stalemate or
insufficient-material draw (the HCE stalemates the won KPK and fails KRK as
Black at this budget too). H128 fails or nearly fails KR vs K, and the
shipped mop-up term (at most 76 cp) does not fix it because the net already
sits near its ±1700 cp plateau in these positions. A shipping candidate would need an endgame term
scaled to the net's output, or endgame-specific training data.

## Why this differs from the earlier attempts, and what it implies

- Data scale and a pure (non-residual) net removed the two structural
  limits of the H4/H8 studies: the nets no longer pay for the HCE at every
  leaf, and the 20M-row corpus is large enough that width, not data, is the
  binding constraint up to H128.
- The equal-time outcome is now a throughput question. H128 gains about
  60 Elo at equal nodes and loses it all to a 30% NPS deficit in scalar
  WASM. The obvious lever is `simd128` inference, which #105 already names
  as a separately feature-detected follow-up; the production build is scalar
  by policy and a SIMD build needs its own browser and device evidence.
- The edge shrinks with depth, so any future measurement must include the
  product budgets (230k nodes and the 5-second Master search), not only the
  screening budgets used here.
- Lichess labels reach a plateau in usefulness: better offline loss did not
  buy play at H16/H32. The pinned Stockfish teacher path in
  `eval/training/README.md`, or shallow-search self-labels, remain the
  certification-grade options; D1 shows that a net can imitate a static
  evaluator closely without matching it in search, so play must be measured
  directly whatever the labels.

## Execution notes

- The H16 candidate run was repeated once after a bug in the runner's
  opening-replay sanity check (python-chess omits the en-passant square
  unless a capture is legal; Chessy prints it after every double push); the
  first attempt played no games.
- The log line `CANDIDATE_FAILED h128-mopup` is an artifact: the running
  shell re-read `run-candidate.sh` after it had been edited for the
  copied-crate layout and reported a syntax error after every output of
  that run had already been written; all its results are complete.
- The equal-time stage ran alone on the CPU; fixed-node runs overlapped
  with training, which is harmless for node-limited searches.

## Reproduction

```sh
# data (raw shards outside Git; ~2.1 GB each)
python3 tools/nnue/build-dataset.py --shard data_0000.parquet --shard data_0001.parquet --output ds
python3 tools/nnue/filter-dataset.py --dataset ds --extra-quarantine eval/nnue-proto-2026-09/dev-openings.json --output dsq
# nets
python3 tools/nnue/train.py --dataset dsq/dataset.npz --hidden 64 --epochs 10 --batch 16384 --lr 1e-3 --seed 10601 --out nets/h64
# patched research copy of the engine crate (experiments/wasm stays untouched)
tools/nnue/prepare-crate.sh /tmp/chessy-nnue-crate
# candidate module (pinned Rust 1.97.1 + Binaryen 131), tests, goldens, matches
CHESSY_WASM_OPT_BIN=…/wasm-opt tools/nnue/run-candidate.sh 64
node tools/nnue/match.js --base assets/chessy-ai-fast.wasm --candidate nets/h64.wasm \
  --openings eval/nnue-proto-2026-09/dev-openings.json --time-ms 50 --workers 2 --out matches/h64-t50.json
python3 tools/nnue/summarize.py --out eval/nnue-proto-2026-09/results.json
```

## What is not claimed

No production integration, release bump, level recalibration or README
strength claim. No formal admission under #175, no device evidence under
#84, no certification-grade labels. Development matches on exposed openings
are not Elo. The 400-endpoint formal holdout was never searched. Everything
ran in a 4-CPU sandbox; no Modal or GPU time was used.
