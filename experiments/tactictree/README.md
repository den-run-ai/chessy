# tactictree — recursive labelling of chess tactics over minimal contrastive trees

Research prototype for the idea: **tactics like the zwischenzug are properties
of the game tree, not the position** — so classify them by (1) building a
*minimal contrastive tree* (engine best line + refutation of the human-expected
"natural" move) and (2) running a *recursive labeller* over it, one reasoner
sub-call per node with child labels passed upward ("semantic minimax backup").
The reasoner is pluggable: a deterministic rule-based stand-in today, an
LLM sub-call (RLM-style, arXiv 2512.24601) tomorrow — the recursion scaffold
is identical for both.

## Layout
```
src/tactictree/
  labels.py     taxonomy (Motif), TreeNode, NodeAnnotation, TreeReport
  engine.py     Stockfish wrapper + natural_move() heuristic (Maia hook TODO)
  tree.py       minimal contrastive tree: BEST branch + NATURAL branch
  features.py   node-local features only (no tree info, by design)
  reasoner.py   Reasoner interface; RuleBasedReasoner; AnthropicReasoner
  recursion.py  label_subtree() recursion, compose_root() tree-level motifs
                (intermezzo lives HERE — it only exists in the contrast),
                static_baseline() ablation
fixtures/positions.py   5 curated positions with expected labels
run_feasibility.py      end-to-end run + ablation table
```

## Run
```
pip install chess && apt-get install stockfish
python3 run_feasibility.py
```

## Result (this sandbox, Stockfish 16, depth 14)
recursive-tree recall **5/5**, static position-only baseline **2/5**.
The two motifs the static baseline can never see — intermezzo and the
line-dependent discovered check — are exactly the ones the tree recovers.
Avg tree: 8.2 nodes → ~8 LLM sub-calls/position (~6K haiku-class tokens).

## Intermezzo rule (the thesis in code)
`compose_root()` fires INTERMEZZO iff: a natural move existed, best ≠ natural,
the best move is forcing, eval(best) − eval(natural) ≥ 150cp, and the deferred
capture (or larger material gain) lands later in the best line. None of these
conjuncts is computable from the root position alone.

## Next steps
1. Swap RuleBasedReasoner → AnthropicReasoner (implemented, needs API key);
   measure label agreement vs Lichess theme tags at scale.
2. Replace natural_move() heuristic with Maia policy argmax.
3. Scale to the Lichess puzzle DB (intermezzo tag = ground truth) and report
   per-theme F1 for {static, tree+rules, tree+LLM}.
4. Let the LLM *drive* expansion RLM-style (choose which branches to open)
   instead of a fixed two-branch tree.

## Running with a real LLM reasoner (OpenRouter)
```
export OPENROUTER_API_KEY=sk-or-...        # never commit or hard-code keys
python3 run_feasibility.py --reasoner openrouter --model google/gemini-3.6-flash
```
Per position: ~9 node sub-calls + 1 tree-level compose call. Responses are
disk-cached in .llmcache/ so re-runs don't re-spend budget. The report prints
two LLM columns: node-level motifs (backed up recursively) and the tree-level
compose judgment — the latter tests whether the model itself recognises the
intermezzo when shown the contrastive evidence.

## Measured results (live OpenRouter runs, 2026-08-04)

| model                   | recall | wall | tokens in/out | actual cost | notes |
|-------------------------|--------|------|---------------|-------------|-------|
| rule-based (no LLM)     | 5/5    | 2s   | —             | —           | deterministic stand-in |
| google/gemini-3.6-flash | 5/5    | 197s | 11.6K / 26.7K | ~$0.22      | reasoning model: ~320 hidden thinking tokens/call |
| google/gemini-2.5-flash | 5/5    | 40s  | 11.6K / 1.5K  | ~$0.01      | no reasoning; noisier labels (spurious mateThreat, fork) |
| static baseline         | 2/5    | —    | —             | —           | blind to intermezzo + line-dependent motifs |

Both models' tree-level compose call, shown the two branches of the Elephant
Trap contrastive tree, independently judged **intermezzo** — gemini-3.6-flash
with a fully correct explanation (Bb4+ before recapturing, queen recovered
via the Qd2 block), gemini-2.5-flash correctly but with a spurious extra
`fork` label. That weaker/cheaper models stay at 5/5 recall given the tree —
while the same models are far below that on position-only benchmarks like
ChessQA — is the point: the tree does the calculating, the model only labels.
Full transcripts: `RUN_LOG_openrouter_gemini-3.6-flash.txt`,
`RUN_LOG_openrouter_gemini-2.5-flash.txt`. The shipped `.llmcache/` (84
responses) makes re-runs free: `OPENROUTER_API_KEY=dummy python3
run_feasibility.py --reasoner openrouter` replays from cache.

## Lichess evaluation (50 theme-stratified puzzles)

`lichess_sample.py` streams the official puzzle dump and samples 8 themes
with a rating-quantile spread; `run_lichess.py` scores four systems per
puzzle; `analyze_lichess.py` prints the tables. Result (gemini-3.6-flash):
**static 16% → tree+rules 64% → tree+LLM 84%** recall on the sampled theme,
with the LLM strictly dominating the rules (10 wins, 0 losses), equal or
better tag-verifiable precision, and every miss structurally attributable
(mostly: no natural-move branch → the compose level never saw the contrast).
A cheap no-reasoning model (deepseek-v4-flash) scores **58%** on the same
trees — exactly matching the hand-written rules and their theme-by-theme
split — so reasoning, not just the tree, is what converts tree evidence
into labels the features don't spell out. Full analysis, forensics,
serving-quality findings, and limitations: **[REPORT.md](REPORT.md)**.
Artifacts: `lichess/puzzles_50.csv`, `lichess/results_gemini-3.6-flash.jsonl`,
`lichess/RUN_LOG_lichess_gemini-3.6-flash.txt`.

Plumbing note: `max_tokens` is set to 2000, not ~400 — reasoning models spend
hundreds of hidden thinking tokens per call and a tight cap truncates the JSON
answer. The run-log cost line prices all models at gemini-3.6-flash rates; the
table above uses each model's real rates (verified against the key's billed
usage: $0.2257 total for both runs + one smoke call).
