/*
 * Shipped Play difficulty presets.
 *
 * The IDs are durable storage values from the original depth-based ladder;
 * changing them would break saved games and archive metadata. Ratings are
 * external-engine calibration TARGETS, not certified FIDE/server ratings.
 */
'use strict';
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.ChessyLevelPresets = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const LEVELS = Object.freeze({
    1: Object.freeze({
      label: 'Easy', target: '1500', maxDepth: 30,
      nodeLimit: 10000, timeMs: 5000, quiesce: true
    }),
    2: Object.freeze({
      label: 'Medium', target: '1700', maxDepth: 30,
      nodeLimit: 36000, timeMs: 5000, quiesce: true
    }),
    3: Object.freeze({
      label: 'Hard', target: '1900', maxDepth: 30,
      nodeLimit: 230000, timeMs: 5000, quiesce: true
    }),
    5: Object.freeze({
      label: 'Expert', target: '2100', maxDepth: 30,
      nodeLimit: 1440000, timeMs: 5000, quiesce: true
    }),
    master: Object.freeze({
      label: 'Master', target: '2300+', maxDepth: 30,
      nodeLimit: null, timeMs: 5000, quiesce: true
    })
  });
  const ORDER = Object.freeze(['1', '2', '3', '5', 'master']);

  function get(id) {
    return LEVELS[String(id)] || null;
  }

  return Object.freeze({
    LEVELS: LEVELS,
    ORDER: ORDER,
    get: get
  });
});
