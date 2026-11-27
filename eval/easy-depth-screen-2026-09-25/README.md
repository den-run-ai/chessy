# Easy depth-cap screen: retain depth 2

The fixed 200-game development screen did **not** meet the preregistered
selection rule, so Easy stays at maximum depth 2, 10,000 nodes, 5,000 ms,
quiescence on. Depth 1 is a promising candidate, but this screen does not
establish the reduction with the required uncertainty bound. No extra games,
new threshold, or additional candidate followed this result.

These are diagnostic Stockfish-anchor estimates from one Linux container,
not certified FIDE, human, Chess.com or Lichess ratings. They do not satisfy
E4/device/adjacent-level certification gates. Both blocks use the same 50
previously exposed even-indexed development openings, with both colors.
Shared opening families make opening-bootstrap intervals optimistic.

| Easy preset | Games | W–D–L | Score | Anchor estimate | Opening-bootstrap 95% interval |
| --- | ---: | --- | ---: | ---: | --- |
| Depth 2 control | 100 | 57–7–36 | 60.5% | 1574 | 1514–1639 |
| Depth 1 candidate | 100 | 41–16–43 | 49.0% | 1493 | 1433–1556 |

Both use the frozen Stockfish 18 executable at `UCI_Elo=1500`, one second per
move, with identical anchor and adjudication settings. White/Black scores were
63%/58% for depth 2 and 55%/43% for depth 1. The old r80 odd-opening result is
context only; it is not pooled with these new games.

The candidate's point estimate is 81 Elo lower and 7 Elo from the 1500 target,
versus 74 Elo for the control. Its paired score difference is −11.5 percentage
points, but the 95% opening-bootstrap interval is **−24 to +1 percentage
points**, including zero. Resampling keeps the same opening IDs and both
colors together across candidates (10,000 replicates, seed 20260925).

| Preregistered requirement | Result |
| --- | --- |
| Candidate point estimate strictly closer to 1500 | Pass |
| Candidate point estimate at least 50 Elo weaker | Pass |
| Paired score-difference 95% upper bound below zero | **Fail: +1 percentage point** |
| No product/anchor failures, illegal moves or search retries | Pass |

## Execution and search diagnostics

Both blocks completed without interruption from a single clean `.runs` header
each and sealed automatically. Every game was retained and replay-validated.
There were no retries, watchdog failures, illegal moves, anchor failures, or
TT-saturated searches.

| Diagnostic | Depth 2 | Depth 1 |
| --- | ---: | ---: |
| Chessy moves | 4,384 | 4,897 |
| Mean nodes per move | 1,172.4 | 330.8 |
| Mean observed search time | 6.01 ms | 3.74 ms |
| Maximum observed search time | 320 ms | 229 ms |
| Completed depth 0 / 1 / 2 | 1 / 163 / 4,220 | 3 / 4,894 / 0 |
| Stops: maximum depth / node limit / mate | 4,175 / 24 / 185 | 4,757 / 3 / 137 |
| Checkmate / 180-ply draw | 93 / 7 | 84 / 14 |
| Repetition draw / stalemate | 0 / 0 | 1 / 1 |

The rare depth-0 searches are legal root fallbacks when quiescence exhausts
the 10,000-node cap before a full depth finishes; they are not failed worker
attempts. Depth 1 does not guarantee completion under that work cap.

Runs started together with concurrency 3 each on an Intel Xeon Platinum
8573C Linux x86-64 host, Node v24.19.0; 9 logical CPUs were exposed and the
cgroup quota was 8 cores. Control took approximately 24.9 minutes and candidate
27.4 minutes, based on local run/receipt file times. The control finished
before the last candidate games. These timings describe this run, not a
supported-device benchmark; the complete `.runs` headers retain the host and
initial load average.

## Exact provenance and reproduction

- Original main: `74f19f02243e18ef9baf1961d84a79a42489f60c`.
- Preregistration and control: `afde059c891319db73cd1eb6ac09035ac485fd4c`.
- Experimental candidate: `cf38d6f17e7fab67e907a29dbd147e66cd69298d`.
- `registration.bundle` preserves the original two commits, requiring the
  original main commit above. This preserves registration identity if an API
  publication gives the surrounding evidence commit a different SHA.
- `candidate.patch` retains the full-index one-line change from depth 2 to 1.
  The experimental candidate is not a publishable runtime release and was
  rejected by this protocol; its bytes are retained for reproducibility only.
- `provenance.json` records identities, checksums and execution details.
  Each block retains its raw NDJSON, exact run header and completion receipt.
  All captured identities match between blocks except the preset hash and
  input commit. Rust/WASM, rules, loader, bridge, runner, openings/protocol and
  Stockfish bytes are identical.

Verify the bundle from a repository containing the original main commit:

```sh
git bundle verify eval/easy-depth-screen-2026-09-25/registration.bundle
git fetch eval/easy-depth-screen-2026-09-25/registration.bundle refs/heads/codex/easy-depth1-candidate
```

Regenerate `analysis.json` with the verified entrypoint (the command also
verifies both receipts and replays all 200 games):

```sh
node eval/easy-depth-screen-2026-09-25/verify.js eval/easy-depth-screen-2026-09-25/control-depth2.ndjson eval/easy-depth-screen-2026-09-25/candidate-depth1.ndjson
```

`verify.js` was added after the screen to enforce the existing input contract
before publishing a result. It calls the unchanged preregistered `analyze.js`,
then checks its returned receipt identities against the exact source hashes,
Stockfish executable, host, concurrency, schedule and separate preset hashes
recorded for the registered commits. Two self-consistent receipts, even with
matching but unregistered inputs, are insufficient. The original analyzer,
protocol, raw records, selection rule and generated analysis remain unchanged.

The frozen `PLAN.md` gives the exact settings and game commands. No existing
r80 or other frozen evidence was overwritten; no held-out openings were used.
