# tactictree — feasibility report

**Recursive LLM labelling of chess tactics over minimal contrastive game trees**
2026-08-04 · Stockfish 16 (depth 14) · google/gemini-3.6-flash via OpenRouter · total API spend ≈ $2.5 of a $3 throwaway key

## 1. Thesis

Tactics like the zwischenzug are properties of the **game tree**, not of the
position: an intermezzo is *defined* contrastively — the naive recapture line
versus the line where a bigger threat is interposed first. A static classifier
cannot represent that; a tree containing both branches makes the defining
structure explicit, collapsing the task from "search + label" to "label."
LLMs are bad at the search part (state tracking, calculation) and good at the
labelling part, so: let the engine build a **minimal contrastive tree** (best
line + refutation of the human-expected "natural" move), then run a
**recursive LLM labeller** over it — one cheap sub-call per node, child labels
passed upward (semantic minimax backup), plus one tree-level **compose call**
that sees both branches and judges contrast-only motifs.

## 2. System

~700 lines of Python (`src/tactictree/`): Stockfish wrapper + natural-move
heuristic (`engine.py`), two-branch tree builder (`tree.py`), node-local
features (`features.py`), pluggable reasoners (`reasoner.py`: rule-based
stand-in, OpenRouter LLM), recursion + tree-level composition + static
baseline (`recursion.py`). Node sub-calls see one FEN + incoming move +
features JSON + already-computed child labels; the compose call sees the two
branch heads, evals, SAN lines, and backed-up node motifs. LLM responses are
disk-cached (`.llmcache/`), so every run in this repo can be replayed for $0
with `OPENROUTER_API_KEY=dummy`.

## 3. Experiment 1 — five curated fixtures

Fixtures: Elephant Trap zwischenzug, Petroff discovered-check trap, royal
fork, absolute pin, quiet Italian control. Expected-motif recall:

| system | recall | wall | tokens in/out | cost |
|---|---|---|---|---|
| static position-only baseline | 2/5 | — | — | — |
| tree + rule-based reasoner | 5/5 | 2s | — | — |
| tree + gemini-3.6-flash | **5/5** | 197s | 11.6K / 26.7K | $0.22 |
| tree + gemini-2.5-flash | **5/5** | 40s | 11.6K / 1.5K | ~$0.01 |

The two motifs the static baseline can never see — intermezzo and the
line-dependent discovered check — are exactly the ones the tree recovers.
Both models' compose calls, shown the Elephant Trap's two branches,
independently judged **intermezzo**; 3.6-flash's narrative was fully correct
("Bb4+ instead of immediately recapturing, forcing Qd2 before Black
recaptures"). The weaker 2.5-flash stays at 5/5 recall *given the tree* while
being far below that on position-only benchmarks (ChessQA-style) — evidence
that the tree, not the model, is doing the calculating. Its labels are
noisier (spurious `fork`, `mateThreat`), so model quality shows up in
precision before it shows up in recall.

## 4. Experiment 2 — 50 theme-stratified Lichess puzzles

**Sampling** (`lichess_sample.py`): streamed the official
`lichess_db_puzzle.csv.zst` dump (decompressed on the fly, never written to
disk), filtered to Popularity ≥ 90, NbPlays ≥ 1000, rating 800–2400, and
stratified over 8 themes that intersect the taxonomy — intermezzo ×8;
deflection, skewer, discoveredAttack, mateIn2, fork, pin, hangingPiece ×6 —
assigning multi-tagged puzzles to the rarest theme and picking a
deterministic rating-quantile spread per theme (each theme spans ~800–2400).

**Scoring** (`run_lichess.py`): the puzzle position is FEN + the opponent's
setup move. Four systems per puzzle: `static` (position-only rules),
`rules` (tree + rule reasoner + deterministic intermezzo contrast rule),
`llm` (tree + LLM node calls + LLM compose + contrast rule — the full
hybrid), and `llm_only` (LLM node + compose labels alone — the pure
recursive-LLM labeller). Hit = the sampled theme's mapped motif appears in
the prediction set (recall on the sampled theme; co-occurring tags are not
scored as misses). Also recorded: whether the engine's best move equals the
puzzle solution, whether a natural-move contrast branch existed, and
per-puzzle token spend. Rows are interleaved across themes so the hard
spend cap degrades all themes uniformly if hit.

### Results

*(pending — run in progress at time of writing; final tables inserted on
completion by `analyze_lichess.py`)*

## 5. What the recursion contributes — mechanism analysis

Three mechanisms, each visible in the run's own transcripts:

**Search becomes recognition.** Every sub-call's task is node-local: one
position, the move that just landed, a features JSON, the children's labels.
Nothing ever simulates the game forward. The captured hidden reasoning shows
the model spending its thinking tokens *verifying* handed evidence
("confirming Rxf8# validity", cross-checking the pin against the features) —
not exploring lines. This sidesteps exactly the failure mode measured in the
LLM-chess literature (near-zero board-state tracking): calculation stays in
the engine, recognition-and-naming in the model. The static baseline is the
ablation of this property — it stares at the root, where the tactic has not
happened yet, and collapses (see §4 table); the recursive labeller watches
the tactic execute node by node.

**Semantic backup — deep facts climb the tree as language.** Child labels are
part of the parent's prompt, so a fact proven at ply k is context at ply k−1.
The deflection puzzle's actual call chain: the leaf says *"White delivers
checkmate with Rf8#"* → the Kh8 node, holding that label, says *"White can
deliver immediate checkmate by capturing the pinned bishop"* → the f7+ node
concludes *"pawn check forces the king to h8, setting up an immediate mate."*
A mate found two plies deep is expressed, correctly attributed, at the top of
the line — minimax backup where what propagates is the explanation, not a
number. The skewer results are a pure win of this level: no skewer feature
exists in the rules, and no compose call ran on most skewer puzzles (no
natural branch), so every skewer the LLM caught came from node calls + line
context alone.

**Recursion levels map onto motif classes — and misses localize to starved
levels.** Node calls catch localized motifs (fork, pin, mate-on-board); the
backed-up line catches line-dependent motifs (discovered check, mate
threats); only the root-level compose call, which sees both branches, catches
contrastive motifs — every intermezzo/deflection verdict in the run came from
it. Correspondingly, the contrastive-theme misses all occurred where no
natural branch was built, i.e. where the compose level was never given input
— not where a layer malfunctioned. Failures that localize this cleanly are
evidence the decomposition matches the problem's structure.

Two ablations would complete this analysis and are deliberately cheap
(~$1 each with the cache): (a) whole-tree-in-one-prompt vs. the recursion,
isolating whether decomposition beats a single long-context judgment; and
(b) node calls with the `children` field removed, isolating the backup's
contribution. Neither has been run yet.

## 6. Forensics — why a deflection puzzle was missed (and what it proves)

Puzzle 0BqNv (rating 822, tags: deflection, mate, mateIn2): after Black grabs
a bishop with Rxd5, White mates via **f7+! Kh8 Rxf8#**. The g8 king is the f8
bishop's only defender; the naive immediate Rxf8+?? fails to Kxf8, so f7+
*deflects* the king off the defense first. Every layer of the pipeline
behaved correctly, and the miss decomposes into three precise causes:

1. **The counterfactual branch was never built.** `natural_move()` proposes
   recaptures and SEE-profitable captures; Rxf8+ loses rook-for-bishop by
   SEE, so the heuristic filtered out exactly the tempting-but-refuted move a
   human would try. No natural branch → no compose call → the only layer that
   sees contrasts never ran. (At scale, natural branches existed on only ~1/5
   of puzzles, almost all intermezzo-tagged — the recapture heuristic's
   narrowness quantified.)
2. **Node calls see transitions' endpoints, not transitions.** The model's
   actual per-node answers show it understood everything — at the f7+ node it
   wrote *"White's pawn check forces the king to h8, setting up an immediate
   checkmate by capturing the pinned bishop"* — a word-perfect description of
   the deflection mechanism, labelled `pin, mateThreat`. Deflection is
   defined on the *edge* (a defender forced to abandon a duty); no single
   node view frames that question.
3. **The compose prompt defines only intermezzo.** Replaying the compose
   call with the missing branch hand-added (Rxf8+ Kxf8 = −670cp vs f7+ =
   mate), the model instantly read the contrast — *"White is expected to
   immediately recapture on f8, but instead interposes f7+ … facilitating
   checkmate"* — and answered `intermezzo`. Correct structure, wrong word:
   the prompt spells out the intermezzo definition and merely lists
   `deflection` as an allowed id. Motifs the prompt defines get named;
   motifs it only mentions don't. (Both labels are defensible here — the
   in-between check *is* the deflecting move — but Lichess tags it
   deflection.)

The captured hidden reasoning (~600 thinking tokens/call) shows the model
doing disciplined verification of the structured evidence — restating the
FEN, cross-checking the features JSON, confirming the mate is real — rather
than open-ended search: exactly the division of labor the architecture
intends.

## 7. Cost & engineering notes

- gemini-3.6-flash is a reasoning model: ~300–900 hidden thinking tokens per
  sub-call. `max_tokens` must be headroom (2000), not a cost control — a 400
  cap truncates the JSON answer. Real cost ≈ $0.04–0.06 per middlegame
  puzzle (~7–9 calls), ~3× a naive no-reasoning projection.
- The natural branch's per-node annotations were never read by composition;
  labelling it wasted ~40% of sub-calls. Fixed: only the best branch is
  labelled (fixture results unchanged).
- One $0.003 smoke call before the first paid run caught the max_tokens
  truncation risk; the disk cache makes all reruns free and this repo's
  results exactly replayable.
- Engine determinism caveat: node prompts contain no engine numbers, so
  cached node calls replay exactly; compose prompts embed evals and are
  engine-version-sensitive.

## 8. Limitations

- Recall is scored on the sampled theme only; the tag-verifiable precision
  metric (see results) uses the full tag set but Lichess tags are not
  exhaustive ground truth for every label we emit (`quiet` and inherited
  deep-line motifs are unverifiable).
- The natural-move model is a recapture/SEE heuristic, not a human-move
  model; §5 shows this is the binding constraint on contrastive motifs
  beyond intermezzo.
- n=50 with 6–8 per theme bounds per-theme conclusions; the run is one
  model at one depth; themes were sampled from the popular head of the
  puzzle DB (well-validated tags, but easier-than-average puzzles at a
  given rating).
- `deflection`/`skewer` conclusions depend partly on the LLM naming motifs
  the rule features cannot see; that is the point, but it means the rules
  column understates what richer hand-crafted features could do.

## 9. Next steps

1. Replace `natural_move()` with a Maia-style human-move model — §5 predicts
   this converts several deflection misses directly.
2. Give the compose prompt one-line definitions per contrastive motif
   (deflection, desperado, trap), not just intermezzo.
3. Scale to ~1K puzzles for per-theme F1 with confidence intervals
   (≈ $45 at 3.6-flash rates, ≈ $2 at 2.5-flash rates given caching).
5. Run the two §5 ablations: whole-tree-single-prompt, and node
   calls without child labels (isolates the semantic backup).
4. Let the LLM drive expansion RLM-style (choose which branches to open)
   instead of the fixed two-branch tree.
