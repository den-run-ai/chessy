#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Corpus = require('./corpus');
const Prepare = require('./prepare-lichess-evals');
const Label = require('./label-stockfish');
const Smoke = require('./smoke-stockfish');

let checks = 0;
function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  checks++;
}
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}
function throws(callback, pattern, message) {
  assert.throws(callback, pattern, message);
  checks++;
}
async function rejects(callback, pattern, message) {
  await assert.rejects(callback, pattern, message);
  checks++;
}

function fakeEngineSource(bigBody, smallBody) {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    "const readline = require('readline');",
    'const big = Buffer.from(' + JSON.stringify(bigBody.toString('base64')) +
      ", 'base64');",
    'const small = Buffer.from(' + JSON.stringify(smallBody.toString('base64')) +
      ", 'base64');",
    'const input = readline.createInterface({ input: process.stdin });',
    "input.on('line', function (line) {",
    "  if (line === 'uci') {",
    "    console.log('id name Hermetic Stockfish 18 fixture');",
    "    console.log('uciok');",
    "  } else if (line === 'isready') {",
    "    console.log('readyok');",
    "  } else if (line.startsWith('export_net ')) {",
    '    const names = line.trim().split(/\\s+/).slice(1);',
    '    fs.writeFileSync(names[0], big);',
    '    fs.writeFileSync(names[1], small);',
    "    console.log('info string export cwd ' + process.cwd());",
    "    console.log('info string networks exported');",
    "  } else if (line === 'go nodes 100000') {",
    "    console.log('info depth 15 seldepth 20 score cp 23 " +
      "wdl 310 620 70 nodes 80000 pv e2e4 e7e5');",
    "    console.log('info depth 16 seldepth 22 score cp 21 upperbound " +
      "wdl 300 630 70 nodes 100123 pv e2e4 e7e5');",
    "    console.log('bestmove e2e4 ponder e7e5');",
    "  } else if (line === 'quit') {",
    '    input.close();',
    '    process.exit(0);',
    '  }',
    '});',
    ''
  ].join('\n');
}

function fixtureContracts(base, archive, executable, bigBody, smallBody) {
  const teacher = JSON.parse(JSON.stringify(base.teacher));
  teacher.engine.archive.sha256 = Smoke.sha256Buffer(archive);
  teacher.engine.executable.sha256 =
    Smoke.sha256Buffer(fs.readFileSync(executable));
  teacher.engine.networks[0].sha256 = Smoke.sha256Buffer(bigBody);
  teacher.engine.networks[0].bytes = bigBody.length;
  teacher.engine.networks[1].sha256 = Smoke.sha256Buffer(smallBody);
  teacher.engine.networks[1].bytes = smallBody.length;
  return Object.assign({}, base, {
    teacher,
    teacherSha256: Corpus.sha256(Prepare.stableJson(teacher) + '\n')
  });
}

function exportedNetworkTempNames() {
  return fs.readdirSync(os.tmpdir())
    .filter(name => name.startsWith('chessy-sf18-smoke-networks-'))
    .sort();
}

async function main() {
  equal(Smoke.parseArgs([
    '--archive', 'stockfish.tar',
    '--stockfish', 'stockfish',
    '--output', 'smoke'
  ]), {
    archive: 'stockfish.tar',
    stockfish: 'stockfish',
    output: 'smoke'
  });
  throws(
    () => Smoke.parseArgs(['--nodes', '1']),
    /unknown or frozen argument/,
    'the 100k-node smoke cannot be weakened on the CLI'
  );
  throws(
    () => Smoke.parseArgs(['--archive', 'a', '--archive', 'b']),
    /duplicate argument/
  );
  throws(
    () => Smoke.validateOptions({
      archive: 'a',
      stockfish: 'b',
      output: 'c',
      teacher: 'arbitrary'
    }),
    /unknown or frozen option/,
    'programmatic callers cannot replace the frozen teacher'
  );

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'chessy-stockfish-smoke-')
  );
  try {
    const archiveBody = Buffer.from('official-archive-fixture-v1');
    const bigBody = Buffer.from('embedded-big-network-fixture-v1');
    const smallBody = Buffer.from('embedded-small-network-fixture-v1');
    const archive = path.join(temporary, 'stockfish.tar');
    const executable = path.join(temporary, 'stockfish');
    fs.writeFileSync(archive, archiveBody);
    fs.writeFileSync(
      executable,
      fakeEngineSource(bigBody, smallBody),
      { mode: 0o755 }
    );
    fs.chmodSync(executable, 0o755);
    const contracts = fixtureContracts(
      Label.loadFrozenContracts(),
      archiveBody,
      executable,
      bigBody,
      smallBody
    );
    const noReplaceTemporary = path.join(temporary, 'no-replace.tmp');
    const noReplaceFinal = path.join(temporary, 'no-replace.final');
    fs.writeFileSync(noReplaceTemporary, 'new evidence\n');
    fs.writeFileSync(noReplaceFinal, 'existing evidence\n');
    throws(
      () => Smoke.commitNoReplace(noReplaceTemporary, noReplaceFinal),
      /refusing to overwrite smoke artifact/,
      'the atomic commit rejects a destination created after preflight'
    );
    equal(fs.readFileSync(noReplaceFinal, 'utf8'), 'existing evidence\n',
      'the no-replace failure preserves existing evidence');
    equal(fs.readFileSync(noReplaceTemporary, 'utf8'), 'new evidence\n',
      'the no-replace failure leaves its temporary input for cleanup');

    const networkTempsBefore = exportedNetworkTempNames();
    const output = path.join(temporary, 'passed', 'sf18-100kn');
    const provenance = await Smoke.runSmoke({
      archive,
      stockfish: executable,
      output
    }, { contracts });

    equal(provenance.state, 'passed');
    equal(provenance.execution.platform, process.platform);
    equal(provenance.execution.arch, process.arch);
    equal(provenance.execution.node, process.version);
    ok(/^\d{4}-\d\d-\d\dT/.test(provenance.execution.startedAtUtc),
      'provenance records a UTC start time');
    ok(/^\d{4}-\d\d-\d\dT/.test(provenance.execution.completedAtUtc),
      'provenance records a UTC completion time');
    ok(Number.isFinite(provenance.execution.elapsedMs) &&
      provenance.execution.elapsedMs >= 0,
    'provenance records non-negative elapsed milliseconds');
    equal(provenance.result.eligibility, 'eligible-exact-cp');
    equal(provenance.result.scoreNodes, 80000,
      'the latest exact CP may precede the node boundary');
    equal(provenance.result.reportedNodes, 100123,
      'terminal effort must cross the frozen 100k-node boundary');
    equal(provenance.result.nodeLimit, 100000);
    equal(provenance.result.nodeLimitSatisfied, true);
    equal(provenance.result.bestMoveUci, 'e2e4');
    equal(provenance.teacher.archive.actualSha256,
      contracts.teacher.engine.archive.sha256);
    equal(provenance.teacher.executable.actualSha256,
      contracts.teacher.engine.executable.sha256);
    equal(provenance.teacher.networks.length, 2);
    ok(provenance.teacher.networks.every(network => network.verified),
      'both embedded network exports match their pinned bytes and hashes');

    const paths = Smoke.artifactPaths(output);
    ok(fs.statSync(paths.provenance).isFile(),
      'atomic provenance artifact is committed');
    ok(fs.statSync(paths.transcript).isFile(),
      'atomic transcript artifact is committed');
    const written = JSON.parse(fs.readFileSync(paths.provenance, 'utf8'));
    equal(written, provenance,
      'returned provenance is exactly the committed provenance');
    equal(
      await Prepare.fileSha256(paths.transcript),
      provenance.transcript.sha256,
      'provenance authenticates the complete UCI transcript'
    );
    const transcript = fs.readFileSync(paths.transcript, 'utf8');
    ok(transcript.includes('> export_net big.nnue small.nnue'),
      'transcript proves the embedded-network export command ran');
    ok(transcript.includes('> go nodes 100000'),
      'transcript proves the frozen real search command ran');
    ok(transcript.includes('> setoption name UCI_ShowWDL value true'),
      'transcript proves the WDL eligibility input was enabled');
    const exportCwdLine = transcript.split('\n')
      .find(line => line.startsWith('< info string export cwd '));
    ok(exportCwdLine, 'fixture records the network-export directory');
    const exportCwd = exportCwdLine.slice('< info string export cwd '.length);
    const exportRelative = path.relative(path.dirname(output), exportCwd);
    ok(
      exportRelative === '..' ||
        exportRelative.startsWith('..' + path.sep),
      'exported networks are created outside the artifact output directory'
    );
    equal(
      exportedNetworkTempNames(),
      networkTempsBefore,
      'external GPL network temp directories are deleted after verification'
    );
    equal(fs.existsSync(output + '.lock'), false,
      'a successful paired artifact commit releases its prefix lock');
    await rejects(
      () => Smoke.runSmoke({
        archive,
        stockfish: executable,
        output
      }, { contracts }),
      /refusing to overwrite smoke artifact/,
      'an audit record cannot be overwritten by a later run'
    );

    const badContracts = JSON.parse(JSON.stringify(contracts));
    badContracts.teacher.engine.networks[0].sha256 = '0'.repeat(64);
    const failedOutput = path.join(temporary, 'failed', 'sf18-100kn');
    await rejects(
      () => Smoke.runSmoke({
        archive,
        stockfish: executable,
        output: failedOutput
      }, { contracts: badContracts }),
      /does not match the pinned network/,
      'a changed embedded network fails admission before search'
    );
    const failedPaths = Smoke.artifactPaths(failedOutput);
    const failed = JSON.parse(
      fs.readFileSync(failedPaths.provenance, 'utf8')
    );
    equal(failed.state, 'failed');
    equal(failed.teacher.networks[0].verified, false);
    ok(fs.statSync(failedPaths.transcript).isFile(),
      'a failed real smoke retains an atomic diagnostic transcript');
    equal(
      exportedNetworkTempNames(),
      networkTempsBefore,
      'failed external network exports are also removed'
    );
    equal(fs.existsSync(failedOutput + '.lock'), false,
      'a failed smoke also releases its prefix lock');

    const concurrentOutput = path.join(
      temporary, 'concurrent', 'sf18-100kn'
    );
    const concurrentOptions = {
      archive,
      stockfish: executable,
      output: concurrentOutput
    };
    const concurrent = await Promise.allSettled([
      Smoke.runSmoke(concurrentOptions, { contracts }),
      Smoke.runSmoke(concurrentOptions, { contracts })
    ]);
    const winners = concurrent.filter(result => result.status === 'fulfilled');
    const losers = concurrent.filter(result => result.status === 'rejected');
    equal(winners.length, 1,
      'exactly one concurrent run can commit the evidence pair');
    equal(losers.length, 1,
      'the competing run is rejected');
    ok(
      /holds the output prefix lock|refusing to overwrite smoke artifact/.test(
        losers[0].reason.message
      ),
      'the competing run fails at the no-overwrite boundary'
    );
    const concurrentPaths = Smoke.artifactPaths(concurrentOutput);
    const provenanceBeforeRetry =
      fs.readFileSync(concurrentPaths.provenance);
    const transcriptBeforeRetry =
      fs.readFileSync(concurrentPaths.transcript);
    equal(
      JSON.parse(provenanceBeforeRetry.toString('utf8')),
      winners[0].value,
      'the winning run owns the committed provenance'
    );
    await rejects(
      () => Smoke.runSmoke(concurrentOptions, { contracts }),
      /refusing to overwrite smoke artifact/,
      'a later run cannot replace the completed evidence pair'
    );
    equal(
      fs.readFileSync(concurrentPaths.provenance),
      provenanceBeforeRetry,
      'existing provenance remains byte-identical after a refused run'
    );
    equal(
      fs.readFileSync(concurrentPaths.transcript),
      transcriptBeforeRetry,
      'existing transcript remains byte-identical after a refused run'
    );
    equal(fs.existsSync(concurrentOutput + '.lock'), false,
      'concurrent admission leaves no live prefix lock');
    equal(exportedNetworkTempNames(), networkTempsBefore,
      'concurrent admission leaves no exported network directory');

    const attackExecutable = path.join(
      temporary, 'replace-after-verification-stockfish'
    );
    const authenticatedExecutableBody =
      fakeEngineSource(bigBody, smallBody);
    fs.writeFileSync(
      attackExecutable, authenticatedExecutableBody, { mode: 0o755 }
    );
    const attackContracts = fixtureContracts(
      Label.loadFrozenContracts(),
      archiveBody,
      attackExecutable,
      bigBody,
      smallBody
    );
    let observedExecutablePath = null;
    let observedExecutableBody = null;
    class ReplacingEngine {
      constructor(filename, transcript, watchdog, workingDirectory) {
        observedExecutablePath = filename;
        const replacement = attackExecutable + '.replacement';
        fs.writeFileSync(
          replacement,
          authenticatedExecutableBody.replace(
            'Hermetic Stockfish 18 fixture',
            'replacement attacker'
          ),
          { mode: 0o755 }
        );
        fs.renameSync(replacement, attackExecutable);
        observedExecutableBody = fs.readFileSync(filename, 'utf8');
        this.transcript = transcript;
        this.workingDirectory = workingDirectory;
      }

      async initialize() {
        this.transcript.append('< id name authenticated smoke executable');
      }

      async exportNetworks() {
        fs.writeFileSync(
          path.join(this.workingDirectory, 'big.nnue'), bigBody
        );
        fs.writeFileSync(
          path.join(this.workingDirectory, 'small.nnue'), smallBody
        );
        return ['big.nnue', 'small.nnue'];
      }

      async label() {
        return {
          info: {
            depth: 16,
            seldepth: 22,
            cpSideToMove: 23,
            wdlSideToMove: [310, 620, 70],
            nodes: 100000,
            pvUci: ['e2e4', 'e7e5']
          },
          terminalInfo: { nodes: 100000 },
          bestMove: 'e2e4'
        };
      }

      async quit() {}
      async abort() {}
    }
    const attackOutput = path.join(
      temporary, 'replace-after-verification', 'sf18-100kn'
    );
    const attackProvenance = await Smoke.runSmoke({
      archive,
      stockfish: attackExecutable,
      output: attackOutput
    }, {
      contracts: attackContracts,
      Engine: ReplacingEngine
    });
    equal(attackProvenance.state, 'passed',
      'the authenticated executable snapshot completes the smoke');
    ok(observedExecutablePath !== attackExecutable,
      'smoke passes the engine a private verified executable path');
    equal(
      observedExecutableBody,
      authenticatedExecutableBody,
      'atomic pathname replacement cannot change the executable bytes'
    );
    ok(
      fs.readFileSync(attackExecutable, 'utf8')
        .includes('replacement attacker'),
      'the adversarial test confirms the public pathname was replaced'
    );
    equal(
      fs.existsSync(path.dirname(observedExecutablePath)),
      false,
      'smoke narrowly cleans its private executable snapshot'
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log(checks + ' Stockfish smoke contract checks passed');
}

main().catch(function (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
