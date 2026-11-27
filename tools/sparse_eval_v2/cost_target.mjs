#!/usr/bin/env node
// Isolated WASM timing child. Configuration and binary identities are bound by cost.py.
import fs from 'node:fs/promises';
import { WasmEvaluator } from './wasm_runner.mjs';

const [modulePath, weightsPath, variant, rulesPath, rootsPath, configPath, action, nodesText, replicateText] = process.argv.slice(2);
if (!replicateText || !['search', 'static'].includes(action)) throw new Error('invalid cost child arguments');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const roots = JSON.parse(await fs.readFile(rootsPath, 'utf8'));
const replicate = Number(replicateText), nodes = Number(nodesText);
const engine = await WasmEvaluator.open(modulePath, weightsPath, variant, rulesPath);
const emit = x => process.stdout.write(JSON.stringify(x) + '\n');
emit({ kind: 'metadata', ...engine.info() });
const ordered = replicate % 2 ? [...roots].reverse() : roots;
if (action === 'static') {
  engine.loadPositions(ordered.map(x => x.fen));
  const baseline = engine.evaluate(0), candidate = engine.evaluate();
  for (const mode of (replicate % 2 ? ['candidate', 'hce'] : ['hce', 'candidate'])) {
    const code = mode === 'hce' ? 0 : engine.variant;
    engine.benchmark(config.staticWarmupPasses, code);
    engine.clearCache();
    const result = engine.benchmark(config.staticPasses, code);
    const expected = BigInt((mode === 'hce' ? baseline : candidate).reduce((a, b) => a + b, 0)) * BigInt(config.staticPasses);
    if (BigInt(result.checksum) !== expected) throw new Error('static checksum mismatch');
    emit({ kind: 'static', mode, replicate, ...result });
  }
} else {
  engine.loadPositions(config.warmupFens);
  for (let cycle = 0; cycle < config.searchWarmupCycles; ++cycle) {
    for (let index = 0; index < config.warmupFens.length; ++index) {
      for (const code of [0, engine.variant]) {
        engine.loadHistory([]);
        engine.search({ index, variant: code, nodes: config.searchWarmupNodes, depth: config.maximumDepth });
      }
    }
  }
  engine.loadPositions(ordered.map(x => x.fen));
  for (let index = 0; index < ordered.length; ++index) {
    for (const mode of ((index + replicate) % 2 ? ['candidate', 'hce'] : ['hce', 'candidate'])) {
      engine.loadHistory([]);
      const result = engine.search({ index, variant: mode === 'hce' ? 0 : engine.variant, nodes, depth: config.maximumDepth });
      emit({ kind: 'search', root: ordered[index].id, phase: ordered[index].phase,
        mode, replicate, requested_nodes: nodes, ...result });
    }
  }
}
