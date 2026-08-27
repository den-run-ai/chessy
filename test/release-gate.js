/*
 * Release-token gate shared by pull-request CI and the main-branch deploy.
 *
 * Versioned runtime URLs are immutable. Any executable change in assets/, the
 * app shell, or the service worker therefore requires a strictly newer rN
 * token than the current base-branch tip (PR) or previous deployed commit
 * (push). This script deliberately receives both comparison commits from the
 * workflow so merge-base changes and token chronology cannot be conflated.
 */
'use strict';

const cp = require('child_process');

function releaseNumber(source) {
  const matches = Array.from(String(source).matchAll(/^const RELEASE = 'r(\d+)';$/gm));
  return matches.length === 1 ? Number(matches[0][1]) : null;
}

function releaseSignificant(path) {
  return path === 'index.html' || path === 'sw.js' || path.startsWith('assets/');
}

function evaluateRelease(paths, baseSource, headSource) {
  const changed = paths.filter(releaseSignificant);
  if (changed.length === 0) {
    return { ok: true, changed: changed, message: 'executable runtime unchanged — no bump required' };
  }
  const base = releaseNumber(baseSource);
  const head = releaseNumber(headSource);
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(head)) {
    return { ok: false, changed: changed,
      message: 'sw.js must contain exactly one numeric RELEASE token in the form rN' };
  }
  if (head <= base) {
    return { ok: false, changed: changed,
      message: 'executable runtime changed: RELEASE must increase (r' + base + ' -> r' + head + ')' };
  }
  return { ok: true, changed: changed,
    message: 'executable runtime changed: RELEASE increased (r' + base + ' -> r' + head + ')' };
}

function git(args) {
  return cp.execFileSync('git', args, { encoding: 'utf8' });
}

function option(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1 || at + 1 >= argv.length || argv.indexOf(name, at + 1) !== -1) {
    throw new Error('usage: node test/release-gate.js --changes-base REF --token-base REF --head REF');
  }
  return argv[at + 1];
}

function main(argv) {
  const changesBase = option(argv, '--changes-base');
  const tokenBase = option(argv, '--token-base');
  const head = option(argv, '--head');
  const paths = git(['diff', '--name-only', '--diff-filter=ACMRD', changesBase, head])
    .split('\n').filter(Boolean);
  const verdict = evaluateRelease(
    paths,
    git(['show', tokenBase + ':sw.js']),
    git(['show', head + ':sw.js']));
  console.log(verdict.message);
  if (verdict.changed.length) console.log('release-significant paths:\n' + verdict.changed.join('\n'));
  if (!verdict.ok) process.exitCode = 1;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 2;
  }
}

module.exports = { releaseNumber, releaseSignificant, evaluateRelease };
