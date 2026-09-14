/*
 * Production WASM download-size ratchet.
 *
 * The raw and Brotli limits are the shipped main-branch asset at the time this
 * gate was introduced. A smaller module passes without changing the budget.
 * A larger module needs an explicit, reviewable override with exact ceilings
 * and a rationale; see experiments/wasm/README.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WASM_PATH = path.join(__dirname, '..', 'assets', 'chessy-ai-fast.wasm');
const BASELINE = Object.freeze({ rawBytes: 37172, brotliBytes: 17690 });
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
      rawBytes: BASELINE.rawBytes,
      brotliBytes: BASELINE.brotliBytes,
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
  if (rawBytes < BASELINE.rawBytes || brotliBytes < BASELINE.brotliBytes ||
      (rawBytes === BASELINE.rawBytes &&
       brotliBytes === BASELINE.brotliBytes)) {
    throw new Error('an override must raise at least one baseline ceiling ' +
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
// override cannot silently disable either half of the ratchet.
check(limitsFrom({}).rawBytes === BASELINE.rawBytes &&
    limitsFrom({}).brotliBytes === BASELINE.brotliBytes,
  'default limits stay pinned to the shipped baseline');
expectThrow('a partial override fails closed', /must set both/, function () {
  limitsFrom({ [RAW_OVERRIDE]: '40000' });
});
expectThrow('an undocumented override fails closed', /must document/, function () {
  limitsFrom({
    [RAW_OVERRIDE]: '40000',
    [BROTLI_OVERRIDE]: '18000'
  });
});
expectThrow('a non-increasing override fails closed', /raise at least one/, function () {
  limitsFrom({
    [RAW_OVERRIDE]: String(BASELINE.rawBytes),
    [BROTLI_OVERRIDE]: String(BASELINE.brotliBytes),
    [REASON_OVERRIDE]: 'Reviewed exception recorded in the pull request.'
  });
});
const overrideProbe = limitsFrom({
  [RAW_OVERRIDE]: '40000',
  [BROTLI_OVERRIDE]: '18000',
  [REASON_OVERRIDE]: 'Reviewed exception recorded in the pull request.'
});
check(overrideProbe.rawBytes === 40000 &&
    overrideProbe.brotliBytes === 18000 && !!overrideProbe.reason,
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
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
