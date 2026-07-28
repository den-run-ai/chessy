/*
 * Drive the WASM probe page in a Playwright browser.
 *
 * Modes:
 *   node run-playwright.js --browser chromium|webkit [--throttle N]
 *     Launches the engine locally (desktop build of the mobile engine
 *     family: Chromium/V8 for Android Chrome, WebKit/JavaScriptCore for iOS
 *     Safari). --throttle applies CDP CPU throttling (Chromium only) — the
 *     in-container minimum-device proxy used by PR #116's evidence.
 *   node run-playwright.js --cdp http://127.0.0.1:9222
 *     Attaches to a REAL browser over CDP (e.g. Chrome on an Android
 *     emulator via adb forward) and opens the probe page in it.
 *
 * The probe page/worker POST results to the probe server; this runner also
 * captures them from the page (window.__probeResult) and writes --json.
 * Exit code: 0 pass, 1 fail/timeout.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const BROWSER = opt('browser', process.env.BROWSER || 'chromium');
const CDP = opt('cdp', null);
const THROTTLE = Number(opt('throttle', 0));
const SERVER = opt('server', 'http://127.0.0.1:8123');
const PAGE_HOST = opt('page-host', null); // URL the BROWSER should use for the server
const TARGET = opt('target', CDP ? 'cdp' : BROWSER + (THROTTLE ? '-throttle' + THROTTLE : ''));
const JSON_OUT = opt('json', null);
const TIMEOUT_MS = Number(opt('timeout', 1500)) * 1000;
const PARAMS = {
  depth: opt('depth', '5'),
  parityDepth: opt('parity-depth', opt('depth', '5')),
  reps: opt('reps', '2'),
  minMs: opt('min-ms', '100'),
  abortNodes: opt('abort-nodes', '5000'),
  five: opt('five', '1'),
  target: TARGET
};

function probeUrl() {
  const base = PAGE_HOST || SERVER;
  const q = new URLSearchParams(PARAMS);
  return base + '/experiments/wasm/probe/?' + q.toString();
}

async function main() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    playwright = require('playwright-core');
  }

  let browser, context, page;
  if (CDP) {
    browser = await playwright.chromium.connectOverCDP(CDP, { timeout: 30000 });
    context = browser.contexts()[0] || (await browser.newContext());
    page = await context.newPage();
  } else {
    const type = playwright[BROWSER];
    if (!type) throw new Error('unknown browser ' + BROWSER);
    const launchOpts = {};
    if (BROWSER === 'chromium' && process.env.CHROMIUM_PATH) {
      launchOpts.executablePath = process.env.CHROMIUM_PATH;
    }
    browser = await type.launch(launchOpts);
    context = await browser.newContext();
    page = await context.newPage();
  }

  page.on('console', function (msg) {
    if (msg.type() === 'error') console.log('[page console.error] ' + msg.text());
  });
  page.on('pageerror', function (err) { console.log('[page error] ' + err); });

  if (THROTTLE > 1) {
    if (CDP || BROWSER !== 'chromium') {
      throw new Error('--throttle requires locally launched Chromium');
    }
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    console.log('CPU throttling x' + THROTTLE + ' applied');
  }

  const url = probeUrl();
  console.log('opening ' + url + ' (target ' + TARGET + ')');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  await page.waitForFunction(function () {
    return document.title === 'PROBE-DONE' || document.title === 'PROBE-FAIL';
  }, null, { timeout: TIMEOUT_MS, polling: 1000 });

  const result = await page.evaluate(function () { return window.__probeResult; });
  const ok = !!(result && result.ok);
  if (JSON_OUT && result) {
    fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
  }
  if (result && result.parity) {
    console.log('parity: ' + (result.parity.diverged ? 'FAIL ' + result.parity.diverged : 'PASS') +
      ' (' + result.parity.checked + ' checks), abort: ' +
      (result.abortParity.diverged ? 'FAIL' : 'PASS'));
  }
  if (result && result.nps) {
    console.log('paired NPS geomean ' + result.nps.geomean.toFixed(4) +
      ', worst family ' + result.nps.worstFamily.ratio.toFixed(4) +
      ' (' + result.nps.worstFamily.name + '), slower families ' +
      result.nps.slowerFamilies + '/9');
  }
  if (result && result.fiveSecond) {
    for (const f of result.fiveSecond) {
      console.log('5s ' + f.name + ': wasm d' + f.wasm.depth + ' (' + f.wasm.nodes +
        ' n) vs js d' + f.js.depth + ' (' + f.js.nodes + ' n)');
    }
  }
  if (result && result.error) console.log('probe error: ' + result.error);
  console.log('probe ' + TARGET + ': ' + (ok ? 'PASS' : 'FAIL'));

  await browser.close();
  process.exitCode = ok ? 0 : 1;
}

main().catch(function (e) {
  console.error('FAIL: ' + (e && e.stack || e));
  process.exitCode = 1;
});
