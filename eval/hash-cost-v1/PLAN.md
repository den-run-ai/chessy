# One searched-edge board hash diagnostic

Freeze one candidate before timing: cache only the piece-square Zobrist pair
by actual search ply. Update after legality succeeds, immediately before a
searched edge. Quiescence skips updates until the child's halfmove counter
requires repetition tracking; the first needed uncached board scans once.
Legality, quiet-check and PV reconstruction probes retain their existing cost.
Turn, castling, raw EP table keys and legal EP repetition keys retain the exact
canonical implementation. The original complete hash remains a test oracle.
No HCE state, transposition-table policy, evaluator or search choice changes.

This produces only an isolated research tree. Production Rust/WASM and the
legacy 144-case fixture remain untouched. One CPU candidate, $0 paid compute;
no fitting, alternative thresholds, holdout search or formal admission.

Before timing require authored special-move edge/full-scan equality, unchanged
make/unmake state, complete node/score/depth/counter/stop signatures for ordinary,
direct fixed and shared-budget forced-root searches, exact legal PVs, abort
budgets and repetition history. Compile using the existing pinned toolchain.
Measure one rotated-order fixed-node grid on the exposed 18-position benchmark,
four repetitions at 10,000, 36,000 and 230,000 nodes with quiescence enabled.
The fixed grid uses maxDepth 111 and timeMs 0. Pair each position and repetition
by node budget; divide candidate NPS by reference NPS, then take the median of
all 72 ratios at each budget. Phase medians use the same ratios: Ruy Lopez and its
mirror are opening; benchmark positions 8–15 are endgame; remaining positions
are middlegame. Mirrors remain paired descriptive cases, not independent samples.
If every signature matches and median paired candidate/base NPS exceeds 1.03
at 230,000 nodes, with no phase median below .98, a separate frozen five-second
Master timing comparison may proceed when the host is exclusive. Otherwise
record the result and stop. These are research routing rules, not Elo gates.
The conditional Master grid uses the same positions, two repetitions, maxDepth
30, nodeLimit 0 and timeMs 5,000 (72 searches, about six minutes). Timing can
change visited nodes and search outcomes in that grid. Both registrations bind
the Node runtime, source receipt, module bytes and benchmark dependencies. This
host uses Node 24.19.0; it is an exploratory CPU measurement, not the Node
22.23.2 production compressed-size ratchet or physical-device evidence.

Time metadata from tests under concurrent work cannot establish a speedup.
The runtime grid must wait for the ongoing quiescence/hybrid exclusive sessions.
