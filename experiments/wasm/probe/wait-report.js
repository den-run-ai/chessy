/*
 * Wait for a probe final report file to appear, then summarize it and exit
 * 0 (ok:true) or 1 (not ok / timeout / stalled). Usage:
 *   node wait-report.js <path/to/final-target.json> [timeoutSeconds] \
 *     [progressLogPath] [staleSeconds]
 * With a progress log path, the wait also fails fast when the probe stops
 * reporting for staleSeconds (default 300) — a dead browser is diagnosed
 * near its moment of death instead of after the full timeout.
 */
'use strict';
const fs = require('fs');

const file = process.argv[2];
const timeoutS = Number(process.argv[3] || 1500);
const progressFile = process.argv[4] || null;
const staleS = Number(process.argv[5] || 300);
if (!file) {
  console.error('usage: wait-report.js <final.json> [timeoutSeconds] [progressLog] [staleSeconds]');
  process.exit(2);
}
const deadline = Date.now() + timeoutS * 1000;
const startedAt = Date.now();
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
  if (progressFile) {
    let lastActivity = startedAt;
    try {
      lastActivity = fs.statSync(progressFile).mtimeMs;
    } catch (e) { /* no progress yet: measure from start */ }
    if (Date.now() - lastActivity > staleS * 1000) {
      console.error('probe stalled: no progress in ' + staleS + 's (' +
        (fs.existsSync(progressFile) ? 'last activity ' +
          new Date(lastActivity).toISOString() : 'no progress ever received') + ')');
      process.exit(1);
    }
  }
  if (Date.now() - lastNote > 30000) {
    lastNote = Date.now();
    console.log('waiting for ' + file + ' (' +
      Math.round((deadline - Date.now()) / 1000) + 's left)');
  }
  setTimeout(poll, 2000);
}
poll();
