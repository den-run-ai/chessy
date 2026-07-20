/*
 * Chessy archive — records finished games into the coaching store
 * (assets/store.js). This is the whole slice: no UI reads the archive yet;
 * the Review browser, reflection, and spaced review build on it next
 * (roadmap #23).
 *
 * record() is IDEMPOTENT per game instance: the record's key is the
 * game's UUID (minted at New game/Rematch in app.js and persisted with
 * the saved game), so re-offering the same ending — reopened game-over
 * dialog, reload → undo → replayed finish, the boot reconcile in app.js —
 * simply overwrites the one record (keeping its original createdAt). A
 * DIFFERENT completion under the same key (cloned tabs that diverged) is
 * stored under a fresh id instead, so no finished game is ever lost.
 */
(function () {
  'use strict';
  if (typeof CoachStore === 'undefined' || typeof Chess === 'undefined') return;

  // Resolves with the stored game id (which may differ from gameId when a
  // cloned tab already archived a divergent completion — see
  // CoachStore.archiveGame), or rejects when the write failed — the caller
  // surfaces that (a training archive that silently drops games would
  // corrupt every later statistic). A zero-ply game is still archived:
  // a timed game can be forfeit on time before the first move.
  function record(state, settings, status, gameId) {
    if (!gameId || !status.over) {
      return Promise.resolve(null);
    }
    return CoachStore.archiveGame({
      id: gameId,
      source: 'play',
      tags: {},
      sans: state.history.map(function (h) { return h.san; }),
      // The side the human played — later slices focus feedback on it.
      playerColor: settings.mode === 'ai-b' ? 'w' : settings.mode === 'ai-w' ? 'b' : 'both',
      // Per-move clock evidence ({thinkMs, wMs, bMs} or null): retained so
      // efficiency/impulse diagnoses have data behind them.
      clocks: state.history.map(function (h) { return h.clock || null; }),
      result: status.result,
      reason: status.reason,
      mode: settings.mode,
      difficulty: settings.difficulty,
      timeControl: settings.timeControl,
      plies: state.history.length,
      createdAt: Date.now()
    });
  }

  window.ChessyArchive = { record: record };
})();
