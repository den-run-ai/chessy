'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto');
const path=require('node:path'),{spawnSync}=require('node:child_process');
const {signature,validateRows}=require('../../tools/training/hybrid-eval-counts');
const result={move:{from:0,to:1,promotion:null},score:4,scorePov:'white',depth:2,attemptedDepth:3,nodes:16384,qnodes:9000,cutoffs:100,researches:2,stopReason:'node-limit'};
const selected=Array.from({length:24},(_,i)=>({taskId:'task-'+i,ply:i,archivedModuleSha256:'shipped',archivedResult:{...result,score:-99}}));
const rows=[];
for(let i=0;i<24;i++)for(let offset=0;offset<2;offset++){
  const observer=(i+offset)%2===1,counts=Array(25).fill(0);counts[i===23?24:i]=5;
  rows.push({index:i,taskId:'task-'+i,ply:i,arm:observer?'observer':'original',result:{...result},counts:observer?counts:null});
}
const aggregate=validateRows(rows,selected);
assert.equal(aggregate.phaseCounts.reduce((a,b)=>a+b,0),120);
assert.equal(aggregate.expandedOnly,35);assert.equal(aggregate.blend,25);assert.equal(aggregate.neuralOnly,60);assert.equal(aggregate.phaseCounts[24],5);
assert.deepEqual(signature(result),signature({...result,move:{promotion:null,to:1,from:0},moveUci:'a8b8'}));
function broken(change,pattern){const r=structuredClone(rows),s=structuredClone(selected);change(r,s);assert.throws(()=>validateRows(r,s),pattern);}
broken(r=>r.pop(),/48-row/);
broken(r=>r[0].arm='observer',/identity\/order/);
broken(r=>r[1].result.score++,/mismatch/);
broken(r=>r[1].counts[0]=-1,/counter range/);
broken(r=>r[1].counts[0]=16385,/more evaluations/);
broken(r=>{r[0].result={nodes:16384};r[1].result={nodes:16384};},/result fields/);
broken(r=>{r[1].countsError='injected read trap';},/result fields/);
broken((r,s)=>{s[0].archivedModuleSha256='18c69302d9aaecc0078a5b398e68789f24adb66e525c99f8bc9ac9ddc60e9493';},/archived hybrid/);
// The completed scope has no executable generator, registration, loader, or
// launch entrypoint. Fail before touching even malformed input paths or IPC.
const auditor=require('../../tools/training/hybrid-eval-counts');
const disabled=['prepare','register','run','child','preflight','load'];
const poisoned=new Proxy({}, {get(){throw Error('must not inspect inputs');}});
for(const name of disabled)assert.throws(()=>auditor[name](poisoned,poisoned,poisoned),/completed and retired/);
assert.deepEqual(Object.keys(auditor).sort(),[...disabled,'select','signature','validateRows'].sort());
assert(Object.isFrozen(auditor));

const script=path.resolve(__dirname,'../../tools/training/hybrid-eval-counts.js');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-counts-retired-'));
try {
  const copied=path.join(temporary,'copied-runner.js');
  fs.copyFileSync(script,copied);
  const alias=path.join(temporary,'alias.js');fs.symlinkSync(copied,alias);
  const study=path.join(temporary,'copied-study');fs.mkdirSync(study);
  // Fabricated registration and an absent local ledger cannot reopen v1.
  fs.writeFileSync(path.join(study,'registration.json'),'{}\n');
  for(const entry of [script,copied,alias])for(const command of ['prepare','register','run','child']) {
    const args=command==='prepare'?[path.join(temporary,'fresh'),study,study]:[study];
    const output=spawnSync(process.execPath,[entry,command,...args],{encoding:'utf8',timeout:2000,env:{...process.env,CHESSY_PROFILE_PARENT_TOKEN:'fake-parent-token'}});
    assert.equal(output.status,2,output.stderr);assert.match(output.stderr,/completed and retired/);
  }
  assert.deepEqual(fs.readdirSync(study),['registration.json']);
  assert.equal(fs.existsSync(path.join(temporary,'fresh')),false);

  // Replace and restore the loaded entry pathname around a would-be run. The
  // retired API must never reopen it or fork a child, regardless of directory.
  // Reintroducing the historical run path fails the required retired error.
  const cached=require(copied),original=fs.readFileSync(copied);
  const marker=path.join(temporary,'unverified-child-ran');
  fs.renameSync(copied,copied+'.retained');
  fs.writeFileSync(copied,'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"unverified");\n');
  for(const name of disabled)assert.throws(()=>cached[name](study,study,study),/completed and retired/);
  assert.equal(fs.existsSync(marker),false);
  fs.unlinkSync(copied);fs.renameSync(copied+'.retained',copied);
  assert.deepEqual(fs.readFileSync(copied),original);
  assert.throws(()=>cached.child(study),/completed and retired/);
} finally {fs.rmSync(temporary,{recursive:true,force:true});}

// The archived source is inert JSON data, including when Node accepts the
// JSON entrypoint. Its decoded bytes are never compiled, required or evaluated.
const historical=path.resolve(__dirname,'../../tools/training/hybrid-eval-counts-historical-v1.source.json');
const historicalBytes=fs.readFileSync(historical),archive=JSON.parse(historicalBytes);
const decoded=Buffer.from(archive.sourceBase64,'base64');
const digest=crypto.createHash('sha256').update(decoded).digest('hex');
assert.equal(digest,'42aa8eddbca4d1597710de4f971339d4f0523ae7f6f1c213468b51072f157aff');
assert.equal(archive.sha256,digest);assert.equal(archive.bytes,decoded.length);
assert.deepEqual(require(historical),archive);
assert(Object.values(require(historical)).every(value=>typeof value!=='function'));
for(const key of disabled)assert.equal(Object.hasOwn(require(historical),key),false);
const inactive=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-counts-inert-'));
try {
  // Unknown source extensions used to execute the preserved runner. The new
  // JSON either loads as data or fails parsing; both outcomes must be inert.
  for(const suffix of ['.source.json','.js','.txt']) {
    const copied=path.join(inactive,'archive'+suffix);fs.writeFileSync(copied,historicalBytes);
    const destination=path.join(inactive,'unwanted-study');
    const output=spawnSync(process.execPath,[copied,'prepare',destination,'missing','missing'],{encoding:'utf8',timeout:2000,cwd:inactive});
    assert([0,1].includes(output.status),output.stderr);assert.equal(output.stdout,'');
    if(output.status===1)assert.match(output.stderr,/SyntaxError/);
    assert.equal(fs.existsSync(destination),false);
  }
} finally {fs.rmSync(inactive,{recursive:true,force:true});}
assert.equal(fs.existsSync(path.resolve(__dirname,'../../tools/training/hybrid-eval-counts-historical-v1.js.txt')),false);

// Read each committed evidence file once; validate the exact same retained
// bytes and public arithmetic that CI will protect, before mutation fixtures.
const {validatePublishedEvidence}=require('../../tools/training/hybrid-eval-counts-evidence');
const evidenceDirectory=path.resolve(__dirname,'../../eval/hybrid-eval-counts-v1');
const evidenceNames=['results.json','selection-receipt.json','independent-audit.json','registration.json','evidence-preservation.json'];
const evidence=Object.fromEntries(evidenceNames.map(name=>[name,fs.readFileSync(path.join(evidenceDirectory,name))]));
const verified=validatePublishedEvidence(evidence,historicalBytes);
assert.equal(verified.totalEvaluationDispatches,224201);assert.equal(verified.totalNodes,786432);
assert.equal(verified.archivedHybridComparisons,17);assert.equal(verified.phaseCounts.length,25);
function mutated(name,change,pattern){
  const copy={...evidence},value=JSON.parse(copy[name]);change(value);
  copy[name]=Buffer.from(JSON.stringify(value,null,2)+'\n');
  assert.throws(()=>validatePublishedEvidence(copy,historicalBytes),pattern);
}
mutated('results.json',r=>r.perRoot.pop(),/24-root inventory/);
mutated('results.json',r=>r.perRoot[0].ply++,/selected identity/);
mutated('results.json',r=>r.perRoot[0].nodes--,/node counters/);
mutated('results.json',r=>r.perRoot[0].qnodes=17000,/node counters/);
mutated('results.json',r=>r.perRoot[0].phaseCounts[0]=-1,/phase bins/);
mutated('results.json',r=>r.perRoot[0].phaseCounts[24]++,/recomputed phase totals/);
mutated('results.json',r=>r.phaseCounts[24]++,/recomputed phase totals/);
mutated('results.json',r=>r.dispatchBranches[0].calls++,/branch counts/);
mutated('results.json',r=>r.dispatchBranches[2].fraction=0.5,/branch counts/);
mutated('results.json',r=>r.actualNodes--,/actual nodes/);
mutated('results.json',r=>r.exactArchivedHybridComparisons=24,/parity audit coverage/);
mutated('results.json',r=>r.complete=false,/complete independent audit/);
mutated('results.json',r=>r.wallTimeSharesAllowed=true,/research-only claims/);
mutated('results.json',r=>r.rawResultsSha256='0'.repeat(64),/raw result identity/);
mutated('results.json',r=>r.unreviewed='extra field',/frozen evidence bytes/);
mutated('selection-receipt.json',s=>s.selected[1]=s.selected[0],/unique selected identity/);
mutated('selection-receipt.json',s=>s.selected[0].selectionDigest='0'.repeat(64),/selection digest/);
mutated('selection-receipt.json',s=>s.selected.reverse(),/selected identity|digest\/order/);
mutated('selection-receipt.json',s=>s.selected[0].member='wrong.jsonl',/member identity/);
mutated('selection-receipt.json',s=>s.selected[0].archivedModuleId='candidate',/module role/);
mutated('selection-receipt.json',s=>s.selected[0].rowSha256='0'.repeat(64),/frozen evidence bytes/);
mutated('selection-receipt.json',s=>s.options.nodeLimit=8192,/request contract/);
mutated('selection-receipt.json',s=>s.executionSnapshot.files.pop(),/execution inventory/);
mutated('independent-audit.json',a=>a.pass=false,/complete independent audit/);
mutated('independent-audit.json',a=>a.totalEvaluations++,/audit cross-file hash/);
mutated('registration.json',r=>r.observerSha256='0'.repeat(64),/registration cross-file hash/);
mutated('evidence-preservation.json',e=>e.zipEntries--,/private archive identity/);
const coordinated={...evidence},changedAudit=JSON.parse(coordinated['independent-audit.json']),changedResults=JSON.parse(coordinated['results.json']);
changedAudit.totalEvaluations++;coordinated['independent-audit.json']=Buffer.from(JSON.stringify(changedAudit,null,2)+'\n');
changedResults.independentAuditSha256=crypto.createHash('sha256').update(coordinated['independent-audit.json']).digest('hex');
coordinated['results.json']=Buffer.from(JSON.stringify(changedResults,null,2)+'\n');
assert.throws(()=>validatePublishedEvidence(coordinated,historicalBytes),/audit cross-file hash/);
const changedArchive={...archive,sourceBase64:archive.sourceBase64.slice(4)};
assert.throws(()=>validatePublishedEvidence(evidence,Buffer.from(JSON.stringify(changedArchive))),/historical source identity/);
const omitted={...evidence};delete omitted['results.json'];
assert.throws(()=>validatePublishedEvidence(omitted,historicalBytes),/complete public evidence inventory/);
console.log('Counts inventory/parity, retired entrypoints, inert source and committed evidence mutations PASS');
