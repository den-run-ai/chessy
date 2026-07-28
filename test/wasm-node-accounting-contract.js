/*
 * Trusted source contract for fixed-node Rust/WASM experiments.
 *
 * The candidate module reports its own node counters, so the formal and deep
 * gates must reject candidates that change the accounting pipeline. Algorithm
 * code may still add work by recursively calling search_node/quiesce_node;
 * those trusted entry prologues charge every such call.
 *
 * Usage:
 *   node test/wasm-node-accounting-contract.js \
 *     /path/to/trusted/experiments/wasm/src \
 *     /path/to/candidate/experiments/wasm/src
 */
'use strict';

const fs = require('fs');
const path = require('path');

function fail(message) {
  const error = new Error(message);
  error.exitCode = 2;
  throw error;
}

function maskRustNonCode(source) {
  const masked = source.split('');
  let index = 0;
  let blockDepth = 0;

  function blank(start, end) {
    for (let cursor = start; cursor < end; cursor++) {
      if (masked[cursor] !== '\n' && masked[cursor] !== '\r') {
        masked[cursor] = ' ';
      }
    }
  }

  while (index < source.length) {
    if (blockDepth > 0) {
      if (source.startsWith('/*', index)) {
        blank(index, index + 2);
        blockDepth++;
        index += 2;
      } else if (source.startsWith('*/', index)) {
        blank(index, index + 2);
        blockDepth--;
        index += 2;
      } else {
        blank(index, index + 1);
        index++;
      }
      continue;
    }

    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index);
      const limit = end === -1 ? source.length : end;
      blank(index, limit);
      index = limit;
      continue;
    }
    if (source.startsWith('/*', index)) {
      blank(index, index + 2);
      blockDepth = 1;
      index += 2;
      continue;
    }

    const raw = /^(?:b?r)(#*)"/.exec(source.slice(index));
    if (raw) {
      const closing = '"' + raw[1];
      const contentStart = index + raw[0].length;
      const closeAt = source.indexOf(closing, contentStart);
      if (closeAt === -1) fail('unterminated Rust raw string');
      const end = closeAt + closing.length;
      blank(index, end);
      index = end;
      continue;
    }

    const stringPrefix = source.startsWith('b"', index) ? 2 :
      source[index] === '"' ? 1 : 0;
    if (stringPrefix) {
      let cursor = index + stringPrefix;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2;
        } else if (source[cursor] === '"') {
          cursor++;
          break;
        } else {
          cursor++;
        }
      }
      if (cursor > source.length || source[cursor - 1] !== '"') {
        fail('unterminated Rust string');
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }

    if (source[index] === '\'') {
      let cursor = index + 1;
      if (source[cursor] === '\\') cursor += 2;
      else cursor++;
      if (source[cursor] === '\'') {
        cursor++;
        blank(index, cursor);
        index = cursor;
        continue;
      }
    }
    index++;
  }
  if (blockDepth !== 0) fail('unterminated Rust block comment');
  return masked.join('');
}

function extractFunction(source, name) {
  const masked = maskRustNonCode(source);
  const expression = new RegExp('\\bfn\\s+' + name + '\\s*\\(', 'g');
  const matches = Array.from(masked.matchAll(expression));
  if (matches.length !== 1) {
    fail('expected exactly one Rust function ' + name +
      ', found ' + matches.length);
  }
  const fnIndex = matches[0].index;
  let start = source.lastIndexOf('\n', fnIndex) + 1;
  let previousEnd = start > 0 ? start - 1 : 0;
  while (start > 0) {
    const previousStart = source.lastIndexOf('\n', previousEnd - 1) + 1;
    const previous = source.slice(previousStart, previousEnd).trim();
    if (!previous.startsWith('#[')) break;
    start = previousStart;
    previousEnd = start > 0 ? start - 1 : 0;
  }
  const open = masked.indexOf('{', fnIndex);
  if (open === -1) fail('Rust function ' + name + ' has no body');
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    if (masked[index] === '{') depth++;
    if (masked[index] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
      if (depth < 0) break;
    }
  }
  fail('Rust function ' + name + ' has an unbalanced body');
}

function extractBracedItem(source, label, expression) {
  const masked = maskRustNonCode(source);
  const matches = Array.from(masked.matchAll(expression));
  if (matches.length !== 1) {
    fail('expected exactly one Rust ' + label + ', found ' + matches.length);
  }
  let start = source.lastIndexOf('\n', matches[0].index) + 1;
  let previousEnd = start > 0 ? start - 1 : 0;
  while (start > 0) {
    const previousStart = source.lastIndexOf('\n', previousEnd - 1) + 1;
    const previous = source.slice(previousStart, previousEnd).trim();
    if (!previous.startsWith('#[')) break;
    start = previousStart;
    previousEnd = start > 0 ? start - 1 : 0;
  }
  const open = masked.indexOf('{', matches[0].index);
  if (open === -1) fail('Rust ' + label + ' has no braced body');
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    if (masked[index] === '{') depth++;
    if (masked[index] === '}') {
      depth--;
      if (depth === 0) {
        const semicolon = masked.slice(index + 1).match(/^\s*;/);
        const end = semicolon ? index + 1 + semicolon[0].length : index + 1;
        return source.slice(start, end);
      }
      if (depth < 0) break;
    }
  }
  fail('Rust ' + label + ' has an unbalanced body');
}

function prefixThrough(source, name, marker) {
  const fn = extractFunction(source, name);
  const first = fn.indexOf(marker);
  if (first === -1) {
    fail('missing ' + JSON.stringify(marker) +
      ' marker in Rust function ' + name);
  }
  return fn.slice(0, first + marker.length);
}

function withoutCfgTestModules(source) {
  const masked = maskRustNonCode(source);
  const output = source.split('');
  const expression =
    /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*mod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/g;
  for (const match of masked.matchAll(expression)) {
    const open = masked.indexOf('{', match.index);
    let depth = 0;
    let end = -1;
    for (let index = open; index < masked.length; index++) {
      if (masked[index] === '{') depth++;
      if (masked[index] === '}') {
        depth--;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end === -1) fail('unbalanced #[cfg(test)] Rust module');
    for (let index = match.index; index < end; index++) {
      if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' ';
    }
  }
  return output.join('');
}

function accountingLines(source) {
  source = withoutCfgTestModules(source);
  const maskedLines = maskRustNonCode(source).split(/\r?\n/);
  const sourceLines = source.replace(/\r\n/g, '\n').split('\n');
  return maskedLines.reduce(function (lines, masked, index) {
    if (/\.(?:nodes|qnodes|node_limit)\s*(?:[+\-*/%]?=)/.test(masked) ||
        /^\s*(?:nodes|qnodes|node_limit)\s*:/.test(masked)) {
      lines.push(sourceLines[index].trim());
    }
    return lines;
  }, []);
}

function escapeLines(source) {
  source = withoutCfgTestModules(source);
  const maskedLines = maskRustNonCode(source).split(/\r?\n/);
  const sourceLines = source.replace(/\r\n/g, '\n').split('\n');
  return maskedLines.reduce(function (lines, masked, index) {
    if (/\bCONTEXT\b/.test(masked) ||
        /\b(?:core|std)::ptr::/.test(masked) ||
        /\b(?:core|std)::arch::/.test(masked) ||
        /\b(?:include|include_bytes|include_str)!\s*\(/.test(masked) ||
        /\bmacro_rules\s*!/.test(masked) ||
        /#\s*\[\s*path\s*=/.test(masked) ||
        /#\s*\[\s*(?:export_name|link_name)\b/.test(masked) ||
        /\blet\s+(?:mut\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*context\(\)(?!\.)/.test(masked) ||
        /\bcontext\(\)(?!\s*\.)/.test(masked) ||
        /&\s*mut[^\n;]*\.(?:nodes|qnodes|node_limit)\b/.test(masked) ||
        /\.(?:nodes|qnodes|node_limit)\s*\./.test(masked) ||
        /\bContext\s*\{/.test(masked)) {
      lines.push(sourceLines[index].trim());
    }
    return lines;
  }, []);
}

function criticalUseProjection(source) {
  source = withoutCfgTestModules(source);
  const tokens = maskRustNonCode(source).match(
    /[A-Za-z_][A-Za-z0-9_]*|::|->|=>|\+=|-=|\*=|\/=|%=|==|!=|<=|>=|&&|\|\||[^\s]/g
  ) || [];
  const critical = new Set(['node_limit', 'nodes', 'qnodes']);
  const assignments = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
  const projected = [];
  for (let index = 0; index < tokens.length; index++) {
    if (!critical.has(tokens[index])) continue;
    const directContextRead =
      tokens[index - 4] === 'context' &&
      tokens[index - 3] === '(' &&
      tokens[index - 2] === ')' &&
      tokens[index - 1] === '.' &&
      !assignments.has(tokens[index + 1]) &&
      tokens[index + 1] !== '.';
    const nearby = tokens.slice(Math.max(0, index - 8), index);
    const mutableOrMacro =
      nearby.includes('mut') || nearby.includes('!');
    if (directContextRead && !mutableOrMacro) continue;
    projected.push(tokens.slice(
      Math.max(0, index - 4), Math.min(tokens.length, index + 5)
    ).join(' '));
  }
  return projected;
}

function moduleLines(source) {
  source = withoutCfgTestModules(source);
  const maskedLines = maskRustNonCode(source).split(/\r?\n/);
  const sourceLines = source.replace(/\r\n/g, '\n').split('\n');
  return maskedLines.reduce(function (lines, masked, index) {
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+[A-Za-z_][A-Za-z0-9_]*/.test(
      masked)) {
      lines.push(sourceLines[index].trim());
    }
    return lines;
  }, []);
}

function checkBudgetCallCount(source) {
  const masked = maskRustNonCode(withoutCfgTestModules(source));
  return (masked.match(/\bcheck_budget\s*\(/g) || []).length;
}

function resetContextCallCount(source) {
  const masked = maskRustNonCode(withoutCfgTestModules(source));
  return (masked.match(/\breset_context\s*\(/g) || []).length;
}

function compare(label, trusted, candidate) {
  if (trusted !== candidate) {
    fail('candidate changed trusted WASM node accounting: ' + label);
  }
}

function sourceFiles(sources, fallback) {
  if (sources.files) return sources.files;
  return Object.assign(Object.create(null), fallback || {}, {
    'lib.rs': sources.lib,
    'search.rs': sources.search
  });
}

function projectFiles(files, projector) {
  return Object.keys(files).sort().reduce(function (projected, name) {
    return projected.concat(projector(files[name]).map(function (value) {
      return name + ': ' + value;
    }));
  }, []);
}

function validateSources(trusted, candidate) {
  const trustedFiles = sourceFiles(trusted);
  const candidateFiles = sourceFiles(candidate, trustedFiles);
  compare('Rust source file set',
    JSON.stringify(Object.keys(trustedFiles).sort()),
    JSON.stringify(Object.keys(candidateFiles).sort()));
  for (const name of ['search', 'check_budget', 'run']) {
    const trustedSource = name === 'search' ? trusted.lib : trusted.search;
    const candidateSource = name === 'search' ? candidate.lib : candidate.search;
    compare(name + ' function',
      extractFunction(trustedSource, name),
      extractFunction(candidateSource, name));
  }

  for (const name of ['result_ptr']) {
    compare(name + ' function',
      extractFunction(trusted.lib, name),
      extractFunction(candidate.lib, name));
  }
  compare('context function',
    extractFunction(trusted.search, 'context'),
    extractFunction(candidate.search, 'context'));
  compare('AbiResult layout',
    extractBracedItem(
      trusted.lib, 'AbiResult struct', /\bstruct\s+AbiResult\s*\{/g),
    extractBracedItem(
      candidate.lib, 'AbiResult struct', /\bstruct\s+AbiResult\s*\{/g));
  compare('RESULT storage',
    extractBracedItem(
      trusted.lib, 'RESULT static', /\bstatic\s+mut\s+RESULT\s*:/g),
    extractBracedItem(
      candidate.lib, 'RESULT static', /\bstatic\s+mut\s+RESULT\s*:/g));
  compare('SearchResult fields',
    extractBracedItem(
      trusted.search, 'SearchResult struct', /\bstruct\s+SearchResult\s*\{/g),
    extractBracedItem(
      candidate.search, 'SearchResult struct', /\bstruct\s+SearchResult\s*\{/g));
  compare('StopReason values',
    extractBracedItem(
      trusted.search, 'StopReason enum', /\benum\s+StopReason\s*\{/g),
    extractBracedItem(
      candidate.search, 'StopReason enum', /\benum\s+StopReason\s*\{/g));
  compare('reset_context accounting prefix',
    prefixThrough(
      trusted.search, 'reset_context',
      'ctx.researches = 0;'),
    prefixThrough(
      candidate.search, 'reset_context',
      'ctx.researches = 0;'));
  compare('search_node accounting prologue',
    prefixThrough(
      trusted.search, 'search_node',
      'context().rep_ply = REP_INFINITY;'),
    prefixThrough(
      candidate.search, 'search_node',
      'context().rep_ply = REP_INFINITY;'));
  compare('quiesce_node accounting prologue',
    prefixThrough(
      trusted.search, 'quiesce_node',
      'context().qnodes += 1;'),
    prefixThrough(
      candidate.search, 'quiesce_node',
      'context().qnodes += 1;'));
  compare('node counter declarations, writes, and result fields',
    JSON.stringify(projectFiles(trustedFiles, accountingLines)),
    JSON.stringify(projectFiles(candidateFiles, accountingLines)));
  compare('check_budget call count',
    checkBudgetCallCount(trusted.search),
    checkBudgetCallCount(candidate.search));
  compare('reset_context production call count',
    resetContextCallCount(trusted.search),
    resetContextCallCount(candidate.search));
  compare('search module binding',
    (maskRustNonCode(trusted.lib).match(/^\s*mod\s+search\s*;.*$/gm) || []).join('\n'),
    (maskRustNonCode(candidate.lib).match(/^\s*mod\s+search\s*;.*$/gm) || []).join('\n'));
  compare('production module declarations',
    JSON.stringify(projectFiles(trustedFiles, moduleLines)),
    JSON.stringify(projectFiles(candidateFiles, moduleLines)));
  compare('raw accounting escape surface',
    JSON.stringify(projectFiles(trustedFiles, escapeLines)),
    JSON.stringify(projectFiles(candidateFiles, escapeLines)));
  compare('classified critical identifier uses',
    JSON.stringify(projectFiles(trustedFiles, criticalUseProjection)),
    JSON.stringify(projectFiles(candidateFiles, criticalUseProjection)));
  return true;
}

function readSources(directory) {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail('Rust source path must be a real directory: ' + directory);
  }
  const files = Object.create(null);
  for (const name of fs.readdirSync(directory).filter(function (entry) {
    return entry.endsWith('.rs');
  }).sort()) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('Rust source must be a real file: ' + file);
    }
    files[name] = fs.readFileSync(file, 'utf8');
  }
  if (!files['lib.rs'] || !files['search.rs']) {
    fail('Rust source directory must contain lib.rs and search.rs');
  }
  return {
    lib: files['lib.rs'],
    search: files['search.rs'],
    files: files
  };
}

function main(argv) {
  if (argv.length !== 2) {
    fail('usage: wasm-node-accounting-contract.js TRUSTED_SRC CANDIDATE_SRC');
  }
  validateSources(readSources(argv[0]), readSources(argv[1]));
  console.log('trusted WASM node-accounting contract verified');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode || 1);
  }
}

module.exports = Object.freeze({
  maskRustNonCode: maskRustNonCode,
  extractFunction: extractFunction,
  accountingLines: accountingLines,
  escapeLines: escapeLines,
  criticalUseProjection: criticalUseProjection,
  moduleLines: moduleLines,
  withoutCfgTestModules: withoutCfgTestModules,
  validateSources: validateSources,
  readSources: readSources
});
