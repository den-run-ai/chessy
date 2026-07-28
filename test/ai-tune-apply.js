/*
 * Apply a tuner candidate (the JSON test/ai-tune.js --emit writes) to
 * assets/ai.js IN THE WORKING TREE. Development-only, and deliberately a
 * separate explicit step: the tuner itself never writes assets/ai.js.
 *
 *   node test/ai-tune-apply.js candidate.json          # patch assets/ai.js
 *   git checkout -- assets/ai.js                       # revert
 *
 * Intended use is gate-testing a candidate from a clean commit: apply, run
 * the tactics suite / bench / diagnostic match against the committed
 * baseline, then revert (or keep the patch in a dedicated PR that owns the
 * full shipping checklist).
 *
 * After patching, the patched engine is loaded in a fresh realm and checked
 * against the tuner's own reconstruction under the candidate weights on
 * fresh random positions — a wrong or partial patch fails loudly and the
 * original file is restored.
 *
 * SHIPPING WARNINGS (printed on success, enforced by nothing here):
 *   - the Rust/WASM evaluator (experiments/wasm/src/eval.rs -> shipped
 *     assets/chessy-ai-fast.wasm) duplicates these constants and is
 *     hash-gated by test/wasm-asset.test.js; a shipped eval change must
 *     retune it in lockstep and rebuild with the pinned toolchain;
 *   - the PST provenance comment in assets/ai.js and THIRD_PARTY_NOTICES.md
 *     describe the PeSTO coefficients; tuned tables need that prose updated;
 *   - any asset change needs the release-unit bump (sw.js + index.html);
 *   - none of this replaces the ordered gates: tactics, bench, and the
 *     formal 800-game strict-strength match (#104).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2];
if (!file) { console.error('usage: node test/ai-tune-apply.js <candidate.json>'); process.exit(2); }
const cand = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')).candidate;
if (!cand || !cand.MOBILITY || !cand.PST || !cand.PST_EG) {
  console.error('not a tuner candidate JSON (missing candidate.MOBILITY/PST/PST_EG)');
  process.exit(2);
}

// Load the tuner (which snapshots the CURRENT shipped constants) BEFORE
// patching, so its evalFeat/features are an independent yardstick.
const T = require('./ai-tune.js');

const AI_PATH = path.join(__dirname, '..', 'assets', 'ai.js');
const original = fs.readFileSync(AI_PATH, 'utf8');

function fmtTable(arr) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    rows.push('      ' + arr.slice(r * 8, r * 8 + 8).map(function (x) { return String(x).padStart(4); }).join(', '));
  }
  return '[\n' + rows.join(',\n') + '\n    ]';
}
function fmtPst(tables) {
  return '{\n' + T.TYPES.map(function (t) { return '    ' + t + ': ' + fmtTable(tables[t]); }).join(',\n') + '\n  };';
}

const subs = [
  [/const MOBILITY = \{[^}]*\};/, 'const MOBILITY = { N: ' + cand.MOBILITY.N + ', B: ' + cand.MOBILITY.B +
    ', R: ' + cand.MOBILITY.R + ', Q: ' + cand.MOBILITY.Q + ' };'],
  [/const DOUBLED = \d+, ISOLATED = \d+, SHIELD = \d+;/,
    'const DOUBLED = ' + cand.DOUBLED + ', ISOLATED = ' + cand.ISOLATED + ', SHIELD = ' + cand.SHIELD + ';'],
  [/const PASSED_MG = \[[^\]]*\];/, 'const PASSED_MG = [' + cand.PASSED_MG.join(', ') + '];'],
  [/const PASSED_EG = \[[^\]]*\];/, 'const PASSED_EG = [' + cand.PASSED_EG.join(', ') + '];'],
  [/const PST = \{[\s\S]*?\n  \};/, 'const PST = ' + fmtPst(cand.PST)],
  [/const PST_EG = \{[\s\S]*?\n  \};/, 'const PST_EG = ' + fmtPst(cand.PST_EG)]
];
let patched = original;
for (const [re, rep] of subs) {
  if (!re.test(patched)) { console.error('could not locate constant to patch: ' + re); process.exit(1); }
  patched = patched.replace(re, rep);
}
fs.writeFileSync(AI_PATH, patched);

// Verify: the patched engine must equal the tuner's reconstruction under the
// candidate weights on fresh random positions. Restore the original on any
// mismatch — a half-applied eval must never linger.
const w = {
  mobN: cand.MOBILITY.N, mobB: cand.MOBILITY.B, mobR: cand.MOBILITY.R, mobQ: cand.MOBILITY.Q,
  doubled: cand.DOUBLED, isolated: cand.ISOLATED, shield: cand.SHIELD,
  passedMg: cand.PASSED_MG.slice(), passedEg: cand.PASSED_EG.slice(),
  pstMg: cand.PST, pstEg: cand.PST_EG
};
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'engine.js'), 'utf8'), ctx, { filename: 'engine.js' });
vm.runInContext(patched, ctx, { filename: 'ai.js(candidate)' });
const rng = T.mulberry32(0xC0FFEE);
let checked = 0, bad = 0;
for (let t = 0; t < 300; t++) {
  let st = T.Chess.newGameState();
  const plies = 4 + Math.floor(rng() * 50);
  let ok = true;
  for (let i = 0; i < plies; i++) {
    if (T.Chess.gameStatus(st).over) { ok = false; break; }
    const legal = T.Chess.legalMoves(st);
    st = T.Chess.playMove(st, legal[Math.floor(rng() * legal.length)]);
  }
  if (!ok) continue;
  checked++;
  if (T.evalFeat(T.features(st.board), w, true) !== ctx.ChessAI.evaluate(st.board)) bad++;
}
if (bad > 0 || checked < 100) {
  fs.writeFileSync(AI_PATH, original);
  console.error('FAIL: patched engine diverges from the candidate on ' + bad + '/' + checked +
    ' positions — assets/ai.js restored unchanged.');
  process.exit(1);
}

console.log('applied ' + file + ' to assets/ai.js (' + checked + '-position verification passed).');
console.log('revert with: git checkout -- assets/ai.js');
console.log('REMINDERS if this candidate is ever to SHIP (not enforced here):');
console.log('  - retune + rebuild the Rust/WASM evaluator in lockstep (hash-gated asset);');
console.log('  - update the PST provenance prose (assets/ai.js + THIRD_PARTY_NOTICES.md);');
console.log('  - release-unit bump; and the ordered gates: tactics -> bench -> formal #104 match.');
