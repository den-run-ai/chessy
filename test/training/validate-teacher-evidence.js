#!/usr/bin/env node
'use strict';
const fs = require('fs');
const Evidence = require('./teacher-evidence');
try {
  if (process.argv.length !== 2) throw new Error('this bridge accepts stdin only');
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (request.schema !== Evidence.SCHEMA) throw new Error('invalid teacher evidence request');
  if (!request.selectionContext) throw new Error('teacher selection context is required');
  process.stdout.write(JSON.stringify(Evidence.validateEvidence(request)) + '\n');
} catch (error) {
  process.stderr.write('canonical teacher evidence admission: ' + error.message + '\n');
  process.exitCode = 1;
}
