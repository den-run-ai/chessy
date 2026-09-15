/* Release-token gate contract — run with: node test/release-gate.test.js */
'use strict';

const Gate = require('./release-gate.js');

let passed = 0;
let failed = 0;
function check(ok, label) {
  if (ok) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.error('FAIL  ' + label); }
}
function sw(n) { return "const RELEASE = 'r" + n + "';\n"; }

check(Gate.releaseSignificant('assets/app.js') &&
  Gate.releaseSignificant('index.html') && Gate.releaseSignificant('sw.js'),
'assets, app shell, and service worker are release-significant');
check(!Gate.releaseSignificant('README.md') &&
  !Gate.releaseSignificant('test/engine.test.js'),
'docs and tests do not consume a release token');
check(Gate.evaluateRelease(['README.md'], sw(73), sw(73)).ok,
'non-runtime changes need no bump');
check(!Gate.evaluateRelease(['index.html'], sw(73), sw(73)).ok,
'index.html cannot change under an unchanged token');
check(!Gate.evaluateRelease(['sw.js'], sw(73), sw(72)).ok,
'release chronology cannot go backwards');
check(Gate.evaluateRelease(['assets/app.js'], sw(73), sw(74)).ok,
'a strictly newer token admits an executable change');
check(!Gate.evaluateRelease(['assets/app.js'], 'bad', sw(74)).ok &&
  !Gate.evaluateRelease(['assets/app.js'], sw(73), 'bad').ok,
'missing or malformed token state fails closed');
check(!Gate.evaluateRelease(['assets/app.js'], sw(73) + sw(72), sw(74)).ok &&
  !Gate.evaluateRelease(['assets/app.js'], sw(73), sw(74) + sw(75)).ok,
'duplicate release declarations fail closed');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
