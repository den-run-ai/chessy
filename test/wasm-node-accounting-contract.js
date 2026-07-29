/*
 * Trusted source contract for fixed-node Rust/WASM experiments.
 *
 * The candidate module reports its own node counters, so the formal and deep
 * gates must reject candidates that change the accounting pipeline. Algorithm
 * code may still add work by recursively calling search_node/quiesce_node;
 * those trusted entry prologues charge every such call.
 *
 * Scope: this contract is a lexical tripwire for the known classes of
 * accounting bypass (counter rewrites, raw-pointer/macro escapes, ABI
 * clamps, whole-Context replacement, import aliasing, unmetered recursive
 * helpers). Lexical analysis of a general-purpose language cannot be
 * adversarially complete, so a clean contract run is necessary but not
 * sufficient evidence: final admission authority for the formal gate remains
 * the maintainer's review of the exact candidate diff before applying the run
 * label. New evasion patterns are handled by extending the tripwire, not by
 * treating the contract as a proof.
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

function extractAllBracedItems(source, expression) {
  const masked = maskRustNonCode(source);
  const items = [];
  for (const match of masked.matchAll(expression)) {
    let start = source.lastIndexOf('\n', match.index) + 1;
    let previousEnd = start > 0 ? start - 1 : 0;
    while (start > 0) {
      const previousStart = source.lastIndexOf('\n', previousEnd - 1) + 1;
      const previous = source.slice(previousStart, previousEnd).trim();
      if (!previous.startsWith('#[')) break;
      start = previousStart;
      previousEnd = start > 0 ? start - 1 : 0;
    }
    const open = masked.indexOf('{', match.index);
    if (open === -1) fail('Rust item has no braced body');
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
        if (depth < 0) break;
      }
    }
    if (end === -1) fail('Rust item has an unbalanced body');
    items.push(source.slice(start, end));
  }
  return items;
}

function functionDefinitions(source, file) {
  const production = withoutCfgTestModules(source);
  const masked = maskRustNonCode(production);
  const impls = [];
  for (const match of masked.matchAll(/\bimpl\b/g)) {
    const open = masked.indexOf('{', match.index);
    const semicolon = masked.indexOf(';', match.index);
    if (open === -1 || (semicolon !== -1 && semicolon < open)) continue;
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
    if (end === -1) fail('Rust impl has an unbalanced body');
    const header = masked.slice(match.index, open).replace(/\s+/g, ' ');
    const traitImpl = /\bfor\s+([A-Za-z_][A-Za-z0-9_:]*)/.exec(header);
    let owner;
    if (traitImpl) {
      owner = traitImpl[1].split('::').pop();
    } else {
      let rest = header.slice('impl'.length).trim();
      if (rest.startsWith('<')) {
        let angles = 0;
        let cursor = 0;
        for (; cursor < rest.length; cursor++) {
          if (rest[cursor] === '<') angles++;
          if (rest[cursor] === '>') {
            angles--;
            if (angles === 0) {
              cursor++;
              break;
            }
          }
        }
        rest = rest.slice(cursor).trim();
      }
      const inherent = /^([A-Za-z_][A-Za-z0-9_:]*)/.exec(rest);
      owner = inherent ? inherent[1].split('::').pop() : null;
    }
    impls.push({ open: open, end: end, owner: owner });
  }

  const expression = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  const definitions = [];
  for (const match of masked.matchAll(expression)) {
    let parentheses = 0;
    let brackets = 0;
    let angles = 0;
    let open = -1;
    let declaration = false;
    for (let index = match.index; index < masked.length; index++) {
      const token = masked[index];
      if (token === '(') parentheses++;
      else if (token === ')') parentheses--;
      else if (token === '[') brackets++;
      else if (token === ']') brackets--;
      else if (token === '<') angles++;
      else if (token === '>' && angles > 0) angles--;
      else if (parentheses === 0 && brackets === 0 && angles === 0) {
        if (token === '{') {
          open = index;
          break;
        }
        if (token === ';') {
          declaration = true;
          break;
        }
      }
    }
    if (declaration) continue;
    if (open === -1) fail('Rust function ' + match[1] + ' has no body');
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
    if (end === -1) {
      fail('Rust function ' + match[1] + ' has an unbalanced body');
    }
    const enclosingFunction = definitions.find(function (item) {
      return item.open < match.index && match.index < item.end;
    });
    const enclosingImpl = impls.find(function (item) {
      return item.open < match.index && match.index < item.end;
    });
    const owner = !enclosingFunction && enclosingImpl ?
      enclosingImpl.owner : null;
    definitions.push({
      id: file + ':' + (owner || '<free>') + ':' +
        match[1] + ':' + match.index,
      file: file,
      module: path.basename(file, '.rs'),
      owner: owner,
      name: match[1],
      body: production.slice(open + 1, end - 1),
      open: open,
      end: end
    });
  }
  return definitions;
}

function unmeteredRecursionCycles(files) {
  const definitions = Object.keys(files).sort().reduce(function (all, file) {
    return all.concat(functionDefinitions(files[file], file));
  }, []);
  const byId = new Map();
  for (const definition of definitions) {
    byId.set(definition.id, definition);
  }

  // The frozen prologues charge every entry through these exact functions.
  // Remove them from the graph: any cycle left behind can recur without
  // passing through a trusted node charge.
  function isMetered(definition) {
    return definition.file === 'search.rs' &&
      definition.owner === null &&
      (definition.name === 'search_node' ||
       definition.name === 'quiesce_node');
  }
  const graph = new Map();
  const modules = new Set(definitions.map(function (definition) {
    return definition.module;
  }));

  function hasFunctionReference(definition, target, body) {
    const name = target.name;
    const expression = new RegExp('\\b' + name + '\\b', 'g');
    for (const match of body.matchAll(expression)) {
      const before = body.slice(0, match.index);
      const after = body.slice(match.index + name.length);
      const ufcs =
        /<\s*([A-Za-z_][A-Za-z0-9_:]*)\s+as\s+[^;{}]*>\s*::\s*$/.exec(
          before);
      const qualifier = /([A-Za-z_][A-Za-z0-9_]*)\s*::\s*$/.exec(before);
      if (/^\s*::(?!\s*<)/.test(after)) continue;
      const called = /^\s*(?:::\s*<[^;{}()]*>)?\s*\(/.test(after);
      const valueContext = /(?:=|,|\()\s*&?\s*$/.test(before) &&
        /^\s*(?:[,;)\]}]|$)/.test(after);
      if (!called && !valueContext) continue;

      if (ufcs) {
        const typePath = ufcs[1].split('::').filter(function (part) {
          return part !== 'crate' && part !== 'self' && part !== 'super';
        });
        const owner = typePath.pop();
        const module = typePath.pop();
        if (target.owner === owner &&
            (module ? target.module === module :
             target.file === definition.file)) return true;
        continue;
      }

      if (qualifier) {
        const prefix = qualifier[1];
        if (modules.has(prefix)) {
          if (target.module === prefix && target.owner === null) return true;
          continue;
        }
        if (prefix === 'crate') continue;
        if (prefix === 'self' || prefix === 'super') {
          if (target.file === definition.file && target.owner === null) {
            return true;
          }
          continue;
        }
        if (prefix === 'Self') {
          if (target.file === definition.file &&
              target.owner === definition.owner) return true;
          continue;
        }
        if (target.owner === prefix) {
          const typePath = new RegExp(
            '(?:\\bcrate\\s*::\\s*)?([A-Za-z_][A-Za-z0-9_]*)' +
            '\\s*::\\s*' + prefix + '\\s*::\\s*$').exec(before);
          if (typePath ? target.module === typePath[1] :
              target.file === definition.file) return true;
        }
        continue;
      }

      const receiver = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(before);
      if (receiver) {
        if (receiver[1] === 'self') {
          if (target.file === definition.file &&
              target.owner === definition.owner) return true;
        } else if (target.owner !== null) {
          return true;
        }
        continue;
      }
      if (target.file === definition.file && target.owner === null) return true;
    }
    return false;
  }

  for (const definition of definitions) {
    if (isMetered(definition)) continue;
    const edges = new Set();
    const body = maskRustNonCode(definition.body);
    for (const targetDefinition of definitions) {
      if (isMetered(targetDefinition)) continue;
      const name = targetDefinition.name;
      const direct = hasFunctionReference(
        definition, targetDefinition, body);
      const qualified = new RegExp(
        '\\b(?:crate\\s*::\\s*)?' + targetDefinition.module +
        '\\s*::\\s*' + name + '\\b\\s*' +
        '(?:::\\s*<[^;{}()]*>)?\\s*\\(').test(body) &&
        targetDefinition.owner === null;
      if (direct || qualified) edges.add(targetDefinition.id);
    }
    graph.set(definition.id, edges);
  }

  let nextIndex = 0;
  const indices = new Map();
  const lowlinks = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];

  function visit(id) {
    indices.set(id, nextIndex);
    lowlinks.set(id, nextIndex);
    nextIndex++;
    stack.push(id);
    onStack.add(id);

    for (const target of graph.get(id) || []) {
      if (!graph.has(target)) continue;
      if (!indices.has(target)) {
        visit(target);
        lowlinks.set(id, Math.min(lowlinks.get(id), lowlinks.get(target)));
      } else if (onStack.has(target)) {
        lowlinks.set(id, Math.min(lowlinks.get(id), indices.get(target)));
      }
    }

    if (lowlinks.get(id) !== indices.get(id)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    const selfRecursive = component.length === 1 &&
      (graph.get(component[0]) || new Set()).has(component[0]);
    if (component.length > 1 || selfRecursive) {
      cycles.push(component.map(function (item) {
        const definition = byId.get(item);
        return definition.file + '::' +
          (definition.owner ? definition.owner + '::' : '') +
          definition.name;
      }).sort().join(' <-> '));
    }
  }

  for (const id of Array.from(graph.keys()).sort()) {
    if (!indices.has(id)) visit(id);
  }
  return cycles.sort();
}

function bracedItemHeaders(source, expression) {
  return extractAllBracedItems(source, expression).map(function (item) {
    return item.slice(0, item.indexOf('{')).replace(/\s+/g, ' ').trim();
  }).sort();
}

function itemAttributePrefix(source, label, expression) {
  const item = extractBracedItem(source, label, expression);
  const keyword = item.search(/\b(?:pub\s+)?(?:struct|enum|union|impl)\b/);
  if (keyword === -1) fail('Rust ' + label + ' has no item keyword');
  return item.slice(0, keyword).trim();
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

function importLines(source) {
  source = withoutCfgTestModules(source);
  const maskedLines = maskRustNonCode(source).split(/\r?\n/);
  const sourceLines = source.replace(/\r\n/g, '\n').split('\n');
  return maskedLines.reduce(function (lines, masked, index) {
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?use\b/.test(masked)) {
      lines.push(sourceLines[index].trim());
    }
    return lines;
  }, []);
}

function contextTypeLines(source) {
  source = withoutCfgTestModules(source);
  const maskedLines = maskRustNonCode(source).split(/\r?\n/);
  const sourceLines = source.replace(/\r\n/g, '\n').split('\n');
  return maskedLines.reduce(function (lines, masked, index) {
    if (/\bContext\b/.test(masked)) {
      lines.push(sourceLines[index].trim());
    }
    return lines;
  }, []);
}

function forbiddenMutationLines(source) {
  source = withoutCfgTestModules(source);
  const maskedLines = maskRustNonCode(source).split(/\r?\n/);
  const sourceLines = source.replace(/\r\n/g, '\n').split('\n');
  return maskedLines.reduce(function (lines, masked, index) {
    if (/\bclone_from\b|\bclone_into\b|\btransmute\b/.test(masked) ||
        /\bmem\s*::\s*(?:replace|swap|take)\b/.test(masked) ||
        /\bas\s*\*\s*(?:mut|const)\b/.test(masked)) {
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
  // Field-level classification cannot see a whole-Context replacement
  // (e.g. a derived Clone plus clone_from restoring a snapshotted counter
  // state). Candidates may add their own experiment fields to Context, so
  // the struct body stays open; instead the struct's outer attributes, the
  // set of impl headers targeting the type, all production type-name uses,
  // the replacement vocabulary, and the import surface are frozen.
  compare('Context struct attributes',
    itemAttributePrefix(
      withoutCfgTestModules(trusted.search), 'Context struct',
      /\bstruct\s+Context\s*\{/g),
    itemAttributePrefix(
      withoutCfgTestModules(candidate.search), 'Context struct',
      /\bstruct\s+Context\s*\{/g));
  compare('Context impl headers',
    JSON.stringify(bracedItemHeaders(
      withoutCfgTestModules(trusted.search),
      /\bimpl\b[^{;]*\bContext\b[^{;]*\{/g)),
    JSON.stringify(bracedItemHeaders(
      withoutCfgTestModules(candidate.search),
      /\bimpl\b[^{;]*\bContext\b[^{;]*\{/g)));
  compare('Context type surface',
    JSON.stringify(projectFiles(trustedFiles, contextTypeLines)),
    JSON.stringify(projectFiles(candidateFiles, contextTypeLines)));
  compare('whole-context mutation vocabulary',
    JSON.stringify(projectFiles(trustedFiles, forbiddenMutationLines)),
    JSON.stringify(projectFiles(candidateFiles, forbiddenMutationLines)));
  compare('production use imports',
    JSON.stringify(projectFiles(trustedFiles, importLines)),
    JSON.stringify(projectFiles(candidateFiles, importLines)));
  compare('unmetered recursive call cycles',
    JSON.stringify(unmeteredRecursionCycles(trustedFiles)),
    JSON.stringify(unmeteredRecursionCycles(candidateFiles)));
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
  extractAllBracedItems: extractAllBracedItems,
  bracedItemHeaders: bracedItemHeaders,
  itemAttributePrefix: itemAttributePrefix,
  importLines: importLines,
  contextTypeLines: contextTypeLines,
  forbiddenMutationLines: forbiddenMutationLines,
  accountingLines: accountingLines,
  escapeLines: escapeLines,
  criticalUseProjection: criticalUseProjection,
  moduleLines: moduleLines,
  withoutCfgTestModules: withoutCfgTestModules,
  validateSources: validateSources,
  readSources: readSources
});
