/*
 * Canonical, JSON-safe Play telemetry.
 *
 * This is deliberately independent of either search implementation. Saved
 * games and backup rows may outlive many releases, so callers use the same
 * boundary when recording a fresh Rust/WASM result and when restoring older
 * JavaScript-era evidence. Missing new fields stay null; the original
 * depth/quiesce/ms trio remains readable for backwards compatibility.
 */
'use strict';
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.ChessyAiTelemetry = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  function sanitizeTelemetry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    function integer(v) {
      return Number.isInteger(v) && v >= 0 ? v : null;
    }
    function finite(v) {
      return Number.isFinite(v) ? v : null;
    }
    function releaseToken(v) {
      return typeof v === 'string' && v.length <= 32 && v.trim() === v &&
        /^r\d+$/.test(v)
        ? v : null;
    }
    const elapsed = finite(value.elapsedMs);
    const legacyMs = finite(value.ms);
    const reasons = {
      'max-depth': true, 'time-limit': true, 'node-limit': true,
      mate: true, 'game-over': true, unknown: true
    };
    // `sync` and `sync-fallback` remain accepted only because historical
    // saves and PGNs legitimately contain them. New Play searches are worker
    // + WASM only.
    const sources = { worker: true, sync: true, 'sync-fallback': true, unknown: true };
    const pv = Array.isArray(value.pvUci)
      ? value.pvUci.slice(0, 64).filter(function (u) {
        return typeof u === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u);
      })
      : [];
    const rootSeen = Object.create(null);
    const rootOrder = Array.isArray(value.rootOrderUci)
      ? value.rootOrderUci.slice(0, 256).filter(function (u) {
        if (typeof u !== 'string' ||
            !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u) || rootSeen[u]) return false;
        rootSeen[u] = true;
        return true;
      })
      : [];
    const fallbackReasons = {
      'worker-error': true, watchdog: true
    };
    // JavaScript and its WASM-fallback labels are legacy provenance. Keep
    // accepting them so old saves/backups can still be restored and exported.
    const engines = { js: true, wasm: true };
    const engineFallbacks = {
      'wasm-load-error': true, 'wasm-search-error': true
    };
    const sanitized = {
      release: releaseToken(value.release),
      depth: integer(value.depth) || 0,
      attemptedDepth: integer(value.attemptedDepth),
      maxDepth: integer(value.maxDepth),
      quiesce: !!value.quiesce,
      timeMs: integer(value.timeMs),
      nodeLimit: integer(value.nodeLimit),
      seed: Number.isInteger(value.seed) ? value.seed | 0 : null,
      randomize: typeof value.randomize === 'boolean' ? value.randomize : null,
      // `ms` is retained because older debug PGNs and saves already expose it.
      // `elapsedMs` names its end-to-end meaning; searchMs excludes worker
      // startup/retry delay when the engine was able to report it.
      ms: Math.max(0, elapsed != null ? elapsed : (legacyMs != null ? legacyMs : 0)),
      elapsedMs: Math.max(0, elapsed != null ? elapsed : (legacyMs != null ? legacyMs : 0)),
      searchMs: finite(value.searchMs) == null ? null : Math.max(0, finite(value.searchMs)),
      nodes: integer(value.nodes),
      qnodes: integer(value.qnodes),
      cutoffs: integer(value.cutoffs),
      researches: integer(value.researches),
      score: finite(value.score),
      scorePov: value.scorePov === 'white' ? 'white' : null,
      pvUci: pv,
      pvSource: value.pvSource === 'final-tt-best-effort'
        ? 'final-tt-best-effort' : null,
      stopReason: reasons[value.stopReason] ? value.stopReason : 'unknown',
      source: sources[value.source] ? value.source : 'unknown',
      fallbackReason: fallbackReasons[value.fallbackReason]
        ? value.fallbackReason : null,
      // Missing engine provenance predates WASM and therefore means JS.
      engine: engines[value.engine] ? value.engine : 'js',
      engineFallback: (!engines[value.engine] || value.engine === 'js') &&
        engineFallbacks[value.engineFallback]
        ? value.engineFallback : null
    };
    // Missing rootOrderUci is the backwards-compatible marker for telemetry
    // recorded before reproducible root capture existed. Preserve that
    // distinction from an explicitly present [].
    if (Array.isArray(value.rootOrderUci)) {
      sanitized.rootOrderUci = rootOrder;
    }
    return sanitized;
  }

  return Object.freeze({
    sanitizeTelemetry: sanitizeTelemetry
  });
});
