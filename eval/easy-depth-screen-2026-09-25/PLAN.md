# Easy depth-cap comparison — preregistered development screen

Written and committed before any game in this screen. This is an exploratory
product decision, not certified human/server/FIDE Elo, E4 evidence, or formal
engine-strength admission. No locked opening manifest or holdout is read.

## Question and immutable candidates

r80 Easy uses 10,000 nodes, maximum depth 2, 5,000 ms, quiescence on. Its
previous 100-game odd-opening development block estimated about 1592 against
the provisional 1500 anchor. That result motivates one candidate only:
change Easy maximum depth from 2 to 1 and keep every other request field and
the Rust/WASM, rules and loader bytes unchanged. No intermediate depth,
random move policy, node-budget adjustment, or further search follows.

The control is main commit `74f19f02243e18ef9baf1961d84a79a42489f60c` plus
this protocol and analysis script only. Before any game, the experimental
candidate is committed in a separate worktree with only the Easy depth field
changed relative to the control; it is not a publishable runtime release.
Both exact commits and all runner/runtime/tool hashes are captured in `.runs`
headers before their games. Final production release changes, if selected,
will be made and tested separately.

## Fixed schedule and execution

- Control: depth 2, 100 games against Stockfish 18 `UCI_Elo=1500`.
- Candidate: depth 1, 100 games against the same anchor.
- Both blocks use the same 50 even-indexed lines from the existing development
  list `test/ai-match-openings.js`, once as White and once as Black per line.
  These openings have prior development exposure; they are neither fresh
  holdout nor formal independent families. No odd-opening results are pooled.
- Both blocks start together on this Linux x86-64 container, Node v24.19.0,
  CPU quota 8 cores. Each uses concurrency 3 (6 total); other validation may
  use the remaining capacity. Timing and load are reported, not compared as
  a device-performance benchmark. Stockfish limited strength is stochastic.
- Use the unchanged `test/eval/level-screen.js` at the control commit. It
  snapshots runner, bridge, rules, loader, WASM, presets, openings and verified
  executable into a private read-only tree and binds resumes to exact inputs
  and the host. Complete blocks receive authenticated completion receipts.
- Stockfish archive SHA-256:
  `536c0c2c0cf06450df0bfb5e876ef0d3119950703a8f143627f990c7b5417964`.
  Executable SHA-256:
  `6b087694916228c905a5e14db74cca8c7e5643602226af1fa5d42353c455b9f9`.
  These are the frozen SF18 identity in `eval/training/teacher-sf18-100kn-v1.json`;
  its training search profile is not used.
- Anchor settings: `UCI_LimitStrength=true`, `UCI_Elo=1500`, Threads 1, Hash
  64 MiB, Ponder false, MultiPV 1, empty SyzygyPath, Move Overhead 10 ms,
  `go movetime 1000`; `ucinewgame`, Clear Hash and `isready` before every game.
- Rules terminals plus a draw at exactly 180 total plies, including opening
  plies. No resignation, evaluation draw or tablebase adjudication. Product
  search starts/loads and searches within its 8,000 ms watchdog, gets one
  identical fresh-thread retry, and loses on a second failure or illegal move.
  Missing/late (15 s)/illegal Stockfish moves lose for Stockfish.
- All 200 scheduled outcomes count. Do not stop on intermediate results,
  replace games, rerun a valid statistical miss, or alter any parameter.
  Only a genuine interruption may resume absent slots under the runner's
  existing identity checks; retain every run header and disclose interruption.

Commands run in the respective worktrees (output directories outside the
worktrees keep the captured working trees clean):

```sh
node test/eval/level-screen.js --stockfish /tmp/chessy-sf18/stockfish/stockfish-ubuntu-x86-64-avx2 --level easy --anchor 1500 --openings even --concurrency 3 --out /tmp/chessy-easy-depth-screen/control-depth2.ndjson
node test/eval/level-screen.js --stockfish /tmp/chessy-sf18/stockfish/stockfish-ubuntu-x86-64-avx2 --level easy --anchor 1500 --openings even --concurrency 3 --out /tmp/chessy-easy-depth-screen/candidate-depth1.ndjson
```

## Fixed analysis and selection rule

Use `analyze.js` committed with this plan. Verify both complete receipts and
replay traces, require the exact 100-slot schedules/presets, then report W-D-L,
score and color scores, logistic rating (`1500 + 400 log10(s/(1-s))`), and
opening-cluster bootstrap 95% intervals (10,000 replicates, seed 20260925).
Resample the same opening IDs jointly across candidates, keeping both colors
together, to compute the candidate-minus-control score difference interval.
Shared opening families make the uncertainty intervals optimistic; this is
a development screen and not a certified rating or causal confidence claim.

Select depth 1 only if **all** of the following hold:

1. Its point estimate is strictly closer to 1500 than the control's estimate.
2. Its point estimate is at least 50 Elo lower than the control's estimate.
3. The paired opening-bootstrap 95% interval's upper endpoint for
   candidate-minus-control score is strictly below zero.
4. Both blocks have zero product search retries/failures, illegal moves, or
   anchor failures. Any such failure makes the product decision inconclusive.

Otherwise retain depth 2. No second candidate, additional games, changed
threshold, or post-result tuning is allowed under this protocol. Report a
failed or inconclusive selection honestly. Evidence informs only Easy; all
other levels and formal calibration prerequisites remain unchanged.

Also report every termination reason; move counts; completed-depth histogram;
mean/max observed search time; mean nodes; stop reasons; and TT saturation.
Seal raw records, headers and receipts unchanged, then retain the generated
analysis, protocol, exact candidate patch and a short interpretation in this
new evidence directory. Do not overwrite any r80 or other frozen evidence.
