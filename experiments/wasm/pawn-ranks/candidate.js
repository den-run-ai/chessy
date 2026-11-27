'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SOURCE_SHA = '3a107218a6d7a42f771022956fab04b28935a39867b74eaea911d27b2598a6b7';

function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, 'patch anchor must occur exactly once');
  return text.replace(before, after);
}

function candidate(source, tests) {
  assert.equal(sha(source), SOURCE_SHA, 'unknown evaluator source; stop before patching');
  const original = source.toString('utf8');
  let text = replaceOnce(original,
    '    let mut pawn_files = [[0_u8; 8]; 2];',
    '    let mut pawn_files = [[0_u8; 8]; 2];\n    let mut pawn_ranks = [[0_u8; 8]; 2];');
  text = replaceOnce(text,
    '            pawn_files[color_index][square % 8] += 1;',
    '            pawn_files[color_index][square % 8] += 1;\n            pawn_ranks[color_index][square % 8] |= 1_u8 << (square / 8);');
  const begin = text.indexOf('            let mut passed = true;');
  const end = text.indexOf('            if passed {', begin);
  assert.ok(begin > 0 && end > begin);
  text = text.slice(0, begin) + `            // Union the opponent's occupied ranks on this and adjacent files.
            // White is blocked by a lower row; Black by a higher row. u32
            // shifts also cover rows 0/7 without an 8-bit shift overflow.
            let mut enemy_ranks = pawn_ranks[enemy_index][file] as u32;
            if file > 0 {
                enemy_ranks |= pawn_ranks[enemy_index][file - 1] as u32;
            }
            if file < 7 {
                enemy_ranks |= pawn_ranks[enemy_index][file + 1] as u32;
            }
            let passed = if color == Color::White {
                enemy_ranks & ((1_u32 << rank) - 1) == 0
            } else {
                enemy_ranks >> (rank + 1) == 0
            };
` + text.slice(end);
  assert.equal(tests.toString().split('/* RETAINED_BASELINE_EVALUATOR */').length, 2);
  const testSource = tests.toString().replace('/* RETAINED_BASELINE_EVALUATOR */', original);
  return Buffer.from(text + '\n' + testSource);
}

module.exports = { candidate, sha, SOURCE_SHA };
