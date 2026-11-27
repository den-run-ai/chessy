#!/usr/bin/env node
/** Offline ABI-v2 host. JavaScript supplies rules and transport, never search. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
let loaderPath, rulesPath;
const modulePaths = new Map();
for (let i = 0; i < args.length; i += 2) {
  const value = args[i + 1];
  if (!value) throw new Error('every argument requires a value');
  if (args[i] === '--loader' && !loaderPath) loaderPath = path.resolve(value);
  else if (args[i] === '--rules' && !rulesPath) rulesPath = path.resolve(value);
  else if (args[i] === '--wasm') {
    const match = /^([a-z][a-z0-9-]*)=(.+)$/.exec(value);
    if (!match || modulePaths.has(match[1])) throw new Error('invalid or duplicate module alias');
    modulePaths.set(match[1], path.resolve(match[2]));
  } else throw new Error('unknown or duplicate argument: ' + args[i]);
}
if (!loaderPath || !rulesPath || !modulePaths.size) throw new Error('loader, rules, and modules are required');

// Compile exactly the bytes hashed below, without a second filesystem read.
function loadCommonJs(filename, bytes) {
  const module = { exports: {} };
  const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', bytes.toString('utf8'));
  fn(module, module.exports, require, filename, path.dirname(filename));
  return module.exports;
}
const loaderBytes = fs.readFileSync(loaderPath), rulesBytes = fs.readFileSync(rulesPath);
loadCommonJs(rulesPath, rulesBytes);
const Chess = globalThis.Chess;
const Loader = loadCommonJs(loaderPath, loaderBytes);
if (!Chess || Loader.ABI_VERSION !== 2) throw new Error('expected production rules and ABI v2');
const engines = new Map(), identities = {};
for (const [name, filename] of modulePaths) {
  const bytes = fs.readFileSync(filename);
  const started = performance.now();
  const engine = Loader.loadSync(bytes);
  const loadMs = performance.now() - started;
  engines.set(name, engine);
  identities[name] = { sha256: digest(bytes), bytes: bytes.length, memoryBytes: engine.memoryBytes(), loadMs };
}

function uci(move) {
  return move ? Chess.sqName(move.from) + Chess.sqName(move.to) + (move.promotion || '').toLowerCase() : null;
}
function legalUcis(state) { return Chess.legalMoves(state).map(uci).sort(); }
function position(fen, history) {
  if (typeof fen !== 'string' || !Array.isArray(history) || !history.length || history.at(-1) !== fen)
    throw new Error('full history must end with the exact current FEN');
  const state = Chess.newGameState(fen), positions = Object.create(null);
  state.positions = Object.create(null);
  for (const past of history) {
    if (typeof past !== 'string' || /[\r\n]/.test(past)) throw new Error('invalid history FEN');
    positions[past] = (positions[past] || 0) + 1;
    const key = Chess.positionKey(Chess.newGameState(past));
    state.positions[key] = (state.positions[key] || 0) + 1;
  }
  if (Chess.toFen(state) !== fen) throw new Error('noncanonical FEN');
  return { state, positions };
}
function replay(moves) {
  if (!Array.isArray(moves)) throw new Error('replay requires a complete UCI move list');
  let state = Chess.newGameState();
  const historyFens = [Chess.toFen(state)];
  for (const token of moves) {
    if (Chess.gameStatus(state).over) throw new Error('replay continued after terminal state');
    const move = Chess.legalMoves(state).find(candidate => uci(candidate) === token);
    if (!move) throw new Error('illegal replay move: ' + token);
    state = Chess.playMove(state, move);
    historyFens.push(Chess.toFen(state));
  }
  return { fen: Chess.toFen(state), historyFens, status: Chess.gameStatus(state), legalUcis: legalUcis(state) };
}
function handle(request) {
  if (!request || !['number', 'string'].includes(typeof request.id)) throw new Error('request identity required');
  if (request.op === 'info') return { result: {
    abiVersion: Loader.ABI_VERSION, nodeVersion: process.version, v8Version: process.versions.v8,
    execArgv: process.execArgv, engines: identities, loaderSha256: digest(loaderBytes), rulesSha256: digest(rulesBytes)
  } };
  if (request.op === 'replay') return { result: replay(request.moves) };
  const engine = engines.get(request.engine);
  if (!engine) throw new Error('unknown engine alias');
  if (request.op === 'evaluate') {
    if (typeof request.fen !== 'string') throw new Error('FEN is required');
    return { result: { score: engine.evaluate(request.fen), scorePov: 'white' } };
  }
  if (request.op !== 'search' && request.op !== 'root') throw new Error('unknown operation');
  const { state, positions } = position(request.fen, request.historyFens);
  const legal = legalUcis(state);
  const options = { maxDepth: request.maxDepth, nodeLimit: request.nodeLimit, timeMs: request.timeMs,
    rootSeed: request.rootSeed, quiesce: request.quiesce !== false, positions };
  const started = performance.now();
  let result;
  if (request.op === 'root') {
    if (request.timeMs != null && request.timeMs !== 0)
      throw new Error('exact-root ABI supports a node budget, not a wall-clock deadline');
    const move = Chess.legalMoves(state).find(candidate => uci(candidate) === request.uci);
    if (!move) throw new Error('illegal exact root');
    engine.beginAnalysis(request.fen, options);
    result = engine.searchRoot(move, request.maxDepth, request.pvLen || request.maxDepth);
  } else result = engine.search(request.fen, options);
  const engineCallMs = performance.now() - started;
  const selected = uci(result.move);
  if (selected !== null && !legal.includes(selected)) throw new Error('engine returned an illegal move');
  return { result: { ...result, uci: selected, engineCallMs }, rules: {
    fen: Chess.toFen(state), legalUcis: legal, status: Chess.gameStatus(state)
  } };
}

// Requests execute sequentially. Errors are retained by the caller; no retries.
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try {
    request = JSON.parse(line);
    const response = handle(request);
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, ...response }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: request?.id ?? null, ok: false,
      error: { name: error.name, message: error.message, code: error.code || null } }) + '\n');
  }
}
