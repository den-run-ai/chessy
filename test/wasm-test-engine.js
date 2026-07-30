/*
 * Synchronous Node bridge to the shipped Rust/WASM engine.
 *
 * Production always owns its module inside a Worker. Tests and offline
 * scorecards run synchronously, so they share one local instance and inject it
 * into analysis-core explicitly. This file contains ABI plumbing only; no
 * chess search or evaluation algorithm lives in JavaScript.
 */
'use strict';

const fs = require('fs');
const path = require('path');

require('../assets/engine.js');
const WasmEngine = require('../assets/wasm-engine.js');

const WASM_PATH = path.join(__dirname, '..', 'assets', 'chessy-ai-fast.wasm');
const bytes = fs.readFileSync(WASM_PATH);
const engine = WasmEngine.loadSync(bytes);

function hydrateMove(state, move) {
  if (!move) return null;
  const legal = globalThis.Chess.legalMoves(state).find(function (candidate) {
    return candidate.from === move.from &&
      candidate.to === move.to &&
      (candidate.promotion || null) === (move.promotion || null);
  });
  if (!legal) {
    throw new Error('Rust/WASM returned a move that is not legal in the loaded position');
  }
  return legal;
}

function installAnalysisEngine() {
  if (!globalThis.ChessyAnalysisCore ||
      typeof globalThis.ChessyAnalysisCore.setEngineForTests !== 'function') {
    throw new Error('load assets/analysis-core.js before installing its WASM engine');
  }
  globalThis.ChessyAnalysisCore.setEngineForTests(engine);
  return engine;
}

function searchState(state, opts) {
  opts = Object.assign({}, opts || {});
  if (!Object.prototype.hasOwnProperty.call(opts, 'positions')) {
    opts.positions = state.positions || null;
  }
  const result = engine.search(globalThis.Chess.toFen(state), opts);
  result.move = hydrateMove(state, result.move);
  return result;
}

function fixedSearchState(state, opts) {
  opts = Object.assign({}, opts || {});
  if (!Object.prototype.hasOwnProperty.call(opts, 'positions')) {
    opts.positions = state.positions || null;
  }
  return engine.fixedSearch(globalThis.Chess.toFen(state), opts);
}

function evaluateState(state) {
  return engine.evaluate(globalThis.Chess.toFen(state));
}

module.exports = {
  WasmEngine: WasmEngine,
  WASM_PATH: WASM_PATH,
  bytes: bytes,
  engine: engine,
  installAnalysisEngine: installAnalysisEngine,
  searchState: searchState,
  fixedSearchState: fixedSearchState,
  evaluateState: evaluateState
};
