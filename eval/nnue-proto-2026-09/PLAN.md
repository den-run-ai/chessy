# NNUE prototype plan — 2026-09-15 (preregistered before measurement)

Research prototype for #105: can a pure 768→H→1 network, trained on millions
of teacher-labelled positions, beat the shipped tapered HCE at equal time
inside the same Rust/WASM search? Nothing here changes the shipped app; every
number is development evidence, not a formal admission (#175) and not an Elo
certification (#87/#113). This file was written before any net was trained
on the final dataset and before any match was played.

## Why this differs from the earlier attempts

| Earlier attempt | Rows | Model | Cost path | Outcome |
| --- | ---: | --- | --- | --- |
| Convex HCE rounds 1–2, PeSTO pilot | 13k–51k | re-weighted HCE terms | none | no transfer / pathological weights |
| Natural pilot | 33k | constrained HCE retune | −1…−4% NPS | 42.5% @50 ms, 58.8% @200 ms, CIs include 50% |
| H4/H8 residual, hybrid | 33k | 4–8 hidden units *on top of* HCE | −6…−18% NPS | 3.5% better teacher loss, 41.5% @20 ms |

The binding constraints were data scale (tens of thousands of rows), a
residual design that still paid for HCE at every leaf, and eager accumulator
updates inside legality probes. This prototype changes all three: ~20M rows,
a pure net that replaces HCE, and a per-ply accumulator updated only on
searched edges. If it still loses, that is a real negative for the
768→H family at this engine's budgets.

## Data (frozen)

- Source: CC0 Lichess evaluations, Hugging Face parquet shards `data_0000` and
  `data_0001` (SHA-256 in the dataset manifest). Labels are Lichess
  exploration evaluations (mixed Stockfish builds and depths), which
  `eval/training/DATASETS.md` allows for candidate screening but not for a
  certification fit.
- Selection per FEN: deepest session, best line; depth ≥ 15; quiet (not in
  check, legal best move that is neither capture, en passant, nor promotion);
  mate → ±3000 cp; cp clamped ±3000.
- Quarantine: the natural-pilot boundary (scorecard corpus, puzzle sources,
  both incident fixtures, the 100-opening v1 bank, every prefix of the
  400-endpoint v2 formal holdout) plus every prefix position of the new
  development opening bank, matched by exact/model-symmetry cluster and by
  static pawn/king/material family with the repository's own key functions.
- Split: SHA-256 of the four-field FEN, 95/2.5/2.5. The export has no game
  lineage, so transpositions can straddle splits: validation loss is
  optimistic and playing strength is the decisive measurement.
- Raw shards and packed arrays stay outside Git; only scripts, manifests and
  weight-free summaries are committed.

## Models (frozen)

- 768→H→1, H ∈ {16, 32, 64, 128}; two perspectives sharing W1; SCReLU;
  side-to-move block first; output = side-to-move expected-score logit with
  SCALE 400 (`sigmoid(out) ≈ P(win)`, `400·out ≈ cp`).
- Identical recipe for every H: AdamW lr 1e-3, cosine to 1e-5, 10 epochs,
  batch 16384, seed 10601, loss MSE(sigmoid(out), sigmoid(cp_stm/400)),
  weight clip ±1.98 so the i16 accumulator cannot overflow.
- Quantisation: W1/b1 i16 at QA=255, W2 i16 at QB=64, b2 i32 at QA·QB;
  integer inference in i64 with truncating division. The exporter's integer
  model produces goldens that the Rust test reproduces exactly.
- Variants: net-only for every H; net + shipped lone-king mop-up term
  (`nnue-mopup`) built for the width selected by rule R1 below.

## Runtime (frozen)

- Cargo feature `nnue` in `experiments/wasm`; the default build must stay
  byte-identical to `assets/chessy-ai-fast.wasm` (verified by `cmp`).
- Weights embedded with `include_bytes!`; per-ply accumulator stack
  `[130][2][H] i16`; `push` only after a legal searched child, `refresh` at
  search roots. Research builds raise the memory ceiling (production is 405
  pages); the page count and module size are reported, never hidden.
- Cost: paired NPS at 16,384 nodes on the 18-position mirrored corpus,
  8 alternating repetitions, median ratio (`tools/nnue/bench.js`).

## Strength measurement (frozen)

- Opponent: the shipped module `assets/chessy-ai-fast.wasm` (r79 HCE).
- Bank: `dev-openings.json`, 292 CC0 catalog lines (6–12 plies, |HCE static|
  ≤ 120 cp), disjoint from the frozen quarantine boundary and quarantined
  from training. Both colours per opening: 584 games per configuration.
  The 400-endpoint v2 manifest is never searched.
- Budgets: fixed 10,000 nodes (Easy profile) and 36,000 nodes (Medium) for
  all four widths; equal time 50 ms/move for all four widths with two
  concurrent workers; equal time 200 ms/move for the R1 width and its mop-up
  variant. Ply cap 180; unfinished games are draws and counted separately.
- Statistics: opening-clustered mean, two-sided 95% t interval, the
  repository's one-sided 95% lower bound, and an Elo point estimate with the
  interval mapped through the logistic formula. No pentanomial model.
- R1 (width selection for the extra variants): highest 10k-node dev-bank
  score; ties go to the smaller width. This rule selects only which extra
  runs are executed; every executed run is reported.
- Lone-king conversion diagnostic (`tools/nnue/mate-conversion.js`) for each
  net at 36,000 nodes; the shipped HCE converts 5 of 8 cases.
- Offline teacher loss of shipped HCE versus each net on the validation and
  test rows with a fitted scale per evaluator.

## What is not claimed

- No production integration, release bump, level recalibration, or README
  strength claim. No formal admission (#175), no device evidence (#84).
- Development matches on exposed openings are not Elo; 584 games resolve
  roughly ±4 percentage points.
- Lichess labels are exploration-grade; a shipping candidate would need the
  pinned Stockfish 18 teacher path in `eval/training/README.md`.
- No run is retried, extended, or dropped because of its score. An
  infrastructure failure is reported with its evidence and rerun once.

## Compute

Everything runs in the 4-CPU sandbox; no Modal or GPU is used.

## Addendum A — registered after the H16 and H32 fixed-node results

Observed before writing this addendum: H16 43.5% and H32 43.8% at 10,000
nodes (both ≈ −45 Elo) although H32's offline loss is clearly lower. That
pattern suggests the label source, not capacity, limits play: Lichess labels
are deep (depth ≥ 15, often 40+) evaluations of human-game positions, while
a leaf evaluator inside a depth-5 search is most useful when it approximates
what a shallow search can verify.

Diagnostic D1 (HCE student): train the same 768→32 recipe on the shipped
HCE's own static White-POV evaluation of the same training positions
(labels via `evaluate_loaded`, target sigmoid(cp/400)), then play it at
10,000 and 36,000 nodes on the dev bank. Interpretation rule, fixed now:

- if the student scores within the 95% interval of 50%, the architecture can
  represent an evaluation that plays like HCE and the deficit of the
  Lichess-trained nets is a label/distribution effect;
- if the student also loses by a similar margin, the 768→H family at these
  widths cannot represent the mobility/pawn/king terms well enough, and no
  relabelling will rescue it.

D1 uses no new positions, no holdout, and the same seed/epochs/batch; it is
executed after the H64 and H128 runs so it does not disturb their timing.
