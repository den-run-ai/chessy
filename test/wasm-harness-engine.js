/*
 * Revision-aware Node loader for developer performance and match harnesses.
 *
 * Each side is loaded from its own checked-in assets/wasm-engine.js and
 * assets/chessy-ai-fast.wasm. That keeps cross-revision comparisons honest
 * across the ABI-v1 -> ABI-v2 transition without embedding chess search or
 * evaluation logic in the harness.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
const performance = require('perf_hooks').performance;

const ROOT = path.join(__dirname, '..');
const LOADER_PATH = 'assets/wasm-engine.js';
const WASM_PATH = 'assets/chessy-ai-fast.wasm';

function readRevision(ref, file, encoding) {
  if (!ref) {
    return fs.readFileSync(path.join(ROOT, file), encoding);
  }
  try {
    return cp.execFileSync('git', ['show', ref + ':' + file], {
      encoding: encoding,
      maxBuffer: 1 << 27,
      cwd: ROOT
    });
  } catch (error) {
    throw new Error('revision "' + ref + '" does not contain ' + file +
      '; choose a Rust/WASM engine revision (' + error.message + ')');
  }
}

async function loadRevision(ref) {
  const source = readRevision(ref, LOADER_PATH, 'utf8');
  const bytes = readRevision(ref, WASM_PATH, null);
  const context = vm.createContext({
    console: console,
    performance: performance,
    TextEncoder: TextEncoder,
    WebAssembly: WebAssembly
  });
  vm.runInContext(source, context, { filename: (ref || 'worktree') + ':' + LOADER_PATH });
  if (!context.WasmEngine || typeof context.WasmEngine.load !== 'function') {
    throw new Error('revision "' + (ref || 'worktree') +
      '" does not expose WasmEngine.load()');
  }
  const engine = await context.WasmEngine.load(bytes);
  return {
    abiVersion: context.WasmEngine.ABI_VERSION,
    label: ref || 'worktree',
    memoryBytes: engine.memoryBytes,
    search: engine.search
  };
}

function moveName(move) {
  if (!move) return '-';
  function squareName(square) {
    return 'abcdefgh'[square % 8] + (8 - Math.floor(square / 8));
  }
  return squareName(move.from) + squareName(move.to) + (move.promotion || '');
}

module.exports = {
  loadRevision: loadRevision,
  moveName: moveName
};
