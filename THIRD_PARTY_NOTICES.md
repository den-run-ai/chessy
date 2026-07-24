# Third-Party Notices

Chessy is licensed under the MIT License (see `LICENSE`). It bundles no
third-party source code. This file records attribution for third-party
**data** incorporated into the project.

## PeSTO evaluation coefficients

`assets/ai.js` uses the **PeSTO** tapered evaluation coefficients — the
middlegame/endgame material values (`VALUES_MG` / `VALUES_EG`) and the twelve
middlegame/endgame piece-square tables (`PST` / `PST_EG`).

- **Author:** Ronald Friederich (author of the *RofChade* chess engine).
- **Origin:** originally published by the author on the TalkChess forum;
  also mirrored on the Chess Programming Wiki page
  "PeSTO's Evaluation Function"
  (<https://www.chessprogramming.org/PeSTO%27s_Evaluation_Function>), which is
  used here only as a secondary reference.

### Basis for use

These coefficients are incorporated as **functional numerical tuning outputs**
arranged in a dictated piece×square layout — i.e., facts and mechanically
arranged data rather than copyrightable creative expression. Under U.S.
copyright practice, algorithms, systems, methods, and plain facts/data are not
protected by copyright. Chessy therefore uses these values under that data /
non-copyrightability basis, with attribution retained here as a courtesy and
for provenance.

The Chess Programming Wiki's sitewide CC BY-SA 3.0 marking applies to the wiki
*text*; it is **not** relied upon as a license grant for these numerical
values, and is noted here only so readers do not mistake it for the governing
license.

For zero ambiguity a maintainer may additionally obtain a one-line explicit
MIT/CC0 permission from the author; the documented data-position above stands
regardless.
