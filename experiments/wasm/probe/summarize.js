/*
 * Aggregate probe reports (final-*.json + host-report.json) into a Markdown
 * summary for $GITHUB_STEP_SUMMARY. Usage:
 *   node summarize.js <reportsDir> [outFile]
 * Exits 0 always (the individual jobs gate; this only reports).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || 'reports';
const outFile = process.argv[3] || null;

function fmt(n, digits) {
  return typeof n === 'number' && isFinite(n) ? n.toFixed(digits == null ? 2 : digits) : '—';
}

const rows = [];
const fiveBlocks = [];
function walk(d) {
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) { walk(p); continue; }
    if (!name.endsWith('.json')) continue;
    let r;
    try { r = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
    const isHost = name.indexOf('host') >= 0 || (r.node && !r.userAgent);
    const target = (r.config && r.config.target) || (isHost ? 'node-host' : name.replace(/^final-|\.json$/g, ''));
    if (!r.parity && !r.nps) continue;
    rows.push({
      target: target,
      ok: r.ok !== undefined ? r.ok : !(r.parity && r.parity.diverged),
      parity: r.parity ? (r.parity.diverged ? 'FAIL ' + r.parity.diverged + '/' + r.parity.checked
        : 'PASS ' + r.parity.checked) : '—',
      abort: r.abortParity ? (r.abortParity.diverged ? 'FAIL' : 'PASS') : '—',
      geomean: r.nps ? r.nps.geomean : null,
      worst: r.nps && (r.nps.worstFamily ? r.nps.worstFamily.ratio : null),
      worstName: r.nps && r.nps.worstFamily ? r.nps.worstFamily.name : '',
      slower: r.nps ? r.nps.slowerFamilies + '/9' : '—',
      memMiB: r.module && r.module.linearMemoryBytes ? r.module.linearMemoryBytes / 1048576 : null,
      engine: r.userAgent || ('node ' + (r.node || ''))
    });
    if (r.fiveSecond) {
      fiveBlocks.push({ target: target, five: r.fiveSecond });
    }
  }
}
if (fs.existsSync(dir)) walk(dir);

rows.sort(function (a, b) { return a.target < b.target ? -1 : 1; });

let md = '## WASM + Rust mobile-target probe results\n\n';
md += '| target | parity (d1..N) | fixed-node abort | paired NPS geomean | worst family | slower families | wasm memory |\n';
md += '|---|---|---|---:|---|---|---:|\n';
for (const r of rows) {
  md += '| ' + r.target + ' | ' + r.parity + ' | ' + r.abort + ' | ' +
    (r.geomean ? fmt(r.geomean, 4) + 'x' : '—') + ' | ' +
    (r.worst ? fmt(r.worst, 4) + 'x (' + r.worstName + ')' : '—') + ' | ' +
    r.slower + ' | ' + (r.memMiB ? fmt(r.memMiB, 2) + ' MiB' : '—') + ' |\n';
}
md += '\n### Five-second depth diagnostics (wasm vs js)\n\n';
for (const b of fiveBlocks) {
  md += '**' + b.target + '**\n\n';
  for (const f of b.five) {
    md += '- ' + f.name + ': wasm d' + f.wasm.depth + ' (' + f.wasm.nodes +
      ' n) vs js d' + f.js.depth + ' (' + f.js.nodes + ' n)\n';
  }
  md += '\n';
}
md += '\n### Engines\n\n';
for (const r of rows) {
  md += '- **' + r.target + '**: ' + r.engine + '\n';
}
md += [
  '',
  '### Scope of this CI evidence',
  '',
  'These containers/VMs establish **functional reproduction** (exact JS/WASM',
  'search parity and the abort protocol) on the real mobile browser stacks',
  '(Chrome for Android on an x86_64 emulator, Mobile Safari on an arm64 iOS',
  'Simulator) plus engine-family performance signals (V8, JavaScriptCore).',
  'They do **not** establish the physical-device gate from #84/#113:',
  'real ARM SoC wall-time, thermal soak, battery, jetsam/memory pressure and',
  'watchdog behavior still require physical iPhone/Android hardware.',
  ''
].join('\n');

console.log(md);
if (outFile) fs.writeFileSync(outFile, md);
