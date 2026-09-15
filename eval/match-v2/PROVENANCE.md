# Prospective opening manifest v2

This is frozen development/test data, not a shipped engine asset or a formal
release gate. PR #170 implements the registered diagnostic runner, raw replay
aggregation and manual workflow described in [EXECUTION.md](EXECUTION.md).
Formal family/estimator admission remains unfinished in
[issue #175](https://github.com/den-run-ai/chessy/issues/175), even though its
original tracker #156 is closed. Do not use these openings to choose weights, features
or networks.

## Source and license

400 legal opening endpoints derive from
[lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
commit `4b8622759e7ae6f93f011cc6c83a3823401ab45e` (2026-08-04).
The source dedicates its data under CC0-1.0. The literal JSON binds the source
tree, five TSV hashes, README and COPYING hashes, each source row, and the
selection receipt. No engine labels or personal game records are included.

Manifest SHA-256:
`bda65b3253951863f2b01187b2a44becb8d36d29a7917780f6d920a92f4d7dab`.

## Selection, frozen before candidate measurement

1. Require the pinned clean source checkout and tree. Retain all consumed
   source/license bytes directly from that commit's Git blobs, with replacement
   objects disabled; never parse mutable checkout files.
2. Replay legal, non-terminal lines of 6–20 plies.
3. Exclude endpoints already exposed by the historical match and eval opening
   lists; normalize ineffective en-passant targets using legal repetition keys.
4. Group exact transpositions and color/rank mirrors. Retain the lowest
   SHA-256-ranked row in each equivalence group, then each ECO code.
5. Select eight hash-ranked ECO codes per A0–E9 stratum: 400 endpoints,
   80 in each volume. Sort by ECO to assign immutable indices.

The JSON records every ranking rule, source row and equivalence-group hash.
PGN and UCI paths retain opening repetition history for a future ABI-v2 runner.
The catalog contains opening facts, not source games. Related named opening
families can still be correlated; 400 unique positions is not proof of 400
statistically independent chess families. Pair colors and report that limitation.
No balance filter or candidate scores were used.

## Grouping audit

The reproducible [grouping audit](holdout-audit.json) distinguishes 400 unique
endpoint/mirror keys, 340 static pawn/king/material families under PR #146's
frozen family representation, and 60 named opening families. Sixty-one
endpoints share a static family with the exposed v1 sources, although none
shares an endpoint/mirror key. The audit does not change the manifest or
inspect any candidate results.

Static family keys omit other piece squares and state fields, and file
reflection is a conservative training grouping rather than a legal castling
symmetry. Named opening families are a taxonomy. Neither grouping establishes
statistical independence or an effective sample size. Catalog rows have no
source-game IDs, so source-game isolation cannot be inferred from distinct
ECO codes or lines. A formal execution/uncertainty policy must resolve these
distinctions before this data becomes a release gate.

The exposed-line continuation count requires an entire historical opening of
at least six plies as a strict prefix. Sharing a first move alone is not counted;
even full-line continuation is an exposure descriptor, not proof of biased
candidate results. Training should quarantine declared holdout families and
source-game lineages explicitly rather than relying on endpoint deduplication.

```sh
node test/ai-match-holdout-audit.js > eval/match-v2/holdout-audit.json
node test/ai-match-holdout-audit.js --check
node test/ai-match-holdout-audit.test.js
```

The separate [complete dependency map and prospective decision](ADMISSION-PROPOSAL.md)
joins the declared relationships transitively and propagates known exposure.
It does not alter this manifest or the original grouping audit, assert
independent families, or make the diagnostic workflow merge-authoritative.

## Reproduction

```sh
git clone https://github.com/lichess-org/chess-openings /tmp/chess-openings
git -C /tmp/chess-openings checkout 4b8622759e7ae6f93f011cc6c83a3823401ab45e
node test/gen-ai-match-openings-v2.js --check --source-dir /tmp/chess-openings
node test/ai-match-openings-v2.test.js
```

Omit `--check` only to reproduce the file. Any source/selector/record change
needs a new identity before a candidate is evaluated. Never rewrite historical
v1 evidence. The current protocol is diagnostic only and always reports
`formalPass: false`. No formal match should run until a prospective family,
estimator and admission policy is reviewed, frozen and implemented with its
complete trust and integration tests.
