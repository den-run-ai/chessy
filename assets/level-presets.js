/*
 * Shipped Play difficulty presets.
 *
 * The IDs are durable storage values from the original depth-based ladder;
 * changing them would break saved games and archive metadata. Ratings are
 * external-engine calibration TARGETS, not certified FIDE/server ratings.
 *
 * r80 shifts the budgets up one label: an exploratory screen against pinned
 * Stockfish 18 (eval/level-screen-r80) placed each one about a label above
 * its target, so 10k/36k/230k nodes now serve Medium/Hard/Expert, the
 * 1.44M-node preset (already Master strength there) is dropped, and Easy is
 * Medium's 10k work cap limited to depth 2. Depth 1 fits in 10k nodes almost
 * always (about 9k in the tactical frozen family). In rare extreme quiescence
 * positions (about 1 move in 4,100-4,400 in the screen) it does not; the
 * engine then plays the best root it finished scoring, or its first ordered
 * root if none finished.
 */
'use strict';
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.ChessyLevelPresets = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const LEVELS = Object.freeze({
    1: Object.freeze({
      label: 'Easy', target: '1500', maxDepth: 2,
      nodeLimit: 10000, timeMs: 5000, quiesce: true
    }),
    2: Object.freeze({
      label: 'Medium', target: '1700', maxDepth: 30,
      nodeLimit: 10000, timeMs: 5000, quiesce: true
    }),
    3: Object.freeze({
      label: 'Hard', target: '1900', maxDepth: 30,
      nodeLimit: 36000, timeMs: 5000, quiesce: true
    }),
    5: Object.freeze({
      label: 'Expert', target: '2100', maxDepth: 30,
      nodeLimit: 230000, timeMs: 5000, quiesce: true
    }),
    master: Object.freeze({
      label: 'Master', target: '2300+', maxDepth: 111,
      nodeLimit: null, timeMs: 8000, quiesce: true
    })
  });
  const ORDER = Object.freeze(['1', '2', '3', '5', 'master']);

  function get(id) {
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    return Object.prototype.hasOwnProperty.call(LEVELS, id) ? LEVELS[id] : null;
  }

  // Preserve the provisional node targets, but never spend a fixed eight
  // seconds with less than that left on the clock. Budget for BOTH attempts:
  // a reported worker failure retries the identical request, not a new or
  // easier preset. (A silent worker is caught only by the page watchdog at
  // timeMs + 3 s, which a nearly empty clock cannot always cover.)
  // Zero means unlimited to WASM, so even an exhausted clock must never turn
  // into a zero-ms request. The page handles a flag before dispatch.
  function forClock(id, remainingMs, incrementMs) {
    const preset = get(id);
    if (!preset) return null;
    if (remainingMs == null) return preset;
    if (!Number.isFinite(remainingMs) || remainingMs < 0 ||
        !Number.isFinite(incrementMs) || incrementMs < 0) {
      throw new RangeError('clock budgets must be finite non-negative milliseconds');
    }
    const reserve = Math.min(1000, remainingMs / 2);
    const retrySafe = (remainingMs - reserve) / 2;
    const sustainable = remainingMs / 30 + incrementMs * 0.8;
    const timeMs = Math.max(1, Math.floor(Math.min(
      preset.timeMs, retrySafe, sustainable)));
    return Object.freeze(Object.assign({}, preset, { timeMs: timeMs }));
  }

  return Object.freeze({
    LEVELS: LEVELS,
    ORDER: ORDER,
    get: get,
    forClock: forClock
  });
});
