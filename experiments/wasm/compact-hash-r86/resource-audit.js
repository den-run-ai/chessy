#!/usr/bin/env node
'use strict';
// Static linear-memory stack accounting for the exact reviewed WASM bytes.
// This does not measure the browser's native/operand stack or physical devices.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ROOT = path.resolve(__dirname, '../../..');
// These identities belong only to the combined seeded-engine preparation.
// Historical unseeded compact-hash source/module records remain unchanged.
const MODULES = {
  baseline: {
    commit: '3b32d2e7c23341d2245003c5324aa2ee6d07aa08',
    wasmSha256: 'a18affeb07590eaf5610c01a73701d745a05e1ed3f53a257ccc93c4176bd96d7',
    sourceSha256: {
      'experiments/wasm/src/search.rs': '9f8f2a798c26e7c4ff22cbc8b4605ed72fd17eadfc8bf9305747bf7ec40194b5',
      'experiments/wasm/src/lib.rs': 'c05fa66c239fdf4e38bf4912cd1491be1c57146b0670e71a340af8e586e8cd15'
    }
  },
  candidate: {
    commit: '173e06fd29f587f7de1ab9a84ad990760d7f23ae',
    wasmSha256: '4f63b8dd25b4ae6787d1720392417a60daab1066bef7d494060939cb2016f74c',
    sourceSha256: {
      'experiments/wasm/src/search.rs': '4db05a27ae42560d6f45920859f9916eb84d0df3d59ab3eca95a4e53ed75ffc4',
      'experiments/wasm/src/lib.rs': 'c05fa66c239fdf4e38bf4912cd1491be1c57146b0670e71a340af8e586e8cd15'
    }
  }
};

function account(wat, bytes, label) {
  assert.ok(Object.hasOwn(MODULES, label), 'unknown reviewed module');
  assert.equal(sha(bytes), MODULES[label].wasmSha256);
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)),
    [{ module: 'env', name: 'now_ms', kind: 'function' }]);
  assert.match(wat, /^ \(global \$global\$0 \(mut i32\) \(i32.const 1048576\)\)$/m);
  assert.equal((wat.match(/^ \(global /gm) || []).length, 1);
  assert.match(wat, /^ \(memory \$0 405 405\)$/m);
  assert.doesNotMatch(wat, /\((call_indirect|call_ref|return_call|memory\.grow)\b/);
  const functions = wat.split(/(?=^ \(func )/m).slice(1).map(body => {
    const id = body.match(/^ \(func (\$\S+)/)[1];
    const flat = body.replace(/\s+/g, ' ').replace(/\s+\)/g, ')');
    const decrements = [...flat.matchAll(/\(i32.sub \(global.get \$global\$0\) \(i32.const (\d+)\)\)/g)].map(m => Number(m[1]));
    assert.equal(decrements.length, (body.match(/\(global.get \$global\$0\)/g) || []).length,
      id + ': unknown stack-pointer read');
    const allocations = [...flat.matchAll(/\(global.set \$global\$0 \(local.tee (\$[^ ]+) \(i32.sub \(global.get \$global\$0\) \(i32.const (\d+)\)\)\)\)/g)];
    const restores = [...flat.matchAll(/\(global.set \$global\$0 \(i32.add \(local.get (\$[^ ]+)\) \(i32.const (\d+)\)\)\)/g)];
    assert.equal(allocations.length + restores.length, (body.match(/\(global.set \$global\$0\b/g) || []).length,
      id + ': unknown stack-pointer write');
    assert.ok(allocations.length <= 1, id + ': nested dynamic stack allocation needs separate analysis');
    for (const allocation of allocations) {
      assert.ok(restores.length > 0, id + ': missing stack restoration');
      const local = allocation[1], amount = Number(allocation[2]);
      assert.ok(amount > 0 && amount % 16 === 0);
      assert.equal([...flat.matchAll(/\(local\.(?:set|tee) (\$[^ ]+)/g)].filter(m => m[1] === local).length, 1,
        id + ': saved stack base overwritten');
      for (const restore of restores) {
        assert.equal(restore[1], local); assert.equal(Number(restore[2]), amount);
      }
    }
    if (!allocations.length) assert.equal(restores.length, 0);
    const calls = [...new Set([...body.matchAll(/\(call (\$[^\s()]+)/g)].map(m => m[1]))].sort();
    return { id, decrements, conservativeFrameBytes: decrements.reduce((sum, n) => sum + n, 0), calls };
  });
  const byId = new Map(functions.map(f => [f.id, f]));
  const entrypoints = Object.fromEntries(['search', 'search_seeded', 'fixed_search', 'analysis_root'].map(name => {
    const match = wat.match(new RegExp('^ \\(export "' + name + '" \\(func (\\$[^ )]+)\\)\\)$', 'm'));
    assert.ok(match, 'missing admitted entry point: ' + name);
    assert.ok(byId.has(match[1]), 'unknown exported function: ' + name);
    return [name, match[1]];
  }));
  // The ordinary entry adds no linear-stack frame before forwarding the
  // unchanged deterministic seed to the guarded seeded search entry.
  assert.equal(byId.get(entrypoints.search).conservativeFrameBytes, 0);
  assert.deepEqual(byId.get(entrypoints.search).calls, [entrypoints.search_seeded]);
  const recursive = functions.filter(f => f.calls.includes(f.id));
  assert.deepEqual(recursive.map(f => f.id), ['$8', '$12']);
  for (const fn of recursive) assert.deepEqual(fn.decrements, [32]);
  // Removing the two direct self-edges must leave a DAG: no hidden mutual
  // recursion, repeated helper frame or callback into exported search exists.
  const active = new Set(), done = new Set();
  function visit(id) {
    if (id === '$fimport$0' || done.has(id)) return;
    assert.ok(byId.has(id), 'unknown call target: ' + id);
    assert.ok(!active.has(id), 'unexpected call-graph cycle: ' + id);
    active.add(id);
    for (const child of byId.get(id).calls) if (child !== id) visit(child);
    active.delete(id); done.add(id);
  }
  for (const fn of functions) visit(fn.id);
  const nonrecursiveBytes = functions.filter(f => !recursive.includes(f)).reduce((sum, f) => sum + f.conservativeFrameBytes, 0);
  // The unchanged ABI admits depth <=111. Fixed search has at most 112 search
  // frames (depth 111 through 0), then 17 qsearch frames (qply 0 through 16).
  // Ordinary/exact-root search starts at ply 1 and has no larger chain.
  const maximumRecursiveFrames = 112 + 17;
  const conservativeStackBytes = nonrecursiveBytes + maximumRecursiveFrames * 32;
  assert.ok(conservativeStackBytes < 1048576);
  return { label, sourceCommit: MODULES[label].commit, wasmSha256: sha(bytes), wasmBytes: bytes.length, disassemblySha256: sha(Buffer.from(wat)),
    memoryInitialPages: 405, memoryMaximumPages: 405, memoryBytes: 26542080,
    reservedLinearStackBytes: 1048576, entrypoints, functions, recursiveFunctionIds: recursive.map(f => f.id),
    maximumRecursiveFrames, nonrecursiveBytes, conservativeLinearStackBoundBytes: conservativeStackBytes,
    reservationFraction: conservativeStackBytes / 1048576 };
}

function audit(candidateFile, disassembler) {
  function gitBytes(commit, filename) {
    return cp.execFileSync('git', ['--no-replace-objects', '-C', ROOT, 'show',
      commit + ':' + filename], { maxBuffer: 1024 * 1024 });
  }
  const sources = {}, buffers = {};
  for (const [label, spec] of Object.entries(MODULES)) {
    const sourceSha256 = {};
    for (const [filename, expected] of Object.entries(spec.sourceSha256)) {
      sourceSha256[filename] = sha(gitBytes(spec.commit, filename));
      assert.equal(sourceSha256[filename], expected, label + ' ' + filename + ': reviewed depth/ABI argument changed');
    }
    sources[label] = { commit: spec.commit, sha256: sourceSha256 };
    buffers[label] = gitBytes(spec.commit, 'assets/chessy-ai-fast.wasm');
    assert.equal(sha(buffers[label]), spec.wasmSha256, label + ': reviewed Git module changed');
  }
  const candidate = fs.readFileSync(candidateFile);
  assert.ok(candidate.equals(buffers.candidate), 'candidate build differs from the reviewed source-commit module');
  const version = cp.execFileSync(disassembler, ['--version'], { encoding: 'utf8' }).trim();
  assert.match(version, /^wasm-dis version 131(?: \(version_131\))?$/);
  const modules = [['baseline', buffers.baseline], ['candidate', candidate]].map(([label, bytes]) => {
    const wat = cp.execFileSync(disassembler, ['-'], { input: bytes, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return account(wat, bytes, label);
  });
  return { schema: 'chessy.compact-hash-r86.static-resources.v1', sources,
    auditorSha256: sha(fs.readFileSync(__filename)),
    disassembler: { version, sha256: sha(fs.readFileSync(disassembler)) }, modules,
    scope: 'conservative static linear-memory stack accounting for exact seeded baseline and combined candidate; no execution timing',
    assumptions: ['admitted ABI depth <=111 and qply <=16', 'standard env.now_ms returns without re-entering WASM',
      'valid execution follows the inspected generated call graph and fixed frame/restoration forms',
      'normal calls restore the stack; trapped instances are not reused'],
    physicalDeviceEvidence: false, browserNativeStackBoundProven: false, productionAdmissionGranted: false };
}

module.exports = { account, audit };
if (require.main === module) {
  assert.equal(process.argv.length, 4, 'usage: resource-audit.js CANDIDATE_WASM PINNED_WASM_DIS');
  console.log(JSON.stringify(audit(path.resolve(process.argv[2]), path.resolve(process.argv[3])), null, 2));
}
