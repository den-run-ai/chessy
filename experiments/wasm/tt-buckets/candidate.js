'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SOURCE_SHA = 'e13b53fdb744f8fb647ae9c74ebc5ea2289c6881ba676122336b3f93ec8671cd';
const oldTest = `    #[test]
    fn full_table_short_circuits_before_an_unknown_probe() {
        assert!(!super::tt_unavailable(super::TT_CAPACITY - 1, false));
        assert!(super::tt_unavailable(super::TT_CAPACITY, false));
        assert!(super::tt_unavailable(0, true));
    }
`;

function candidate(source, table, tests) {
  assert.equal(sha(source), SOURCE_SHA, 'unknown Rust search source; stop before patching');
  const text = source.toString('utf8');
  const begin = text.indexOf('#[inline]\nfn tt_start_index');
  const end = text.indexOf('unsafe fn check_budget()');
  assert.ok(begin > 0 && end > begin);
  assert.equal(text.split(oldTest).length, 2, 'missing original table-capacity regression');
  // Only the TT implementation and its now-inapplicable capacity test change.
  // All search, evaluation, draw checks, score normalization consumers, ABI,
  // node budgeting, position storage and compile flags remain byte-identical.
  return Buffer.from((text.slice(0, begin) + table.toString('utf8') + text.slice(end))
    .replace(oldTest, '') + '\n' + tests.toString('utf8'));
}

module.exports = { candidate, sha, SOURCE_SHA };

if (require.main === module) {
  const source = fs.readFileSync(process.argv[2]);
  const output = process.argv[3];
  if (!output) throw Error('usage: candidate.js SOURCE_SEARCH_RS NEW_OUTPUT_RS');
  fs.writeFileSync(output, candidate(source,
    fs.readFileSync(path.join(__dirname, 'table.rs')),
    fs.readFileSync(path.join(__dirname, 'tests.rs'))), { flag: 'wx' });
}
