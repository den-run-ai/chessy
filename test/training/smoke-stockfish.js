#!/usr/bin/env node
/*
 * Reproducible, real-engine admission smoke for the pinned Stockfish teacher.
 *
 * This is intentionally separate from corpus labelling. It proves that the
 * official archive, executable, both embedded NNUEs, UCI watchdog path, fixed
 * 100k-node search, exact-score eligibility rules, and audit artifacts work
 * together before production compute is admitted.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Corpus = require('./corpus');
const Prepare = require('./prepare-lichess-evals');
const Label = require('./label-stockfish');

const ROOT = path.join(__dirname, '..', '..');
const SMOKE_CASE = Object.freeze({
  id: 'standard-start-white',
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
});
const ALLOWED_ARGS = new Set(['archive', 'stockfish', 'output']);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      throw new Error('unexpected argument: ' + item);
    }
    const name = item.slice(2);
    if (!ALLOWED_ARGS.has(name)) {
      throw new Error('unknown or frozen argument: --' + name);
    }
    if (Object.prototype.hasOwnProperty.call(options, name)) {
      throw new Error('duplicate argument: --' + name);
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(item + ' requires a value');
    }
    options[name] = argv[++index];
  }
  return options;
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('smoke options are required');
  }
  for (const name of Object.keys(options)) {
    if (!ALLOWED_ARGS.has(name)) {
      throw new Error('unknown or frozen option: ' + name);
    }
  }
  for (const name of ALLOWED_ARGS) {
    if (typeof options[name] !== 'string' || !options[name]) {
      throw new Error('--' + name + ' is required');
    }
  }
}

function requireRegularFile(filename, option) {
  let stat;
  try {
    stat = fs.statSync(filename);
  } catch (_) {
    throw new Error('--' + option + ' must name a readable file');
  }
  if (!stat.isFile()) {
    throw new Error('--' + option + ' must name a regular file');
  }
  return stat;
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function artifactPaths(prefix) {
  return {
    provenance: prefix + '.provenance.json',
    transcript: prefix + '.uci.log'
  };
}

function isWithinDirectory(filename, directory) {
  const relative = path.relative(directory, filename);
  return relative === '' ||
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative);
}

function refuseExisting(paths) {
  const existing = Object.values(paths).filter(filename => fs.existsSync(filename));
  if (existing.length) {
    throw new Error('refusing to overwrite smoke artifact: ' + existing.join(', '));
  }
}

function acquirePrefixLock(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(
        'another Stockfish smoke run holds the output prefix lock: ' + filename
      );
    }
    throw error;
  }
  try {
    const body = Prepare.stableJson({
      pid: process.pid,
      startedAtUtc: new Date().toISOString()
    }) + '\n';
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    return fd;
  } catch (error) {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(filename); } catch (_) {}
    throw error;
  }
}

function releasePrefixLock(fd, filename) {
  try {
    const held = fs.fstatSync(fd);
    let current = null;
    try { current = fs.statSync(filename); } catch (_) {}
    if (current && current.dev === held.dev && current.ino === held.ino) {
      fs.unlinkSync(filename);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function commitNoReplace(temporaryName, filename) {
  try {
    fs.linkSync(temporaryName, filename);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('refusing to overwrite smoke artifact: ' + filename);
    }
    throw error;
  }
  fs.unlinkSync(temporaryName);
}

function writeAtomicJson(filename, value, temporaryName) {
  const body = Prepare.stableJson(value) + '\n';
  const fd = fs.openSync(temporaryName, 'wx');
  try {
    const written = fs.writeSync(fd, body);
    if (written !== Buffer.byteLength(body)) {
      throw new Error('short write while writing smoke provenance');
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  commitNoReplace(temporaryName, filename);
}

function frozenExportCommand(teacher) {
  const commands = new Set(
    teacher.engine.networks.map(network => network.exportCommand)
  );
  if (commands.size !== 1) {
    throw new Error('pinned networks do not share one export command');
  }
  const command = Array.from(commands)[0];
  if (!/^export_net [A-Za-z0-9._-]+ [A-Za-z0-9._-]+$/.test(command)) {
    throw new Error('pinned network export command is not safe');
  }
  return command;
}

function executionProvenance(startedAtUtc, startedNanoseconds) {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    startedAtUtc,
    completedAtUtc: new Date().toISOString(),
    elapsedMs: Number(process.hrtime.bigint() - startedNanoseconds) / 1e6
  };
}

function baseProvenance(
  contracts, evidence, paths, transcriptSummary, execution
) {
  const teacher = contracts.teacher;
  return {
    schemaVersion: 1,
    smoke: 'stockfish-teacher-admission',
    adapter: {
      labeler: path.relative(ROOT, require.resolve('./label-stockfish')),
      labelerSha256: Corpus.sha256(fs.readFileSync(require.resolve('./label-stockfish'))),
      smokeEntryPoint: path.relative(ROOT, __filename),
      smokeEntryPointSha256: Corpus.sha256(fs.readFileSync(__filename))
    },
    case: {
      id: SMOKE_CASE.id,
      fen: SMOKE_CASE.fen
    },
    execution,
    teacher: {
      manifest: {
        path: 'eval/training/teacher-sf18-100kn-v1.json',
        sha256: contracts.teacherSha256
      },
      id: teacher.id,
      release: teacher.engine.release,
      commit: teacher.engine.sourceCommit,
      archive: {
        url: teacher.engine.archive.url,
        filename: path.basename(evidence.archive.path),
        expectedSha256: teacher.engine.archive.sha256,
        actualSha256: evidence.archive.sha256,
        bytes: evidence.archive.bytes
      },
      executable: {
        archivePath: teacher.engine.executable.archivePath,
        expectedSha256: teacher.engine.executable.sha256,
        actualSha256: evidence.executable.sha256,
        bytes: evidence.executable.bytes
      },
      networks: evidence.networks,
      options: teacher.uci,
      search: teacher.search,
      watchdog: teacher.watchdog
    },
    transcript: transcriptSummary ? {
      path: path.basename(paths.transcript),
      rows: transcriptSummary.rows,
      sha256: transcriptSummary.sha256
    } : null
  };
}

function resultProvenance(result, assessment, nodeLimit) {
  const info = result.info;
  const terminalInfo = result.terminalInfo || info;
  return {
    eligibility: 'eligible-exact-cp',
    cpWhite: assessment.pov.cpWhite,
    wdlWhite: assessment.pov.wdlWhite,
    targetWhite: assessment.pov.targetWhite,
    bestMoveUci: result.bestMove,
    pvUci: info.pvUci,
    depth: info.depth,
    seldepth: info.seldepth,
    scoreNodes: info.nodes,
    reportedNodes: terminalInfo.nodes,
    nodeLimit,
    nodeLimitSatisfied: terminalInfo.nodes >= nodeLimit
  };
}

async function verifyNetworkExports(teacher, filenames, directory) {
  if (filenames.length !== teacher.engine.networks.length) {
    throw new Error('network export did not return every pinned network');
  }
  const evidence = [];
  for (let index = 0; index < filenames.length; index++) {
    const expected = teacher.engine.networks[index];
    const filename = path.join(directory, filenames[index]);
    let stat;
    try {
      stat = fs.statSync(filename);
    } catch (_) {
      throw new Error('Stockfish did not export ' + expected.option);
    }
    if (!stat.isFile()) {
      throw new Error('Stockfish network export is not a regular file');
    }
    const actualSha256 = await Prepare.fileSha256(filename);
    const item = {
      option: expected.option,
      embeddedName: expected.embeddedName,
      exportFilename: filenames[index],
      expectedSha256: expected.sha256,
      actualSha256,
      expectedBytes: expected.bytes,
      actualBytes: stat.size,
      verified: actualSha256 === expected.sha256 && stat.size === expected.bytes
    };
    evidence.push(item);
    if (!item.verified) {
      const error = new Error(
        'exported ' + expected.option + ' does not match the pinned network'
      );
      error.networkEvidence = evidence;
      throw error;
    }
  }
  return evidence;
}

async function runSmoke(options, dependencies) {
  const startedAtUtc = new Date().toISOString();
  const startedNanoseconds = process.hrtime.bigint();
  validateOptions(options);
  const deps = dependencies || {};
  const contracts = deps.contracts || Label.loadFrozenContracts();
  const Engine = deps.Engine || Label.UciEngine;
  const archive = path.resolve(options.archive);
  const executable = path.resolve(options.stockfish);
  const prefix = path.resolve(options.output);
  const paths = artifactPaths(prefix);
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const lockPath = prefix + '.lock';
  const lockFd = acquirePrefixLock(lockPath);
  let stagedExecutable = null;
  try {
    refuseExisting(paths);
    const archiveStat = requireRegularFile(archive, 'archive');
    const archiveSha256 = await Prepare.fileSha256(archive);
    if (archiveSha256 !== contracts.teacher.engine.archive.sha256) {
      throw new Error(
        'Stockfish archive does not match the checked-in teacher manifest'
      );
    }
    stagedExecutable = Label.stageVerifiedExecutable(
      executable, contracts.teacher.engine.executable.sha256
    );
    const executableSha256 = stagedExecutable.sha256;

    const nonce = process.pid + '-' + crypto.randomBytes(8).toString('hex');
    const transcriptTemporary = paths.transcript + '.tmp-' + nonce;
    const provenanceTemporary = paths.provenance + '.tmp-' + nonce;
    const outputDirectory = fs.realpathSync(path.dirname(prefix));
    const systemTemporaryDirectory = fs.realpathSync(os.tmpdir());
    if (isWithinDirectory(systemTemporaryDirectory, outputDirectory)) {
      throw new Error(
        'smoke output directory cannot contain the system temporary directory'
      );
    }
    const networkDirectory = fs.mkdtempSync(
      path.join(systemTemporaryDirectory, 'chessy-sf18-smoke-networks-')
    );
    const transcript = new Label.LineArtifact(transcriptTemporary);
    const evidence = {
      archive: {
        path: archive,
        sha256: archiveSha256,
        bytes: archiveStat.size
      },
      executable: {
        sha256: executableSha256,
        bytes: stagedExecutable.bytes
      },
      networks: []
    };
    let engine = null;
    let transcriptSummary = null;
    try {
      engine = new Engine(
        stagedExecutable,
        transcript,
        contracts.teacher.watchdog,
        networkDirectory
      );
      await engine.initialize(contracts.teacher.uci);
      const exportCommand = frozenExportCommand(contracts.teacher);
      const filenames = await engine.exportNetworks(exportCommand);
      evidence.networks = await verifyNetworkExports(
        contracts.teacher, filenames, networkDirectory
      );
      const result = await engine.label(
        SMOKE_CASE.fen,
        contracts.teacher.search.nodeLimit,
        contracts.teacher.uci
      );
      const assessment = Label.assessTeacherResult(
        result,
        Corpus.parseFen4(SMOKE_CASE.fen).turn,
        contracts.teacher
      );
      if (!assessment.eligible) {
        const error = new Error(
          'Stockfish smoke result is ineligible: ' + assessment.reason
        );
        error.assessment = assessment;
        throw error;
      }
      await engine.quit();
      engine = null;
      transcriptSummary = transcript.finish();
      const provenance = Object.assign(
        baseProvenance(
          contracts,
          evidence,
          paths,
          transcriptSummary,
          executionProvenance(startedAtUtc, startedNanoseconds)
        ),
        {
          state: 'passed',
          result: resultProvenance(
            result, assessment, contracts.teacher.search.nodeLimit
          )
        }
      );
      commitNoReplace(transcriptTemporary, paths.transcript);
      writeAtomicJson(paths.provenance, provenance, provenanceTemporary);
      return provenance;
    } catch (error) {
      if (engine) {
        try { await engine.abort(); } catch (_) {}
      }
      if (error.networkEvidence) {
        evidence.networks = error.networkEvidence;
      }
      try {
        transcriptSummary = transcript.finish();
      } catch (_) {
        transcript.abort();
      }
      if (transcriptSummary) {
        try {
          commitNoReplace(transcriptTemporary, paths.transcript);
          const provenance = Object.assign(
            baseProvenance(
              contracts,
              evidence,
              paths,
              transcriptSummary,
              executionProvenance(startedAtUtc, startedNanoseconds)
            ),
            {
              state: 'failed',
              failure: {
                name: error.name,
                message: error.message,
                assessment: error.assessment || null
              }
            }
          );
          writeAtomicJson(paths.provenance, provenance, provenanceTemporary);
        } catch (_) {
          try { fs.unlinkSync(provenanceTemporary); } catch (_) {}
        }
      }
      throw error;
    } finally {
      fs.rmSync(networkDirectory, { recursive: true, force: true });
      try { fs.unlinkSync(transcriptTemporary); } catch (_) {}
      try { fs.unlinkSync(provenanceTemporary); } catch (_) {}
    }
  } finally {
    try {
      if (stagedExecutable) {
        Label.cleanupVerifiedExecutable(stagedExecutable);
      }
    } finally {
      releasePrefixLock(lockFd, lockPath);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const name of ALLOWED_ARGS) {
    if (!options[name]) throw new Error('--' + name + ' is required');
  }
  const provenance = await runSmoke(options);
  console.log('Stockfish 18 teacher smoke passed');
  console.log('exact-score eligibility ' + provenance.result.eligibility);
  console.log(
    'score nodes ' + provenance.result.scoreNodes +
    ', reported nodes ' + provenance.result.reportedNodes
  );
  console.log('provenance ' + path.resolve(options.output) + '.provenance.json');
  console.log('transcript ' + path.resolve(options.output) + '.uci.log');
}

if (require.main === module) {
  main().catch(function (error) {
    console.error('smoke-stockfish: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  SMOKE_CASE,
  parseArgs,
  validateOptions,
  artifactPaths,
  commitNoReplace,
  frozenExportCommand,
  resultProvenance,
  verifyNetworkExports,
  runSmoke,
  sha256Buffer
};
