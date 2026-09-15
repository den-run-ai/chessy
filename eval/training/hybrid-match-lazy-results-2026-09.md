# Conditional lazy-H8 match: skipped by the frozen speed gate

No additional games ran. The prospective lazy-H8 protocol required an
independently verified implementation with at least **5%** greater paired
median throughput than the concurrent original hybrid at 16,384 nodes.
The observed improvement was **3.696%**, so the 200-game follow-up was skipped.

| Paired 16,384-node throughput versus original hybrid | Change |
|---|---:|
| All 48 pairs, median | +3.696% |
| Opening, 16 pairs | +9.669% |
| Middlegame, 16 pairs | +5.954% |
| Endgame, 16 pairs | −1.130% |

All phase strata passed the separate 5% regression allowance. Independent
verification passed the 576-cell measurement inventory, 501 complete compiled
evaluation cases and 96 comparisons of all returned fixed-node search fields.
PV equality was not claimed or checked. Exactness did not waive the overall
speed requirement, and the preceding recovery game's outcomes did not change
the trigger.

The [prospective match contract](hybrid-match-lazy-v1.json) was frozen before
the lazy cost measurement and before recovery-match score analysis. Its
canonical skip receipt is `hybrid-match-lazy-v1-skipped.json`; the
[public receipt](hybrid-match-lazy-results-2026-09.json) binds that contract,
raw cost, compressed cost, integrity envelope, source receipt and independent
audit. No model or gate was reselected. Paid compute for extra matches: **$0**.
