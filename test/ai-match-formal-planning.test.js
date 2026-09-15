'use strict';
const assert = require('assert');
const S = require('./ai-match-formal-stats');
const A = require('./ai-match-formal');
const C = require('./ai-match-v2-core');
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('ok ' + name); }
test('planning exposes the pure-cost noninferiority limitation without changing the bound', () => {
  const pairs = Array.from({ length: 4096 }, (_, i) => ({ id: String(i), score: .5 }));
  const stats = S.estimate(pairs, 8192, .05);
  assert.ok(stats.lower > .4808 && stats.lower < .4809);
  assert.ok(stats.lower < A.PROFILES['selective-hard'].threshold,
    'exactly identical paired outcomes cannot pass this finite-bank profile');
  const requiredScore = A.PROFILES['selective-hard'].threshold + stats.radius;
  assert.ok(requiredScore > .5091 && requiredScore < .5092);
  const minimumPairs = Math.floor(Math.log(1 / .05) / (2 * .01 ** 2)) + 1;
  assert.equal(minimumPairs, 14979, 'planning threshold, not a larger dispatch authorization');
  assert.ok(Math.sqrt(Math.log(1 / .05) / (2 * 9999)) > .01,
    'no legal sample below the current 10000-endpoint bank cap repairs this limitation');
  assert.equal(A.CONTRACT.sampleSize, 4096);
  assert.equal(A.CONTRACT.alpha, .05);
});
test('campaign eligibility excludes pure search-cost work before any draw', () => {
  for (const [profile, changeClass] of Object.entries(A.CHANGE_CLASSES)) {
    A.validateCampaignScope({ profile, changeClass });
    for (const unsupported of [undefined, 'behavior-preserving-search-cost', 'efficiency', 'unknown']) {
      assert.throws(() => A.validateCampaignScope({ profile, changeClass: unsupported }), /pure search-cost/);
    }
  }
  assert.throws(() => A.validateCampaignScope({ profile: 'selective-hard', changeClass: 'evaluation-change' }), /requires/);
  assert.throws(() => A.validateCampaignScope({ profile: '__proto__', changeClass: 'selective-search-change' }), /unknown/);
  assert.equal(A.PROFILES['selective-hard'].acceptance, 'selective-search-conditional-noninferiority');
  // Exercise the trusted artifact loader, not just its validation helper.
  // Unsupported scope must fail before engine/evidence reads or any draw.
  const campaignPath = 'eval/match-formal/fixtures/unsupported.json';
  const campaignBytes = A.canonicalBytes({ schema: 'chessy.formal-campaign.v1',
    profile: 'selective-hard', changeClass: 'behavior-preserving-search-cost' });
  const registryBytes = A.canonicalBytes({ schema: 'chessy.formal-campaign-registry.v1',
    opportunity: A.CONTRACT.opportunity, alpha: .05,
    campaign: { path: campaignPath, sha256: C.sha256(campaignBytes) } });
  const originalRevision = C.revision, reads = [];
  try {
    C.revision = (_harness, file) => {
      reads.push(file);
      if (file === 'eval/match-formal/registry.json') return registryBytes;
      assert.equal(file, campaignPath, 'scope rejection precedes unrelated artifact reads');
      return campaignBytes;
    };
    assert.throws(() => A.loadCampaign('1'.repeat(40)), /pure search-cost admission remains unavailable/);
    assert.equal(reads.length, 2);
  } finally { C.revision = originalRevision; }
});
console.log(checks + ' prospective planning/scope tests passed; no games or engine searches');
