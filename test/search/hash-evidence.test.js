'use strict';
// Arithmetic and identity checks on the published, completed observations only.
// This module never loads a WASM engine or replays an experiment.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {summarize}=require('../../tools/search/hash-summary');
const root=path.resolve(__dirname,'../../eval/hash-cost-v1');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const encode=x=>Buffer.from(JSON.stringify(x,null,2)+'\n');
const names=['source','execution-snapshot','wasm-parity','provenance-hardening',
  ...['fixed','master'].flatMap(mode=>['registration','results','summary','independent-audit'].map(s=>mode+'-'+s))];
const bytes=Object.fromEntries(names.map(n=>[n,fs.readFileSync(path.join(root,n+'.json'))]));
const frozen={fixed:{registration:'7501340b2a0d8e82e43999ab572aefbdf418d5d7cc6c69f3b789899150aaa39a',
  results:'18673ea21fd3abaa5422c02215c2aee2b5d9c6655522dba1b3c5e37c1915a265'},
  master:{registration:'f0089baace9e9012a247f5210019187c78cae740649098d95949578811c11332',
    results:'1ea8608264401a20e6a4e1316345d0bda0795933fa7bb4575fadf562928e8afa'}};
const near=(a,b)=>assert(Math.abs(a-b)<=1e-12,`arithmetic differs: ${a} versus ${b}`);
function validate(retained){
  const data=Object.fromEntries(Object.entries(retained).map(([n,b])=>[n,JSON.parse(b)]));
  const source=data.source,snapshot=data['execution-snapshot'],parity=data['wasm-parity'],provenance=data['provenance-hardening'];
  assert.equal(snapshot.files.length,21);assert.equal(new Set(snapshot.files.map(f=>f.path)).size,21);
  const files=new Map(snapshot.files.map(f=>[f.path,f.sha256]));
  assert.equal(source.source.length,8);assert.equal(source.generated.length,8);
  assert.deepEqual(source.source.map(f=>f.path),source.generated.map(f=>f.path));
  assert.deepEqual(source.source.filter((f,i)=>f.sha256!==source.generated[i].sha256).map(f=>f.path),['src/search.rs']);
  for(const f of source.generated)assert.equal(files.get('candidate/'+f.path),f.sha256);
  for(const f of source.dependencies)assert.equal(files.get('tools/search/'+f.path),f.sha256);
  assert.equal(files.get('candidate/source.json'),sha(retained.source));
  assert.equal(source.researchOnly,true);assert.equal(source.productionIntegrationAllowed,false);assert.equal(source.strengthClaimAllowed,false);
  assert.equal(parity.baseSha256,files.get('assets/chessy-ai-fast.wasm'));
  assert.equal(parity.candidateSha256,files.get('candidate/dist/chessy-ai-fast.wasm'));
  assert.equal(parity.cases,144);assert.equal(parity.completeFixedSignaturesAndRootPvEqual,true);
  assert.equal(provenance.completedTimingReruns,0);assert.equal(provenance.historicalResultsUnchanged,true);
  assert.equal(provenance.measuredRunnerSha256,files.get('tools/search/hash-bench.js'));
  const summaries={};
  for(const mode of ['fixed','master']){
    const p=data[mode+'-registration'],r=data[mode+'-results'],s=data[mode+'-summary'],audit=data[mode+'-independent-audit'];
    assert.equal(sha(retained[mode+'-registration']),frozen[mode].registration,'frozen registration bytes changed');
    assert.equal(sha(retained[mode+'-results']),frozen[mode].results,'frozen observation bytes changed');
    assert.deepEqual(r.registration,p);assert.equal(r.registrationSha256,sha(retained[mode+'-registration']));
    assert.equal(p.mode,mode);assert.equal(p.positions.length,18);
    assert.equal(p.researchOnly,true);assert.equal(p.productionIntegrationAllowed,false);assert.equal(p.strengthClaimAllowed,false);
    assert.equal(p.selectionAllowed,mode==='fixed');assert.equal(r.complete,true);assert.equal(r.exactFixedNodeParity,mode==='fixed');
    assert.deepEqual(r.runtime,p.runtime);assert.equal(p.sourceReceipt.sha256,sha(retained.source));
    assert.deepEqual(p.modules.map(m=>m.sha256),[parity.baseSha256,parity.candidateSha256]);
    assert.equal(p.dependencies.length,4);
    for(const dep of p.dependencies)assert.equal(dep.sha256,files.get(dep.path));
    assert.deepEqual(r.modules,[{bytes:parity.baseBytes,brotliBytes:17690,memoryBytes:26542080},
      {bytes:parity.candidateBytes,brotliBytes:18114,memoryBytes:26542080}]);
    assert.equal(provenance[mode+'ResultSha256'],sha(retained[mode+'-results']));
    const recomputed=summarize(retained[mode+'-results']);assert.deepEqual(s,recomputed,'published summary differs from actual observations');
    summaries[mode]=recomputed;assert.equal(audit.resultSha256,s.resultSha256);assert.equal(audit.observations,r.rows.length);
    assert.equal(audit.independentPythonArithmeticMatches,true);
    // Authenticate actual capture order as well as the summary's complete pair inventory.
    let index=0;
    for(const limit of p.options.nodeLimits)for(let position=0;position<18;position++)for(let rep=0;rep<p.options.repetitions;rep++)for(let offset=0;offset<2;offset++){
      const row=r.rows[index++],ei=(position+rep+offset)%2;
      assert.deepEqual([row.nodeLimit,row.position,row.repetition,row.engine],[limit,position,rep,ei]);
      assert.equal(row.name,p.positions[position].name);assert.equal(row.phase,p.positions[position].phase);
      for(const field of ['nodes','qnodes','depth','attemptedDepth','cutoffs','researches','score'])assert(Number.isSafeInteger(row[field]));
      assert(row.nodes>0&&row.qnodes>=0&&row.qnodes<=row.nodes);assert(row.ms>0&&Number.isFinite(row.ms));
      assert.equal(row.abiVersion,2);assert.equal(row.experimentMetrics,null);
      assert.equal(row.stopReason,mode==='fixed'?'node-limit':'time-limit');
      if(mode==='fixed')assert.equal(row.nodes,limit);
    }
    assert.equal(index,r.rows.length);
    if(mode==='fixed'){
      assert.equal(audit.exactSignatures,true);assert.equal(audit.actualMeasuredNodes,r.rows.reduce((n,row)=>n+row.nodes,0));
      assert.equal(audit.groups.length,s.buckets.length);
      for(let i=0;i<audit.groups.length;i++){
        const a=audit.groups[i],b=s.buckets[i];assert.equal(a.nodeLimit,b.nodeLimit);near(a.medianNpsRatio,b.medianNpsRatio);
        for(const phase of ['opening','middlegame','endgame'])near(a.phaseMedianNpsRatio[phase],b.phaseMedianNpsRatio[phase]);
      }
      assert.equal(audit.conditionalMasterEligible,s.conditionalMasterEligible);
    }else{
      const pairs=s.buckets[0].observations,depth={deeper:0,same:0,shallower:0},changes=[];
      for(const pair of pairs){
        depth[pair.candidateDepth>pair.baseDepth?'deeper':pair.candidateDepth<pair.baseDepth?'shallower':'same']++;
        if(!pair.sameMove){
          const rows=r.rows.filter(x=>x.position===pair.position&&x.repetition===pair.repetition),base=rows.find(x=>x.engine===0),candidate=rows.find(x=>x.engine===1);
          changes.push({position:pair.position,name:base.name,repetition:pair.repetition,baseMove:base.move,candidateMove:candidate.move,baseDepth:base.depth,candidateDepth:candidate.depth});
        }
      }
      assert.equal(audit.pairs,pairs.length);assert.deepEqual(audit.completedDepthPairs,depth);assert.deepEqual(audit.changedBestMoves,changes);
      for(const ei of [0,1]){
        const rows=r.rows.filter(x=>x.engine===ei),stops={};for(const row of rows)stops[row.stopReason]=(stops[row.stopReason]||0)+1;
        assert.deepEqual(audit.stopReasons[ei],stops);near(audit.maxWallTimeOvershootMsByEngine[ei],Math.max(...rows.map(x=>x.ms))-p.options.timeMs);
      }
      for(const phase of ['opening','middlegame','endgame'])near(audit.phaseMedianNpsRatio[phase],s.buckets[0].phaseMedianNpsRatio[phase]);
    }
  }
  assert.equal(snapshot.registrationSha256,frozen.fixed.registration);
  assert.deepEqual(data['fixed-registration'].positions,data['master-registration'].positions);
  assert.deepEqual(data['fixed-registration'].warmup,data['master-registration'].warmup);
  return summaries;
}
validate(bytes);
function mutate(name,change){const copy={...bytes},value=JSON.parse(copy[name]);change(value);copy[name]=encode(value);assert.throws(()=>validate(copy));}
mutate('fixed-results',x=>x.rows[0].score++);
mutate('fixed-registration',x=>x.options.nodeLimits[0]++);
mutate('fixed-summary',x=>x.buckets[2].medianNpsRatio+=0.01);
mutate('master-summary',x=>x.buckets[0].observations.pop());
mutate('fixed-independent-audit',x=>x.actualMeasuredNodes++);
mutate('master-independent-audit',x=>x.completedDepthPairs.same++);
mutate('master-independent-audit',x=>x.maxWallTimeOvershootMsByEngine[1]++);
mutate('source',x=>x.generated[0].sha256='0'.repeat(64));
mutate('execution-snapshot',x=>x.files.pop());
mutate('provenance-hardening',x=>x.fixedResultSha256='0'.repeat(64));
console.log('Hash committed 504 observations, summaries, audits and source/registration links PASS (no WASM/search)');
