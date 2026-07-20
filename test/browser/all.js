/*
 * Run every browser suite in sequence. Each suite runs in its own process
 * with its own server port (= its own web origin), so service-worker and
 * localStorage state can never leak between suites.
 *
 * Requires Playwright's Chromium: either `npm i playwright` +
 * `npx playwright install chromium` (CI), or `playwright-core` resolvable
 * with the browser binary named by $CHROMIUM_PATH.
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const suites = ['replay.test.js', 'a11y.test.js', 'setup.test.js', 'clocks.test.js', 'sw-update.test.js', 'archive.test.js', 'review.test.js', 'reflection.test.js', 'train.test.js', 'progress.test.js'];
let failed = 0;

for (const suite of suites) {
  console.log('=== ' + suite + ' ===');
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(failed ? failed + ' suite(s) FAILED' : 'all browser suites passed');
process.exit(failed ? 1 : 0);
