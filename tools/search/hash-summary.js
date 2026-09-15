#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const {sha}=require('./hash-cost');
const Bench=require('../../experiments/wasm/bench');
const check=(v,m)=>{if(!v)throw Error(m);};
const median=xs=>{const a=[...xs].sort((x,y)=>x-y),n=a.length;check(n>0,'empty median');return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;};
const fields=['abiVersion','move','score','depth','attemptedDepth','nodes','qnodes','cutoffs','researches','stopReason'];
function summarize(bytes){
  const r=JSON.parse(bytes),p=r.registration;
  check(r.complete===true&&['chessy.searched-board-hash.benchmark-results.v1','chessy.searched-board-hash.benchmark-results.v2'].includes(r.schema),'incomplete benchmark');
  check(['fixed','master'].includes(p.mode)&&p.modules.length===2,'invalid mode/module inventory');
  check(r.registrationSha256===sha(Buffer.from(JSON.stringify(p,null,2)+'\n')),'embedded registration mismatch');
  check(JSON.stringify(p.positions.map(x=>[x.name,x.fen]))===JSON.stringify(Bench.POSITIONS),'position inventory differs');
  check(p.positions.every((x,i)=>x.phase===(i<2?'opening':i>=8&&i<16?'endgame':'middlegame')),'phase inventory differs');
  check(JSON.stringify(p.options)===JSON.stringify(p.mode==='fixed'?{maxDepth:111,nodeLimits:[10000,36000,230000],timeMs:0,quiesce:true,repetitions:4}:{maxDepth:30,nodeLimits:[0],timeMs:5000,quiesce:true,repetitions:2}),'budget differs');
  check(r.rows.length===p.positions.length*p.options.repetitions*p.options.nodeLimits.length*2,'missing or extra rows');
  const buckets=[];
  for(const limit of p.options.nodeLimits){
    const pairs=[];
    for(let i=0;i<p.positions.length;i++)for(let repetition=0;repetition<p.options.repetitions;repetition++){
      const rows=r.rows.filter(x=>x.position===i&&x.repetition===repetition&&x.nodeLimit===limit);
      check(rows.length===2&&rows.some(x=>x.engine===0)&&rows.some(x=>x.engine===1),'invalid pair');
      const base=rows.find(x=>x.engine===0),candidate=rows.find(x=>x.engine===1);
      check([base,candidate].every(x=>Number.isFinite(x.ms)&&x.ms>0&&x.nodes>0),'invalid observation');
      if(p.mode==='fixed'){
        const signature=fields.map(f=>base[f]);
        for(const row of r.rows.filter(x=>x.position===i&&x.nodeLimit===limit))
          check(fields.every(f=>Object.hasOwn(row,f))&&JSON.stringify(fields.map(f=>row[f]))===JSON.stringify(signature),'fixed signature divergence');
      }
      pairs.push({position:i,repetition,phase:p.positions[i].phase,
        npsRatio:(candidate.nodes/candidate.ms)/(base.nodes/base.ms),nodeRatio:candidate.nodes/base.nodes,
        sameMove:candidate.move===base.move,baseDepth:base.depth,candidateDepth:candidate.depth});
    }
    buckets.push({nodeLimit:limit,pairs:pairs.length,medianNpsRatio:median(pairs.map(x=>x.npsRatio)),
      medianNodeRatio:median(pairs.map(x=>x.nodeRatio)),sameMovePairs:pairs.filter(x=>x.sameMove).length,
      phaseMedianNpsRatio:Object.fromEntries(['opening','middlegame','endgame'].map(phase=>[phase,median(pairs.filter(x=>x.phase===phase).map(x=>x.npsRatio))])),observations:pairs});
  }
  const qualifying=buckets.find(x=>x.nodeLimit===230000);
  return {schema:'chessy.searched-board-hash.descriptive-summary.v1',resultSha256:sha(bytes),
    registrationSha256:r.registrationSha256,mode:p.mode,paidComputeUsd:0,strengthClaimAllowed:false,
    conditionalMasterEligible:p.mode==='fixed'&&r.exactFixedNodeParity===true&&qualifying.medianNpsRatio>1.03&&Object.values(qualifying.phaseMedianNpsRatio).every(x=>x>=.98),
    modules:r.modules,buckets};
}
if(require.main===module){check(process.argv.length===4,'usage: hash-summary.js RESULTS SUMMARY');fs.writeFileSync(process.argv[3],JSON.stringify(summarize(fs.readFileSync(process.argv[2])),null,2)+'\n',{flag:'wx'});}
module.exports={summarize};
