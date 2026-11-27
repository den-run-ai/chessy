#!/usr/bin/env node
'use strict';
// Capture and execute the exact generator/template bytes named by the receipt.
if (typeof __capturedCompactHash === 'undefined') {
  const fs = require('node:fs'), path = require('node:path');
  const files = ['prepare.js', 'paired-hash.rs.in', 'parity.rs.in'].map(name => ({
    name, file: path.join(__dirname, name), bytes: Buffer.from(fs.readFileSync(path.join(__dirname, name)))
  }));
  require('node:vm').compileFunction(files[0].bytes.toString().replace(/^#![^\n]*/, ''),
    ['require', 'module', 'exports', '__filename', '__dirname', '__capturedCompactHash'], { filename: __filename })
    (require, module, module.exports, __filename, __dirname, files);
} else {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const ROOT = path.resolve(__dirname, '../../..');
  const BASE = 'f65224dece688f23d00429c148715262dd3c9b79';
  const FILES = {
    'Cargo.toml': 'ce1d19882ccb2f19397ff0d35de49186a5e95b8fbe55764688479c32b86aec1c',
    'Cargo.lock': 'ea3c9270c862d324c05b5154683a064b19a165d69b38c905506e479de19a5a32',
    'rust-toolchain.toml': '9cbeb062ec3a97a5b5b76aacde94f5dcb034ed98f32af151480764de2e03d6f9',
    'build.sh': '68852d6684eb69c2dc6fd59947f6e88450aa298fb13be96d48f09e6c79612489',
    'src/engine.rs': '7bd7126c39fad50fe4fa7527fe857996391e46378491a21171b3928cf3d60103',
    'src/eval.rs': '3a107218a6d7a42f771022956fab04b28935a39867b74eaea911d27b2598a6b7',
    'src/lib.rs': 'f65850e8bf8064f90baad14c033a20db3fc94b326db608ce9959c397a81094bc',
    'src/search.rs': 'e13b53fdb744f8fb647ae9c74ebc5ea2289c6881ba676122336b3f93ec8671cd'
  };
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  function replace(source, before, after, count = 1) {
    check(source.split(before).length === count + 1, 'missing/ambiguous patch anchor: ' + before);
    return source.replaceAll(before, after);
  }
  function render(original, variant = 'threaded') {
    check(['threaded', 'shared-update', 'proven-indices'].includes(variant), 'unknown compact hash variant');
    const templates = Object.fromEntries(__capturedCompactHash.map(f => [f.name, f.bytes.toString()]));
    const start = original.indexOf('unsafe fn hash_position(');
    const end = original.indexOf('\n#[inline]\nfn history_start_index', start);
    check(start >= 0 && end > start, 'canonical hash function boundary missing');
    let hashTemplate = variant === 'shared-update'
      ? replace(templates['paired-hash.rs.in'], 'fn advance_board_hash(', '#[inline(never)]\nfn advance_board_hash(')
      : templates['paired-hash.rs.in'];
    if (variant === 'proven-indices') {
      hashTemplate = replace(hashTemplate,
        '        Z_PAIRS[piece_hash_index(piece) * 64 + square as usize]',
        '        // Private callers use a nonempty Piece (1..=12) and a board square\n' +
        '        // (0..64), so the largest index is 767, below Z_SIZE. Recursive\n' +
        '        // edges are legal moves; scans and castle squares are bounded.\n' +
        '        unsafe { *Z_PAIRS.get_unchecked(piece_hash_index(piece) * 64 + square as usize) }');
    }
    let out = original.slice(0, start) + hashTemplate + original.slice(end);
    out = replace(out, '    qply: usize,\n) -> i32 {', '    qply: usize,\n    board_hash: u64,\n) -> i32 {');
    out = replace(out, '    ply: usize,\n) -> i32 {', '    ply: usize,\n    board_hash: u64,\n) -> i32 {');
    out = replace(out, '        hash = hash_position(position);', '        hash = finish_board_hash(position, board_hash);');
    const searchStart = out.indexOf('unsafe fn search_node(');
    const searchEnd = out.indexOf('\nunsafe fn shuffle_root(', searchStart);
    let search = out.slice(searchStart, searchEnd);
    search = replace(search, '    let hash = hash_position(position);', '    let hash = finish_board_hash(position, board_hash);');
    search = replace(search, '        let mut score;\n        let mut child_rep;',
      '        let child_hash = advance_board_hash(position, mv, board_hash);\n        let mut score;\n        let mut child_rep;');
    search = search.replace(/search_node\(([^\n]+), ply \+ 1\)/g, 'search_node($1, ply + 1, child_hash)');
    search = replace(search, 'quiesce_node(position, alpha_initial, beta_initial, ply, 0)',
      'quiesce_node(position, alpha_initial, beta_initial, ply, 0, board_hash)');
    out = out.slice(0, searchStart) + search + out.slice(searchEnd);
    out = replace(out, '        let score = quiesce_node(position, alpha, beta, ply + 1, qply + 1);',
      '        let child_hash = advance_board_hash(position, mv, board_hash);\n' +
      '        let score = quiesce_node(position, alpha, beta, ply + 1, qply + 1, child_hash);');
    out = replace(out, '    let root_hash = hash_position(position);',
      '    let board_hash = scan_board_hash(position);\n    let root_hash = finish_board_hash(position, board_hash);', 2);
    out = replace(out, '    engine::make_move(&mut child, root_move);\n    let score = search_node(',
      '    engine::make_move(&mut child, root_move);\n' +
      '    let child_hash = advance_board_hash(&child, root_move, board_hash);\n    let score = search_node(');
    out = replace(out, '        SCORE_INF,\n        1,\n    );', '        SCORE_INF,\n        1,\n        child_hash,\n    );');
    out = replace(out, '    let score = search_node(position, depth as i32, -SCORE_INF, SCORE_INF, 0);',
      '    let board_hash = scan_board_hash(position);\n' +
      '    let score = search_node(position, depth as i32, -SCORE_INF, SCORE_INF, 0, board_hash);');
    out = replace(out, '                let undo = engine::make_move(position, mv);\n                let mut score;',
      '                let undo = engine::make_move(position, mv);\n' +
      '                let child_hash = advance_board_hash(position, mv, board_hash);\n                let mut score;');
    out = out.replace(/search_node\(([^\n]+), 1\)/g, 'search_node($1, 1, child_hash)');
    const pv = '\n#[cfg(test)] pub unsafe fn research_pv() -> std::vec::Vec<u32> { (0..PV_LENGTH).map(|i| *pv_entry(i)).collect() }\n';
    const oracle = '\npub unsafe fn research_hash(p: &mut Position) -> (u32,u32,u32,u32) { let h=hash_position(p); (h.h1,h.h2,h.r1,h.r2) }\n';
    return out + pv + '\n#[cfg(test)] mod reference_search {\n' + original + pv + oracle + '\n}\n' + templates['parity.rs.in'];
  }
  function prepare(destination, variant = 'threaded') {
    destination = path.resolve(destination);
    destination = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
    check(destination !== ROOT && !destination.startsWith(ROOT + path.sep), 'generated crate must be outside repository');
    const source = Object.fromEntries(Object.keys(FILES).map(p => [p, fs.readFileSync(path.join(ROOT, 'experiments/wasm', p))]));
    for (const [p, bytes] of Object.entries(source)) check(sha(bytes) === FILES[p], 'pinned source changed: ' + p);
    const unchanged = () => __capturedCompactHash.every(f => sha(fs.readFileSync(f.file)) === sha(f.bytes)) &&
      Object.entries(source).every(([p, b]) => sha(fs.readFileSync(path.join(ROOT, 'experiments/wasm', p))) === sha(b));
    check(unchanged(), 'captured source or recipe changed before generation');
    const generated = { ...source, 'src/search.rs': Buffer.from(render(source['src/search.rs'].toString(), variant)) };
    fs.mkdirSync(destination); fs.mkdirSync(path.join(destination, 'src'));
    for (const [p, bytes] of Object.entries(generated)) fs.writeFileSync(path.join(destination, p), bytes, { flag: 'wx' });
    check(unchanged(), 'captured source or recipe changed before receipt');
    const receipt = { schema: 'chessy.compact-hash.source.v1', baseCommit: BASE, variant, researchOnly: true,
      productionIntegrationAllowed: false, timingPerformed: false, strengthClaimAllowed: false,
      source: Object.entries(source).map(([p,b]) => ({ path:p, sha256:sha(b) })),
      generated: Object.entries(generated).map(([p,b]) => ({ path:p, sha256:sha(b) })),
      recipe: __capturedCompactHash.map(f => ({ path:f.name, sha256:sha(f.bytes) })) };
    fs.writeFileSync(path.join(destination, 'source.json'), JSON.stringify(receipt, null, 2) + '\n', { flag:'wx' });
    return receipt;
  }
  module.exports = { prepare, render, sha };
  if (require.main === module) {
    check(process.argv.length === 3 || process.argv.length === 4, 'usage: node prepare.js /outside/new-crate [threaded|shared-update|proven-indices]');
    console.log(JSON.stringify(prepare(process.argv[2], process.argv[3]), null, 2));
  }
}
