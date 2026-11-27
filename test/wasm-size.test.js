/*
 * Production WASM download-size budget.
 *
 * Default budgets allow 40 KiB raw and 20 KiB Brotli-11. Historical shipped
 * measurements remain separate evidence, not the current ceilings. A module
 * above either budget needs an explicit, reviewable override with exact
 * ceilings and a rationale; see experiments/wasm/README.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WASM_PATH = path.join(__dirname, '..', 'assets', 'chessy-ai-fast.wasm');
const HISTORICAL_BASELINE = Object.freeze({ rawBytes: 37172, brotliBytes: 17690 });
const DEFAULT_LIMITS = Object.freeze({ rawBytes: 40960, brotliBytes: 20480 });
// Exact successful PR #169 engine-job runtime; do not silently rebaseline
// compressed bytes when Node changes its bundled encoder.
const ENCODER = Object.freeze({ node: '22.23.2', brotli: '1.1.0' });
const RAW_OVERRIDE = 'CHESSY_WASM_MAX_RAW_BYTES';
const BROTLI_OVERRIDE = 'CHESSY_WASM_MAX_BROTLI_BYTES';
const REASON_OVERRIDE = 'CHESSY_WASM_SIZE_OVERRIDE_REASON';

let passed = 0;
let failed = 0;

function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

function parseByteLimit(value, name) {
  if (!/^[1-9][0-9]*$/.test(String(value || ''))) {
    throw new Error(name + ' must be a positive integer byte ceiling');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(name + ' exceeds JavaScript\'s safe-integer range');
  }
  return parsed;
}

function limitsFrom(env) {
  const rawValue = env[RAW_OVERRIDE];
  const brotliValue = env[BROTLI_OVERRIDE];
  const reasonValue = env[REASON_OVERRIDE];
  const overrideRequested = rawValue !== undefined ||
    brotliValue !== undefined || reasonValue !== undefined;
  if (!overrideRequested) {
    return Object.freeze({
      rawBytes: DEFAULT_LIMITS.rawBytes,
      brotliBytes: DEFAULT_LIMITS.brotliBytes,
      reason: null
    });
  }

  if (rawValue === undefined || brotliValue === undefined) {
    throw new Error('a size override must set both ' + RAW_OVERRIDE +
      ' and ' + BROTLI_OVERRIDE);
  }
  const reason = String(reasonValue || '').trim();
  if (reason.length < 20) {
    throw new Error(REASON_OVERRIDE +
      ' must document the reviewed exception in at least 20 characters');
  }

  const rawBytes = parseByteLimit(rawValue, RAW_OVERRIDE);
  const brotliBytes = parseByteLimit(brotliValue, BROTLI_OVERRIDE);
  if (rawBytes < DEFAULT_LIMITS.rawBytes || brotliBytes < DEFAULT_LIMITS.brotliBytes ||
      (rawBytes === DEFAULT_LIMITS.rawBytes &&
       brotliBytes === DEFAULT_LIMITS.brotliBytes)) {
    throw new Error('an override must raise at least one default ceiling ' +
      'without lowering the other');
  }
  return Object.freeze({
    rawBytes: rawBytes,
    brotliBytes: brotliBytes,
    reason: reason
  });
}

function expectThrow(label, pattern, callback) {
  try {
    callback();
    check(false, label, 'did not throw');
  } catch (error) {
    check(pattern.test(String(error && error.message || error)), label,
      String(error && error.message || error));
  }
}

// Keep the exception path fail-closed so a misspelled or unexplained CI
// override cannot silently disable either half of the download budget.
check(limitsFrom({}).rawBytes === 40960 &&
    limitsFrom({}).brotliBytes === 20480 && limitsFrom({}).reason === null,
  'default limits are 40 KiB raw and 20 KiB Brotli-11');
check(HISTORICAL_BASELINE.rawBytes === 37172 &&
    HISTORICAL_BASELINE.brotliBytes === 17690,
  'historical shipped measurements remain separate and unchanged');
expectThrow('a partial override fails closed', /must set both/, function () {
  limitsFrom({ [RAW_OVERRIDE]: '43008' });
});
expectThrow('an undocumented override fails closed', /must document/, function () {
  limitsFrom({
    [RAW_OVERRIDE]: '43008',
    [BROTLI_OVERRIDE]: '21504'
  });
});
expectThrow('a non-increasing override fails closed', /raise at least one/, function () {
  limitsFrom({
    [RAW_OVERRIDE]: '40960',
    [BROTLI_OVERRIDE]: '20480',
    [REASON_OVERRIDE]: 'Reviewed exception recorded in the pull request.'
  });
});
for (const [label, rawBytes, brotliBytes] of [
  ['historical ceilings', 37172, 17690],
  ['a lower raw ceiling', 40959, 20481],
  ['a lower Brotli ceiling', 40961, 20479]
]) {
  expectThrow(label + ' cannot override the current defaults', /without lowering/, function () {
    limitsFrom({
      [RAW_OVERRIDE]: String(rawBytes),
      [BROTLI_OVERRIDE]: String(brotliBytes),
      [REASON_OVERRIDE]: 'Reviewed exception recorded in the pull request.'
    });
  });
}
for (const value of ['0', '-1', '40960.5', '1e6', 'Infinity', '9007199254740992']) {
  for (const name of [RAW_OVERRIDE, BROTLI_OVERRIDE]) {
    expectThrow(name + ' rejects invalid byte value ' + value,
      /positive integer|safe-integer range/, function () {
        limitsFrom({
          [RAW_OVERRIDE]: '43008',
          [BROTLI_OVERRIDE]: '21504',
          [REASON_OVERRIDE]: 'Reviewed exception recorded in the pull request.',
          [name]: value
        });
      });
  }
}
for (const [rawBytes, brotliBytes] of [[40961, 20480], [40960, 20481]]) {
  const raised = limitsFrom({
    [RAW_OVERRIDE]: String(rawBytes),
    [BROTLI_OVERRIDE]: String(brotliBytes),
    [REASON_OVERRIDE]: 'Reviewed exception recorded in the pull request.'
  });
  check(raised.rawBytes === rawBytes && raised.brotliBytes === brotliBytes,
    'a one-byte increase may preserve the other default ceiling');
}
const overrideProbe = limitsFrom({
  [RAW_OVERRIDE]: '43008',
  [BROTLI_OVERRIDE]: '21504',
  [REASON_OVERRIDE]: 'Reviewed exception recorded in the pull request.'
});
check(overrideProbe.rawBytes === 43008 &&
    overrideProbe.brotliBytes === 21504 && !!overrideProbe.reason,
  'a complete documented override has exact bounded ceilings');

let limits;
try {
  limits = limitsFrom(process.env);
  if (limits.reason) {
    console.log('  note WASM size override: ' + limits.reason);
  }
} catch (error) {
  check(false, 'size override is valid', String(error && error.message || error));
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = 1;
  return;
}

const bytes = fs.readFileSync(WASM_PATH);
const pinnedEncoder = process.versions.node === ENCODER.node &&
  process.versions.brotli === ENCODER.brotli;
const diagnostic = process.argv.slice(2).length === 1 &&
  process.argv[2] === '--diagnostic';
if (process.argv.length > 2 && !diagnostic) {
  throw new Error('only --diagnostic is supported');
}
console.log('  encoder Node ' + process.versions.node +
  ' / Brotli ' + process.versions.brotli);
if (!diagnostic) {
  check(pinnedEncoder, 'compressed-size gate uses the pinned encoder',
    'requires Node ' + ENCODER.node + ' / Brotli ' + ENCODER.brotli +
    '; use --diagnostic for a non-authoritative local measurement');
} else {
  console.log('  DIAGNOSTIC ONLY: not the authoritative download-size gate');
}
const brotliBytes = zlib.brotliCompressSync(bytes, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11
  }
}).byteLength;

check(bytes.byteLength <= limits.rawBytes,
  'raw WASM is at most ' + limits.rawBytes.toLocaleString('en-US') + ' bytes',
  'got ' + bytes.byteLength.toLocaleString('en-US') + ' bytes');
check(brotliBytes <= limits.brotliBytes,
  'Brotli-11 WASM is at most ' +
    limits.brotliBytes.toLocaleString('en-US') + ' bytes',
  'got ' + brotliBytes.toLocaleString('en-US') + ' bytes');

console.log('  size ' + bytes.byteLength.toLocaleString('en-US') +
  ' raw / ' + brotliBytes.toLocaleString('en-US') + ' Brotli-11 bytes');
console.log('  historical shipped measurement ' +
  HISTORICAL_BASELINE.rawBytes.toLocaleString('en-US') + ' raw / ' +
  HISTORICAL_BASELINE.brotliBytes.toLocaleString('en-US') + ' Brotli-11 bytes' +
  ' (Node ' + ENCODER.node + ' / Brotli ' + ENCODER.brotli + ')');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
