# Posthoc one-move tactical census, frozen before execution

This is one $0 diagnostic of the completed 200 ms development match. It does
not revive the skipped fixed-node failure sampler, select training data, run a
chess engine, or establish evaluation quality or strength beyond exact tactics.

Authenticate the retained archive SHA-256
`d1fe0e2b2cb0586a3811df386d48110fa2859ec39fac659f518118d307b72f86`,
the original registration `8610cb22228618f4a2f5da68e269b25eaf8cf2f883d251527769a618b26a5c71`,
and independent audit `508190d5fb45668eb9d023958ff3e41a9e69c55d04f3e4679fa26df921220d85`.
Require all 41 members, 40 distinct games and 5,258 searched moves. Replay each
opening prefix and every move through pinned python-chess 1.11.2, preserving
the complete move stack and checking every FEN and repetition-history map.
Inspect all 2,628 hybrid decisions, with no filtering on outcome or phase.

At each hybrid decision enumerate every legal mate-in-one move. A missed
opportunity means the chosen legal move is absent from a nonempty mate list;
it does not mean the chosen move loses. Also enumerate the opponent's legal
mate-in-one replies after the chosen move. If any exist, inspect alternatives
in sorted UCI order until finding the first legal move allowing no immediate
mate; record that witness. This is an avoidable immediate mating threat, not
a claim that the witness preserves a draw or win. Moves that immediately end
the game under Chessy's mate/stalemate/material/100-halfmove/threefold rules
allow no subsequent reply. Checkmate takes precedence over draw rules.

Phase is min(24, knights + bishops + 2*rooks + 4*queens), both colors. Record
every root phase, and crossings between consecutive hybrid decision roots
within the same game at the predicates phase<=6 and phase>=12, including
direction. These roots may be separated by an opponent move. Phase changes
alone imply no evaluation error or causal explanation.

Freeze script, protocol, Python interpreter, chess module and input identities
before execution. Use a copied read-only script and authenticated archive bytes.
One parent enforces a hard 60-second child deadline after the hash and counts
CPU slots. No warmup, extension or rerun; an exclusive started receipt records
the attempt. Flush each completed decision and per-game checkpoint to retained
JSONL. Timeout/failure preserves partial rows and never produces complete
coverage. Small synthetic mate/legal/phase fixtures may run before execution.

Report exact coverage, counts and concrete FEN/move witnesses, including zero
findings. This narrow census does not measure general move ranking, deeper
tactics, runtime shares, phase-transition evaluation accuracy or teacher truth.
