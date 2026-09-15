# Retained 200 ms games: complete one-move tactical census

The single registered audit replayed all **40 games and 5,258 searched moves**
and inspected all **2,628 hybrid decisions**. It found **zero missed legal
mate-in-one opportunities** and **zero chosen moves allowing immediate opponent
mate where another legal move avoided immediate mate**. These narrow checks do
not explain the hybrid's 46.25% development score or clear deeper tactical,
move-ranking or evaluation/search failures.

Sixteen chosen moves permitted an immediate mating reply. In each of those
positions, every legal alternative also permitted immediate mate under the
registered rules; none met the avoidable-threat definition. This locates the
problem before those decisions without diagnosing the earlier move.

The [posthoc protocol](hybrid-retained-tactical-v1.md), exact
[registration](hybrid-retained-tactical-registration-2026-09.json), and reviewed
implementation were published in
[dffa7df](https://github.com/den-run-ai/chessy/commit/dffa7df9858513ed5399ecc090c1b655731f17ea)
and the [pre-execution issue record](https://github.com/den-run-ai/chessy/issues/105#issuecomment-5677995379)
before execution. The audit used python-chess 1.11.2, original opening prefixes,
complete move stacks and repetition histories. There was no filtering by outcome,
phase or game length, and no new engine search, training or teacher label.

| Crossing between consecutive hybrid decision roots | Down | Up |
|---|---:|---:|
| Expanded endpoint boundary, phase <= 6 | 43 | 20 |
| Neural endpoint boundary, phase >= 12 | 39 | 1 |

Roots may be separated by an opponent move. Promotions can increase phase;
crossings alone establish no evaluation error. This census does not compare
alternative move values or measure continuity of the evaluator at either boundary.
Likewise, a hypothetical move avoiding mate on the next turn would not establish
that the game could be saved.

The copied implementation and protocol were read-only; interpreter, chess-module
and input bytes were authenticated. One parent enforced the registered 60-second
limit. The attempt completed, with all 40 game checkpoints and the terminal
coverage record retained. There was no timeout, extension or rerun. The raw
2,669-row JSONL includes each inspected decision, including negative findings.

- Registration SHA-256: `faf720ff2309c9e6569cc70aed692238becea87fcadd6866661bead0a779467d`.
- Full retained rows SHA-256: `b2af28a647f6508f10af7e0cae559216ab6530250019b10b493c0ebdd9ee7d6d`.
- [Machine-readable result](hybrid-retained-tactical-results-2026-09.json).

The result remains exposed development evidence, with no strength, Elo or runtime
claim. HCE remains shipped. Paid compute: **$0**.

An [independent identity and aggregation audit](hybrid-retained-tactical-independent-audit-2026-09.json)
authenticated the complete input and output inventories and recomputed phase and
count aggregates. It did not rerun tactical enumeration or independently establish
that every recorded mate list was complete. The reviewed enumerator and its
synthetic legal/mate tests support that part of the result. Complete retained
rows and audit receipts are preserved through the
[private evidence receipt](hybrid-retained-tactical-evidence-preservation-2026-09.json).

## Completed-scope retirement

Later review found that the reusable launcher could reopen its script pathname
after checking it: a writable ancestor could replace the read-only implementation
directory before child startup. Copying a study without its local started receipt
could also reopen this consumed attempt. These are reusable-launcher defects;
the actual audit used the unchanged copied read-only snapshot, whose source and
retained outputs passed the independent evidence audit. No tactical enumeration
was rerun to address this review.

The census is complete. Its current freeze, preflight, run and child APIs now
reject before accessing arguments, paths or ledgers, and every CLI invocation
fails. Copied runners, aliases, fabricated studies and cached modules whose
pathnames change cannot reopen these APIs. Only the pure synthetic mate and
phase helpers remain. Tests cover those entrypoints and the exact historical
source hash. There is no new general executor.

The exact executed [historical source](../../tools/training/hybrid-retained-tactical-historical-v1.py.txt)
is preserved as non-executable text with SHA-256
`15a9b6b4fc34cb804783d5ae171c0ba514eeeba0bc086d3d62a637dbf4e4984f`.
It is evidence only and must not be executed. The frozen protocol, registration,
raw rows, results and independent audit remain unchanged. A future tactical
study requires a separate reviewed protocol and execution boundary.
