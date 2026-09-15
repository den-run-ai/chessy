#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const oracle = require('../../test/training/h4-v3-reference.js');
function weight(phase, c) {
  if (!Number.isSafeInteger(phase) || phase < 0 || phase > 24) throw new Error('invalid phase');
  if (c.kind === 'hard') {
    if (!Number.isSafeInteger(c.threshold) || c.threshold < 0 || c.threshold >= 24) throw new Error('invalid threshold');
    return [phase > c.threshold ? 1 : 0, 1];
  }
  if (c.kind === 'smooth') {
    if (![c.lo,c.hi].every(Number.isSafeInteger) || c.lo < 0 || c.lo >= c.hi || c.hi > 24) throw new Error('invalid endpoints');
    return [Math.max(0, Math.min(c.hi-c.lo, phase-c.lo)), c.hi-c.lo];
  }
  throw new Error('unknown gate');
}
function blend(neural, fallback, phase, c) {
  if (![neural,fallback].every(x => Number.isSafeInteger(x) && Math.abs(x) <= 10000)) throw new Error('invalid cp');
  const [wn,dn] = weight(phase,c), w=BigInt(wn), d=BigInt(dn);
  return Number(oracle.floorDivide(2n*(w*BigInt(neural)+(d-w)*BigInt(fallback))+d,2n*d));
}
module.exports={weight,blend};
if (require.main === module) {
  const model=oracle.loadModel(fs.readFileSync(process.argv[2]),JSON.parse(fs.readFileSync(process.argv[3],'utf8')));
  const configs=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));
  readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
    if (!line.trim()) return;
    const r=JSON.parse(line), p=oracle.parseFen(r.fen).phaseUnits;
    const n=oracle.infer(model,r.fen,r.shippedCp);
    if (typeof r.id !== 'string') throw new Error('invalid identity');
    process.stdout.write(JSON.stringify({id:r.id,phase:p,neuralCp:n,hybrids:configs.map(c=>blend(n,r.expandedCp,p,c))})+'\n');
  });
}
