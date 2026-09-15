# Expanded PeSTO pilot — September 2026

Follow-up: [independent reproduction and corrected interpretation](COMPACT-EVAL-AUDIT-2026-09.md).
The original loss results below reproduce exactly; the follow-up fixes research
runtime rounding and qualifies the label-admission and holdout-family claims.

## Decision

Keep the current evaluator and all five level budgets. No fitted weights or
neural network enter the game. Production WASM remains 37,172 raw / 17,690
Brotli-11 bytes, SHA-256
`57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f`.
The size figures are enforced separately from the asset checksum.

## What was tested

The [frozen pilot implementation](https://github.com/den-run-ai/chessy/tree/f769f87903cd8ee026a1aa2472f6e81a58514298)
is based on PR #146's `1e01c0b` and reuses its tested affine 965-feature
extractor. Its evaluator bytes match current main `8bf3191`.
12,000 deterministic legal continuations of the checked-in MIT/CC0 corpus
were labelled with external Stockfish 18 at 25,000 nodes, one thread, 16 MiB
hash, cleared before every position. Both embedded teacher networks were
exported and SHA-256 verified.

10,911 labels survived: 7,671 train / 1,619 validation / 1,621 test.
982 mate/missing-score cases and 107 bestmove/PV mismatches were excluded.
Labelling took 411 seconds locally. Modal spend: $0; GPU time: zero.

Original run SHA-256 identities (raw labels and weights are not published):

- Label summary: `2f8076471fb49cd57a87233b54d60a8b0e6406e4dcdfb28804d60550b2a0a57f`.
- Analysis summary: `566ee8e8c5f11b9a573cf33ebd0fe0ee33c024615198391c0a28269224fce5f7`.
- Labelled stream: `77db4b4b4c40b5bb4e14c67aaf98f3e36b590128bc9b02125028f9abe9a413ae`.

[Research notes and retained summaries](https://github.com/den-run-ai/chessy/tree/codex/pesto-synthetic-pilot-2026-09/eval/training)
live on a separate research branch; that branch is not a proposed runtime merge.

The convex objective is soft-WDL cross-entropy with positive L2 towards
shipped coefficients (new interactions towards zero). Mobility stays
nonnegative, passed-pawn ladders monotone, and all coefficients are bounded.
Baseline calibration uses train only; six positive lambdas are compared on
validation. Every surface chose lambda 0.02.

| Surface | Parameters | Validation CE | Test CE | Integer-weight, smooth-taper test CE |
| --- | ---: | ---: | ---: | ---: |
| Shipped PeSTO/HCE | 753 | 0.456182 | 0.440812 | 0.440812 |
| Existing-weight retune | 753 | 0.441914 | 0.428055 | 0.428104 |
| + direct pawn attacks | 759 | 0.435484 | 0.422338 | 0.422468 |
| + king-bucket pawn PSTs | 945 | 0.441276 | 0.427398 | 0.427355 |
| Both cheap groups | 951 | 0.435003 | 0.421530 | 0.421657 |
| Full R3 incl. safe mobility/cramp | 965 | 0.433983 | 0.420068 | 0.420036 |

These are exploratory teacher-transfer results, **not Elo**. Full R3 lowers
test CE by 4.71%, but N/B/Q mobility collapses to zero (all raw mobility in
full R3), pawn-structure/shield coefficients approach zero, and four direct
attack coefficients hit their 96 cp ceiling. This resembles the objective/
data mismatch in earlier rejected rounds. Full R3's extra traversal cost
has not been justified by playing-strength or wall-time evidence.

## Why it does not ship

Random legal continuations overrepresent tactically implausible, non-quiet
positions. Structural families are split-disjoint, but continuations of one
source seed can cross splits, and the seeds include existing evaluation
fixtures. Test loss cannot establish natural-game or production-scorecard
generalization. The labels are shallower than the 100k production teacher.
The final prospective match manifest was not used by the pilot. No fixed-node
or equal-time candidate match was dispatched; no Elo estimate was inferred.

H4/H8 are plausible next neural controls (~3.1/6.2 KB parameters before
quantization metadata/inference code). They were not trained here. H64/H128
would add roughly 49/99 KB of weights before code and are not appropriate
defaults against a 37 KB module. Prefer a weights-only convex control, then
cheap features, before introducing a search-local neural implementation.

## Prerequisites and review

- PR #146 remains draft/conflicted and was not merged. Its production NNUE
  admission still needs canonical selection/certification checks, the exact
  labelled/excluded partition, and an honest isolated-runner threat model.
  Its production source policy and static-FEN source-game lineage conflict
  must also be resolved before publishing a releasable model.
- #156: the old 100-opening × four inert seeds has only 100 opening clusters.
  The new [400-endpoint CC0 manifest](match-v2/PROVENANCE.md) is data-only
  groundwork. Trusted runner/aggregator/workflow integration remains open.
  No new candidate should use the old repeated-seed gate.
- The existing efficiency aggregator's result-ABI schema is repaired and
  tested against the real shard formatter. It requires the current ABI-v2
  candidate / ABI-v1 frozen reference contract and rejects missing, malformed
  or mismatched evidence. This repair does not rehabilitate the old repeated-
  seed strength gate or constitute the missing v2 execution protocol.
- #155: authenticated signature rotation remains required for intentional
  evaluator changes; historical r69 fixtures must not be overwritten.
- #84: minimum-device/offline/watchdog/memory/thermal evidence remains open.
  #87/#113 absolute Elo labels remain provisional; no recalibration is
  supported by this pilot.

Next useful experiment: pinned CC0 natural-game trajectories with source-game
and seed-family splits, quiet-position selection, stronger teacher labels,
and an untouched holdout. Freeze one finalist only after loss/tactics checks;
then measure fixed-node quality and product-budget wall-time/depth, size,
and the prospective 400-opening color-paired strength gate.

Data sources: [official Lichess CC0 exports](https://database.lichess.org/),
[CC0 opening catalog](https://github.com/lichess-org/chess-openings).
Stockfish is an external GPL build-time teacher, never bundled. Existing
PeSTO attribution remains; this work does not remove its provenance.
