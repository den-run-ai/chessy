# Playing Chessy

[Play Chessy](https://den-run-ai.github.io/chessy/) · [Project overview](../README.md)

Chessy has four views: Play for games, Review for reflection, Train for saved
lessons, and Progress for your activity. Games and training data stay in your
browser. Use one active Chessy tab at a time.

## Start a game

1. Open New game and choose Two players, White vs computer, or Black vs computer.
2. Choose a difficulty and time control. No clocks is available for untimed play.
3. Press Start game. Until then, changing the setup leaves your current game intact.

Starting over after at least one move saves the displaced game in Review as
Incomplete · Abandoned. If saving fails, Chessy keeps the current game and lets
you retry or explicitly choose Start without saving. Empty games are not archived.
On small screens, the setup choices scroll while the action buttons stay visible.

### Difficulty

The five levels are Easy, Medium, Hard, Expert, and Master. Their displayed
1500, 1700, 1900, 2100, and 2300+ ratings are provisional calibration targets.
They are not certified FIDE, Chess.com, or Lichess ratings.

Master searches for up to eight seconds per move; the other levels have a
five-second safety ceiling and smaller work limits. Thinking time decreases
when the computer's clock is low. Device speed and the position can affect
how deeply the engine searches. See [engine details](ARCHITECTURE.md) for budgets
and [calibration evidence](../eval/README.md) for rating limits.

Computer openings can vary between games. During the first six full moves,
Chessy varies the order in which it searches legal moves, then plays a move
selected by that search. Undo, retries, and reloads of the same position keep
the same seed. Variety does not guarantee a different move or a stronger one.

## Move, undo, and replay

Tap or click a piece, then a highlighted legal destination. Chessy supports
castling, en passant, and promotion, and shows the last move, checks, captured
pieces, and the move list. Flip changes your view of the board.

Undo takes back moves and restores their clock state. Using Undo while the
computer is thinking cancels its search and takes back the move that triggered
it. Promotion choices apply only to the current position: changing the game,
undoing, entering replay, or running out of time retires the picker.

Select a move in the Play move list or use the replay controls to browse earlier
positions. Replay does not change the live game. After a game ends, Review game
opens its archived record; if Review is unavailable, it opens on-board replay.
Rematch starts another game.

### Keyboard and screen readers

The board is an accessible grid with one Tab stop. Squares announce their name,
piece, and state, including selection, legal moves, captures, check, and last move.
Review and Train use the same grid navigation; the Review board is read-only.

| Key on the board | Action |
| --- | --- |
| Tab | Enter or leave the board |
| Arrow keys | Move focus one square in the visible direction, including when flipped |
| Home / End | Move to the first / last square in the current row |
| Enter / Space | Select a piece or make a legal move in Play |

The replay controls also support arrow, Home, and End navigation when you are
browsing the game history.

## Clocks and endings

Time controls use starting minutes plus an increment in seconds: 5+3 means
five minutes per player, with three seconds added after each move. The other
options are 15+10 and 30+20. The computer uses the same clocks as the player.

Replay keeps the live clocks running and displays a separate snapshot for the
viewed move. It returns to the live position when the side to move reaches
20 seconds. Review, Train, and Progress show a live-clock banner that returns
you to Play. Hiding or reloading the app does not refund thinking time.

Running out of time normally loses the game. It is a draw when the opponent
cannot possibly checkmate by any legal sequence, even with help from the
flagging player. A move or promotion submitted after time expires is not played.

Chessy detects checkmate, stalemate, and dead positions, including insufficient
mating material. For casual play, it applies threefold repetition and the
50-move rule automatically. FIDE rules normally require a claim for those draws;
their automatic thresholds are five repetitions and 75 moves.

Resign and Offer draw open a confirmation that freezes the clock and computer
search. Confirming records the resignation or agreed draw. These results remain
scored games in Review and in exported PGNs.

## Review a game

Review contains finished games, abandoned games with moves, and imported games.
Choose a game and select a move in its history to inspect the position before
that move. Custom starting positions retain their original move numbers.

### Find moments to revisit

Start scan screens the game's moves and suggests at most two decisions from
the chosen player's side. For an imported game with an unknown player side,
choose White, Black, or Both. Scanning is unavailable during a live timed game.

You can pause and resume a scan, including after reloading. An interrupted or
unusable deep check is recomputed when you resume. A changed analysis profile
can also require a fresh scan.

Suggestions initially show only move locations. Scores, judgments, and
alternative lines stay hidden until you submit the reflection questions.
Reflecting on a suggestion reveals that move first; reflecting on every
suggestion unlocks the scanned score trail. If the scan suggests no moments but
produced usable scores, flag and reflect on one analyzed move to unlock the
trail. Saved reflections remain tied to the exact game and position, so editing
the source game can invalidate an unlock.

### Reflect and save a lesson

1. Open a suggestion or select one of your decisions and choose Flag this moment.
2. Record the threat you saw, candidate moves, calculated line, and evaluation.
3. Choose Ask Chessy (one probe) to compare your thinking with its lines.
4. Choose a cause, write a reusable one-sentence lesson, and Save lesson card.

You decide whether there is a lesson. “My move was also sound” is a supported
cause, and choosing a different move from Chessy does not by itself make yours
wrong. Revising your answers and probing again updates the same moment's card
instead of creating duplicates. Each probe keeps the answers submitted for it.

### Read analysis carefully

Analysis scores use White's point of view: positive favors White, negative
favors Black. Quick scan values carry `≈`. Chessy's `?!`, `?`, and `??` marks
require stable, deep-confirmed evidence; move-quality annotations imported from
a PGN carry a separate PGN badge. Unresolved moves have no invented score.

Deep analysis first searches for up to 16 seconds, then verifies legal moves
at increasing depths under a shared work limit. Its displayed verified depth
is the deepest depth completed for every legal move, which can be lower than
the initial search depth. The verification phase takes additional time.

Deeper work does not guarantee a better answer in every position. If the
initial search and verification disagree, Chessy withholds automatic mistake
marks and suggestions from that result. A manual probe still lets you inspect
the lines. A partial result may contain only the initial search's best move.

Only one interactive analysis runs at a time. Progress shows elapsed time and
completed work; Cancel Verify stops it. Slow devices can reach the timeout.

## Train and track progress

Train replays due lesson cards. Try your move, inspect the saved lesson or live
check, and choose your own grade. A move outside the saved accepted set is
reported as different and unjudged until it has supporting evidence.

Cards use a fixed schedule of 1, 3, 7, 14, 30, and 90 days.

| Grade | Next review |
| --- | --- |
| Good | Advance one step in the schedule |
| Hard | Repeat the current step |
| Again | Retry in ten minutes |

The due queue refreshes when you open Train or press Refresh. It does not
update on a background timer. A malformed card is skipped separately so other
valid cards remain available.

Progress shows archived games, cards, cards due now, reviews in the last
30 days, and your chosen causes. Its first-try match count means exactly
“matched Chessy's saved move”; it is not an overall accuracy or strength rating.

## Save, import, and back up

The current game saves automatically across reloads and app restarts. Finished
and abandoned games enter the Review archive with their clocks and available
computer-search evidence. A failed archive write is reported in the game-over
dialog or a page notice; a failed New game checkpoint appears in that dialog.

| Control | What it saves or changes |
| --- | --- |
| Save PGN | One game in standard chess notation, including retained imported tags and annotations |
| Save PGN + log | The game plus position, clock, release, and engine-search details for troubleshooting |
| Import PGN… | One pasted or uploaded game, validated for legality and checked for duplicates |
| Back up (JSON) | Archived games, lesson cards, structured reflections, and their provenance |
| Restore… | Replace the archive with a validated JSON backup after confirmation |
| Delete all data… | Permanently remove the training archive after confirmation |

**Restore replaces the existing archive.** Save a backup first if you need to
keep it. PGN is useful for sharing games; JSON preserves Chessy's coaching data.
Bulk import and a remote language coach are not available.

A corrupted current-game save falls back to a fresh game. Invalid archived
games are skipped with a visible count and retained for recovery. Progress
also shows storage usage and persistence status. Browser storage can still be
evicted, so persistent storage does not replace a downloaded backup.

## Install, use offline, and recover

Load Chessy online and wait for the footer to report Ready offline. You can
then play without a network connection and install the app through your
browser's home-screen or desktop install option.

The header shows the running release. The footer distinguishes caching,
offline readiness, updating, failure, and unsupported offline storage. Chessy
checks for updates when you return to a long-open tab and before New game or
Rematch. An update can reload the app and restore your current game; saved games
and training data are preserved. A failed update check does not block offline play.

If the computer worker fails, Chessy retries the same position once. A second
failure leaves the position unchanged and shows a manual Retry action. For an
unexpected move or repeated failure, export Save PGN + log and include the
release shown in the header when [reporting an issue](https://github.com/den-run-ai/chessy/issues).
