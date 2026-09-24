# Play/analysis budget recalibration (r80)

Date: 2026-09-24. Base: `34a9061e6d74657f06e7ffe74318dc39a851bec2` (r79).
Candidate release: r80. Production Rust sources and WASM bytes are unchanged.
This is a scheduling/orchestration change, not an Elo certification. The
exploratory level screen is reported separately in
`eval/level-screen-r80/README.md`.

## Policy

Stable IDs and provisional targets remain Easy 1500 / Medium 1700 / Hard 1900 /
Expert 2100 / Master 2300+. After the exploratory level screen
(`eval/level-screen-r80/`) placed each r79 budget about one label above its
target, the maintainer moved the budgets up one label: Medium/Hard/Expert now
use 10k/36k/230k nodes (maxDepth 30), the 1.44M-node preset is dropped, and Easy
is the 10k cap limited to depth 2. All keep a 5-second safety ceiling. Master
is unchanged by the relabel: uncapped nodes, the ABI's 111-ply
ceiling, quiescence and at most 8 seconds. Timed Play sizes each request from
the remaining clock and increment, reserving delivery time and a second
identical-request attempt after a reported worker failure. An AI clock that is
already empty flags before dispatch. Invalid prototype-property difficulty IDs
fail closed.

Quick whole-game screening is unchanged. Selected moments, manual Verify and
Train's live check share one deep profile: an uncapped-node scan of at most
16 s, then one exact verification phase of at most 16M nodes.

## Blocking finding in the first draft, and its cause

The first draft verified every legal root under a full window at the depth
the 16 s scan reached, in a cold phase, then repeated one ply shallower. The
single-PV PVS scan is far cheaper per ply than exact all-root verification, so
it reached depths the verification could not finish. On the real-service
fixture (`r3k3/8/8/8/8/8/8/R3K3 w - - 0 1`, played `a1b1`, missing `Rxa8+`)
the scan reached depth 14 and the first root alone exhausted 16M nodes;
Review paused with "Deep analysis was unusable" and three
`test/analysis-service.test.js` assertions failed.

Two further defects surfaced during review of the draft:

- **Full transposition table.** The engine's fixed 1,048,576-entry TT has no
  replacement; when it fills, the ABI returns status 2 and the loader threw.
  The node count at which that happens is deterministic, so the product's
  identical retry failed again, and so did every manual Retry. Uncapped
  8-second Master reached it on this 4-core container in 3 of 13 probe
  positions (for example `r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq -` at
  10,355,862 nodes), and the 16 s deep scan reached it in endgames. r79's
  5-second Master carried the same risk on faster devices.
- **Train** copied the deep profile field by field and dropped `scanTimeMs`,
  silently running a different, fixed-node contract.

## Fix: iterative exact verification

For timed deep requests the scan depth is only a cap. One budgeted phase
scores every legal root under a full window at depth 1, 2, 3, … in turn.
Every iteration shares the phase's TT, so each serves as move ordering for the
next; because TT scores are only reused at the identical depth, each root score
equals a cold verification at that depth (0 mismatches in 1,206 root-score comparisons
at depths 1–5 on seven positions; `test/analysis-core.test.js` now asserts the
full ranking, played rank, classification and stability against the fixed-node
path at depths 4–6).

- The result is the deepest iteration in which **every** root completed,
  reported at its own depth. An iteration interrupted by the node budget or a
  full TT is discarded whole, never mixed with shallower scores. An iteration
  whose predicted cost (the last iteration's cost times the average growth
  over the last two, which alternate between odd and even depths) exceeds the
  remaining budget is not started; on ten measured positions this lost no
  verified depth and avoided nine of ten doomed iterations.
- Verification always reaches depth 3 (budget permitting) even when the scan
  stopped earlier, for example on a short mate or in a suspended tab, so
  Review has the stability it requires.
- The previous iteration supplies stability (`depths: [d−1, d]`, as the
  validator requires). If the deeper scan preferred a move that the verified
  iteration ranks strictly lower, the best move is marked unstable, so no
  automatic mistake mark or suggested moment rests on it (a manual Verify
  still shows its lines and leaves the diagnosis to the player).
- Ties rank by canonical legal-move order, as on the fixed-node path, so the
  search order cannot make a tied move "best", "stable" or "same".
- Only if not even depth 1 completes is the result partial; it then keeps the
  scan's single best move and nothing else.
- The timed contract's `configHash` carries an `iterative-exact-v1` tag;
  fixed-node identities, the E3 scorecard options and baseline are unchanged.
- Progress counts root searches over the planned roots × depths schedule, so
  it stays monotonic with a fixed total; Verify names the depth being
  verified and Train's live region announces only depth transitions. A
  fresh-worker retry may plan a different schedule; public progress resumes
  once its completed fraction passes the published one.
- Timed deep results depend on the wall clock and are cached, so resuming a
  Review slot whose deep result was unusable recomputes it instead of
  re-serving the cached row.

`search()` now keeps the deepest completed iteration when the TT fills (stop
reason `unknown`, never a false `time-limit`, with an explicit `ttSaturated`
flag kept in saved-game telemetry), and `searchRoot()` throws a
tagged `tt-saturated` error that ends the verification phase. Real-WASM tests
pin both paths on `r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq -`.

## Measured deep profile (Node 22, loaded 4-core container)

End-to-end `ChessyAnalysisCore.analyse` with the shipped deep profile while the
level screen was running (load average about 5), so wall times are pessimistic:

| Position | Scan depth | Verified depth | Stable | Best | Played (rank) | Nodes | Time |
| --- | ---: | ---: | --- | --- | --- | ---: | ---: |
| Rook ending (service fixture) | 14 | 11 | yes | Rxa8+ +594 | Rb1 (2) | 45.1M | 26.4 s |
| Sicilian Dragon, Yugoslav | 8 | 6 | yes | Nxc6 | O-O-O (2) | 28.6M | 36.6 s |
| Master incident, 11…Bd4 | 7 | 6 | no | Rae8 | Bd4 (17) | 30.6M | 34.6 s |
| Start position | 9 | 8 | yes | d4 | g4 (20) | 31.8M | 33.1 s |

The r79 profile verified depths 4–8 on comparable positions in under a second;
r80 verifies 2–3 plies deeper but costs tens of seconds per deep request. The
doomed-iteration guard was added after these measurements and only shortens
them. A 13-position probe verified at least depth 6 everywhere; verified depth
was 1–4 plies below the 16 s scan depth, so the scan-disagreement rule is the
normal path, not an edge case.

## Validation checkpoint

See the pull request for the exact commands and results on the final head.
Chromium browser suites were run locally with the preinstalled Playwright;
WebKit runs in CI only. No Rust/toolchain change, formal E4 game,
physical-device certification or absolute Elo calibration was performed.
Frozen E4-v1 manifests and r69 signature evidence are untouched.
