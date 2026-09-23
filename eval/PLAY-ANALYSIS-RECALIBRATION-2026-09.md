# Play/analysis budget proposal — not merge-ready

Date: 2026-09-23. Inspected base: `34a9061e6d74657f06e7ffe74318dc39a851bec2`
(r79). Candidate release: r80. Production Rust sources and WASM bytes unchanged.
This is a proposed scheduling/orchestration change, not an Elo certification.

## Proposed policy

Stable IDs and provisional targets remain Easy 1500 / Medium 1700 / Hard 1900 /
Expert 2100 / Master 2300+. Easy–Expert retain 10k/36k/230k/1.44M nodes,
maxDepth 30 and a 5-second safety ceiling. Master uses uncapped nodes, the ABI's
111-ply ceiling, quiescence, and at most 8 seconds. Timed Play allocates a smaller
budget using remaining clock and increment, reserving delivery time and a second
identical-request attempt. Invalid prototype-property difficulty IDs fail closed.

Quick whole-game screening remains unchanged. Selected-moment and manual deep
analysis share a 16-second uncapped-node scan, followed by separate 16M-node
exact-root and stability budgets. The scan winner and played move are visited
first. If the first exact root aborts, preserve only the completed scan's legal
best move, score and one-move PV, explicitly partial; never fabricate MultiPV,
a continuation, a played-move score, or a verified lesson.

## Blocking finding

Simply increasing the analysis scan budget is NOT a shippable recalibration.
`node test/analysis-service.test.js` exposes a real flow regression on its
existing missing-Rxa8+ rook-ending fixture:

- FEN: `r3k3/8/8/8/8/8/8/R3K3 w - - 0 1`; played `a1b1`.
- The proposed 16-second scan reached depth 14 on this Linux/Node runtime.
- One observed complete request consumed 63,677,439 nodes and 22,242 ms, but
  returned `complete:false`, best line `a1a8`, no played line.
- The controller correctly paused with `Deep analysis was unusable — resume to
  retry.` rather than falsely reporting a verified blunder or a finished scan.
- The existing real-service completion/progress assertions therefore fail. They
  remain in place; this draft must not be merged or deployed in this state.

The primary bottleneck is exact full-window root verification at a depth chosen
by a much more efficient iterative single-PV scan. An exploratory per-root
warm-up did not resolve this fixture and is NOT included. A 64M-node-per-phase
probe exceeded a 100-second local execution limit and is NOT a production fix.
Neither observation establishes strength, an optimal budget, or mobile timing.

A mergeable successor must retain a stronger bounded analysis search WITHOUT
regressing complete coaching evidence, honest partial handling, cancellation,
Gate 0, cache identity, or the existing completion tests. Do not relax those
checks, silently lower verified depth, or treat an unverified played move as bad.

## Validation checkpoint

Local Node v22.16.0 on Linux. Passing suites: level-presets (9), new search-budget
regressions (8), analysis-core (36), analysis-result (60), moment-scan (64),
moment-selector (75), ai-telemetry (16), wasm-asset (17), wasm-signatures (144).
The real-service suite's completion path remains blocked as above. Browser
regressions for real low-clock Master play and malformed saved IDs are included
but require the pinned Chromium/WebKit CI environment. No Rust/toolchain changes,
formal E4 games, physical-device certification, or absolute Elo calibration were
performed. Frozen E4-v1 manifests and r69 signature evidence are untouched.

The source-transfer workflow used to obtain this network-isolated working copy
is temporary and is removed from the final branch tree.
