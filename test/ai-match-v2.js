/* Manual diagnostic v2 runner: register first, then execute exact shards.
 * No working-tree candidate code, seed option, partial schedule or retuning.
 */
'use strict';
const fs = require('fs');
const C = require('./ai-match-v2-core');
const P = require('./ai-match-protocol-v2');
const O = require('./ai-match-openings-v2');
const Loader = require('../assets/wasm-engine');

function args(argv) {
  const parsed = {};
  const valid = new Set(['base', 'candidate', 'harness', 'profile', 'run', 'out',
    'registration', 'registration-sha256', 'slot']);
  for (let i = 0; i < argv.length; i += 2) {
    C.check(/^--/.test(argv[i]) && valid.has(argv[i].slice(2)), 'unknown argument ' + argv[i]);
    const name = argv[i].slice(2);
    C.check(!(name in parsed) && argv[i + 1] && !argv[i + 1].startsWith('--'), 'missing/duplicate ' + name);
    parsed[name] = argv[i + 1];
  }
  return parsed;
}
function exactKeys(options, keys) { C.same(Object.keys(options).sort(), keys.sort(), 'CLI options'); }
function writeNew(file, bytes) { fs.writeFileSync(file, bytes, { flag: 'wx' }); }
async function main(argv) {
  const mode = argv.shift(), a = args(argv);
  if (mode === 'register') {
    exactKeys(a, ['base', 'candidate', 'harness', 'profile', 'run', 'out']);
    const plan = C.registration(a);
    C.validateRegistration(plan);
    const bytes = C.canonical(plan) + '\n';
    writeNew(a.out, bytes);
    console.log(C.sha256(bytes));
    return;
  }
  C.check(mode === 'shard', 'expected register or shard command');
  exactKeys(a, ['registration', 'registration-sha256', 'slot', 'out']);
  const r = C.readRegistration(a.registration, a['registration-sha256']);
  C.check(/^(0|[1-9][0-9]*)$/.test(a.slot), 'invalid slot');
  const slot = Number(a.slot);
  C.integer(slot, 0, P.CONTRACT.shards - 1, 'slot');
  if (process.env.GITHUB_RUN_ATTEMPT) C.check(process.env.GITHUB_RUN_ATTEMPT === '1', 'reruns forbidden');
  if (process.env.CHESSY_WORKFLOW_RUN) C.same(process.env.CHESSY_WORKFLOW_RUN, r.run, 'workflow run');
  const fd = fs.openSync(a.out, 'wx');
  const hash = require('crypto').createHash('sha256');
  let rows = 0;
  function emit(row) {
    const text = C.canonical(row) + '\n';
    fs.writeSync(fd, text);
    hash.update(text); rows++;
  }
  try {
    emit({ type: 'header', schema: 'chessy-match-v2-raw-1', registrationSha256: a['registration-sha256'], slot });
    const engines = {};
    for (const side of ['candidate', 'base']) {
      const bytes = C.revision(r[side].commit, C.MODULE);
      C.check(C.sha256(bytes) === r[side].moduleSha256, 'module bytes changed');
      // Both immutable raw modules use the trusted ABI-v2 loader. Candidate
      // JavaScript and candidate build scripts are never executed here.
      engines[side] = await Loader.load(bytes);
    }
    for (let op = slot * 20; op < (slot + 1) * 20; op++) {
      for (const color of ['w', 'b']) {
        const game = O.openings[op].id + ':' + color;
        emit({ type: 'start', game, opening: op, candidateColor: color });
        C.playGame(engines, O.openings[op], color, r.protocol.nodes,
          row => emit({ ...row, game }));
        fs.fsyncSync(fd);
      }
    }
    // Recheck the exact trusted implementation and immutable identities at
    // publication. The footer authenticates every preceding literal byte.
    C.validateRegistration(r);
    fs.writeSync(fd, C.canonical({ type: 'complete', rows, sha256: hash.digest('hex'), games: 40 }) + '\n');
    fs.fsyncSync(fd);
  } catch (error) {
    emit({ type: 'failure', message: String(error.message) });
    fs.fsyncSync(fd);
    throw error;
  } finally { fs.closeSync(fd); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error('FAIL: ' + error.message); process.exitCode = 2;
});
module.exports = { args, main };
