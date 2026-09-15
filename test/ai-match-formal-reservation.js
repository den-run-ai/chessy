/* One lifetime opportunity across every candidate/profile, before randomness.
 * Failed preflights do not spend alpha; a successful reservation does, even if
 * draw/execution/artifact upload subsequently fails. Never infer from scores. */
'use strict';
const OPPORTUNITY = 'initial-formal-opportunity-v1';
const STEP = 'Reserve alpha opportunity before random draw';
function reserved(jobs) {
  if (!Array.isArray(jobs) || !jobs.length) throw new Error('missing authenticated prior job inventory');
  let found = false;
  for (const job of jobs) {
    if (!Array.isArray(job.steps)) throw new Error('prior job steps unavailable: cannot establish unused opportunity');
    for (const step of job.steps) if (step.name === STEP) {
      found = true;
      if (step.conclusion === 'success' && step.status === 'completed') return true;
      if (step.status !== 'completed' || !['failure', 'skipped', 'cancelled'].includes(step.conclusion)) {
        throw new Error('previous reservation is unresolved');
      }
    }
  }
  if (!found) throw new Error('prior reservation step unavailable: cannot establish unused opportunity');
  return false;
}
async function inventory(request, endpoint, field) {
  const collected = [], ids = new Set(); let expected = null;
  for (let page = 1; ; page++) {
    const response = await request(endpoint + '&per_page=100&page=' + page);
    if (!Number.isSafeInteger(response.total_count) || response.total_count < 0 ||
        !Array.isArray(response[field])) throw new Error('prior ' + field + ' history unavailable');
    if (expected === null) expected = response.total_count;
    if (response.total_count !== expected) throw new Error('prior history changed during authentication');
    for (const item of response[field]) {
      if (!Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id)) throw new Error('invalid/duplicate historical identity');
      ids.add(item.id); collected.push(item);
    }
    if (response[field].length < 100) break;
  }
  if (collected.length !== expected) throw new Error('incomplete authenticated prior ' + field + ' inventory');
  return collected;
}
async function guard(request, currentRun) {
  if (!/^[1-9][0-9]*$/.test(String(currentRun))) throw new Error('invalid current run');
  const runs = await inventory(request, '/actions/workflows/ai-match-formal.yml/runs?event=workflow_dispatch', 'workflow_runs');
  if (!runs.some(run => String(run.id) === String(currentRun))) throw new Error('current run absent from authenticated history');
  for (const run of runs) {
    if (String(run.id) === String(currentRun)) continue;
    const jobs = await inventory(request, '/actions/runs/' + run.id + '/jobs?filter=all', 'jobs');
    if (reserved(jobs)) throw new Error(OPPORTUNITY + ' already consumed by run ' + run.id + '; no retries or fresh alpha');
  }
}

if (require.main === module) {
  if (process.env.GITHUB_RUN_ATTEMPT !== '1' || process.env.GITHUB_REPOSITORY !== 'den-run-ai/chessy') {
    throw new Error('trusted repository, first attempt required');
  }
  guard(async endpoint => {
    const response = await fetch('https://api.github.com/repos/den-run-ai/chessy' + endpoint,
      { headers: { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error('cannot authenticate full alpha history: HTTP ' + response.status);
    return response.json();
  }, process.env.GITHUB_RUN_ID).catch(error => { console.error(error.message); process.exitCode = 2; });
}
module.exports = { OPPORTUNITY, STEP, reserved, guard };
