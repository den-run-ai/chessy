# Release notes

[Home](README.md) · [Player guide](docs/PLAYING.md) ·
[Engine research](experiments/wasm/CHATARUNGA-REVIEW.md)

Selected recent app changes, newest first. Earlier behavior and calibration
studies are linked below; this is not a complete release history.

## r84: Mobile dialogs and game state

New game keeps Start game and Cancel visible while settings scroll, including in
short landscape phone windows. Import, game-over, and confirmation dialogs
use the same layout. Buttons remain at least 44 px high, keyboard focus brings
selected options into view, and dialogs respect viewport and safe-area insets.
Import also avoids narrow-screen file-input overflow and iOS text-field zoom.

Moves that arrive after a clock expires now flag from the original position,
without adding a move to the board, save, or archive. On-time moves use one
timestamp for admission and the clock increment. Invalid saved opponent or
time-control names fall back to valid settings while preserving legal games.

## r83: Analysis recovery

Review and Train start a fresh analysis worker when an optional IndexedDB
cache read has not completed within one second. Late cache results cannot
replace or restart that worker or a newer request. Cancelling a probe also
retires its pending cache lookup.

A synchronous failure to send a worker request receives one fresh-worker retry,
matching other worker failures. Two failed attempts leave a retryable error
and preserve the position and saved evidence. The engine binary, evaluation,
difficulty budgets, and reflection gates did not change in this release.

## r82: Correctness refresh

Stale promotion choices can no longer commit after cancellation, a flag,
Undo, replay, or New game. The WASM loader rejects stale analysis phases after
a replacement request fails and validates the reserved ABI result field.

CI gained comparisons between shallow Rust searches and an independent
JavaScript-rules oracle, plus checks for exact node-budget boundaries,
completed-iteration fallback, forced-root principal variations, and repetition
counts. Engine bytes, evaluation, and difficulty budgets did not change.
The [Chatarunga review](experiments/wasm/CHATARUNGA-REVIEW.md) records the
reference paper and follow-up research directions.

## r80: Difficulty and deep analysis

An [exploratory Stockfish 18 screen](eval/level-screen-r80/README.md) led to
10,000-, 36,000-, and 230,000-node budgets serving Medium, Hard, and Expert.
Easy uses 10,000 nodes with a depth-2 cap; the former 1.44-million-node preset
was dropped. The later [200-game depth-cap comparison](eval/easy-depth-screen-2026-09-25/README.md)
retained depth 2: depth 1 was closer to the 1500 target by point estimate but
missed the preregistered paired-confidence threshold.

These screens do not certify the displayed ratings. The frozen E4 evidence
remains unchanged; current calibration requirements are described in the
[evaluation guide](eval/README.md).

The deep analysis profile added a scan of up to 16 seconds followed by
iterative all-move verification within a 16-million-node budget. Review scans
from r79 restart when reopened because their evidence uses the older profile;
manual verifications are recomputed. See [coaching analysis](docs/ARCHITECTURE.md#coaching-analysis)
for reporting and stability rules.

## Engine research and resource policy

Search-cost prototypes and size-budget changes are tracked separately from
app releases. The [engine guide](experiments/wasm/README.md) gives the current
40 KiB raw and 20 KiB Brotli-11 download budgets and pinned encoder requirements.
Archived experiment receipts retain their original limits and verdicts.

The [cost-admission proposal](experiments/wasm/SEARCH-COST-ADMISSION-PROPOSAL.md)
and [prototype results](experiments/wasm/CHATARUNGA-REVIEW.md#follow-up-cost-prototypes)
record the remaining source, runtime, and device evidence. A prototype fitting
the download budget does not by itself establish release readiness or Elo gain.
