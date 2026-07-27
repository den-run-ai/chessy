/*
 * Wait for a probe final report file to appear, then summarize it and exit
 * 0 (ok:true) or 1 (not ok / timeout). Usage:
 *   node wait-report.js <path/to/final-target.json> [timeoutSeconds]
 */
'use strict';
const fs = require('fs');

const file = process.argv[2];
const timeoutS = Number(process.argv[3] || 1500);
if (!file) {
  console.error('usage: wait-report.js <final.json> [timeoutSeconds]');
  process.exit(2);
}
const deadline = Date.now() + timeoutS * 1000;
let lastNote = 0;

function poll() {
  if (fs.existsSync(file)) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // partially written — retry shortly
      setTimeout(poll, 500);
      return;
    }
    if (report.parity) {
      console.log('parity: ' + (report.parity.diverged ? 'FAIL ' + report.parity.diverged
        : 'PASS') + ' (' + report.parity.checked + ' checks), abort: ' +
        (report.abortParity && report.abortParity.diverged ? 'FAIL' : 'PASS'));
    }
    if (report.nps) {
      console.log('paired NPS geomean ' + report.nps.geomean.toFixed(4) +
        ', worst family ' + report.nps.worstFamily.ratio.toFixed(4) +
        ' (' + report.nps.worstFamily.name + '), slower families ' +
        report.nps.slowerFamilies + '/9');
    }
    if (report.fiveSecond) {
      for (const f of report.fiveSecond) {
        console.log('5s ' + f.name + ': wasm d' + f.wasm.depth + ' (' + f.wasm.nodes +
          ' n) vs js d' + f.js.depth + ' (' + f.js.nodes + ' n)');
      }
    }
    if (report.error) console.log('probe error: ' + report.error);
    console.log('final report: ' + (report.ok ? 'PASS' : 'FAIL'));
    process.exit(report.ok ? 0 : 1);
  }
  if (Date.now() >= deadline) {
    console.error('timeout waiting for ' + file);
    process.exit(1);
  }
  if (Date.now() - lastNote > 30000) {
    lastNote = Date.now();
    console.log('waiting for ' + file + ' (' +
      Math.round((deadline - Date.now()) / 1000) + 's left)');
  }
  setTimeout(poll, 2000);
}
poll();
