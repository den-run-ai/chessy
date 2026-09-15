# Hybrid equal-time evidence: invalid batch, no strength estimate

The registered development run executed all 400 games: the frozen hybrid and
expanded HCE each played shipped HCE over 100 exposed openings with both colors,
20 ms requested per move, and a 180 searched-ply cap. It used one serial worker,
full opening-prefix repetition history, and no repeated seed slots.

The complete-batch evidence gate rejected the run before score analysis. Of the
400 game files, 338 matched their close-time hashes and lengths; 62 were shorter
valid JSONL prefixes missing their terminal records. Their missing tails are
real missing evidence, not a character-versus-byte accounting discrepancy.
For example, `expanded-o2-w.jsonl` contains 217,214 bytes and 66 rows, while its
retained close-time receipt declares 485,317 bytes and 111 rows. An independent
Python inspection confirmed the loss, and the original files, receipts and a
forensic copy were retained. The writer had verified its file hash after fsync
at close; the cause of the later discrepancy is undetermined.

**No game score, Elo estimate, subset result, shipping verdict or rerun under
its registration is allowed from this batch.** The 338 authenticated files do not form the registered
complete paired schedule. This failure does not establish that either evaluator
is stronger or weaker. The separately measured static teacher and runtime
results remain separate evidence.

The prospective 200-game implementation follow-up was also **skipped** under
its previously frozen speed trigger. Cached phase and cached phase with shared
HCE work improved median paired 16,384-node throughput by approximately 0.402%
and 0.418% versus the original hybrid, below the required 5%. Both retained
exact compiled evaluation and all available returned fixed-node search fields
(PV equality was not checked), but neither was
eligible for extra matches. The failed first batch did not alter that decision.

`hybrid-match-capture-v1.js` supplies a separately tested capture
primitive. It retains the exact emitted canonical bytes in parent memory,
compresses them only after timed search stops, and publishes an immutable
archive atomically without overwrite. The archive independently checks every
decompressed game against its verified close-time receipt. A fault-injection
test truncates a live file after close and proves the retained stream recovers
exactly the original SHA-256 and bytes; it never invents missing moves or edits
the truncated evidence. This primitive cannot repair the failed run.

A separately registered infrastructure recovery uses the original 400-game
schedule and original modules, with no original game scores available for
selection. It atomically publishes each whole game and requires parent capture
acknowledgement before the child starts another timed game. After all timed
searches stop it archives the exact retained bytes and audits that archive.
The recovery result is reported separately; the first batch remains invalid,
and the independent optimized 200-game follow-up remains skipped.

The [recovery completed and independently passed](hybrid-match-recovery-results-2026-09.md)
all 400 games and 48,851 searched moves. Its hybrid scored 41.5% and its expanded
HCE control scored 49.0%, each in a separate comparison with shipped HCE.
These outcomes belong only to that new registration.

Paid compute for these matches and capture checks: **$0**. The formal holdout
opening bank was not loaded; all protocols remain research-only.
