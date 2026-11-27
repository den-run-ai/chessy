'use strict';
// Read-only consistency audit of the public, completed v1 evidence. This does
// not replay private requests, prove global selection, or rerun search parity.
const crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(condition,message)=>{if(!condition)throw Error(message);};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sum=a=>a.reduce((n,v)=>n+v,0);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const digest=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
// These exact public files were frozen before retirement. No rebaselining or
// coordinated replacement of a receipt and its mirrors can reopen the study.
const FROZEN=Object.freeze({
  'results.json':'37a2dc995ce40c5a49b531be289b26889f1e8ecb65dc634e56c4d98577811a6c',
  'selection-receipt.json':'1c078574b4837eba0988e9eff6fcc7d80107ef1200051ccb15fda31cb8dd5dd3',
  'independent-audit.json':'51cdc8953fc1f36e225734b150c5ab21562a38d63fcb7a60ec674892b747cfe8',
  'registration.json':'03cc5bbd869f9990763d6b353fa0369263375143cbf086cb3c2ce5140b2124e1',
  'evidence-preservation.json':'d94b86af1b50adca03e3d4930ad594129d0ae208191efb45ade9320eba871703'
});
const ORIGINAL='18c69302d9aaecc0078a5b398e68789f24adb66e525c99f8bc9ac9ddc60e9493';
const SHIPPED='57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f';
const SOURCE='98315672324d2643e468d925b7e153167b8b869ac570685fbf827444fb69a57a';
const SCRIPT='42aa8eddbca4d1597710de4f971339d4f0523ae7f6f1c213468b51072f157aff';
const RAW='b6785f24216c4a31c8f28752a0a5faf656259623e8eeee598680cf7c4c609b7a';
const ZIP='f7d665996b5e8cc21e863fc56d3016a023b6c58523bfe4fffe7b36e57c5d04fd';
const PATHS=['tools/training/hybrid-eval-counts.js','tools/training/hybrid-eval-counts.rs.in','assets/wasm-engine.js','eval/hybrid-eval-counts-v1/PLAN.md'];
function validatePublishedEvidence(buffers,historicalBytes){
  check(equal(Object.keys(buffers).sort(),Object.keys(FROZEN).sort()),'complete public evidence inventory');
  check(Object.values(buffers).every(Buffer.isBuffer)&&Buffer.isBuffer(historicalBytes),'retained evidence buffers required');
  const files=Object.fromEntries(Object.entries(buffers).map(([name,bytes])=>[name,JSON.parse(bytes)]));
  const r=files['results.json'],s=files['selection-receipt.json'],a=files['independent-audit.json'],g=files['registration.json'],e=files['evidence-preservation.json'];
  check(r.schema==='chessy.hybrid-eval-counts.public-results.v1'&&s.schema==='chessy.hybrid-eval-counts.selection-receipt.v1'&&a.schema==='chessy.hybrid-eval-counts.independent-audit.v1'&&g.schema==='chessy.hybrid-eval-counts.registration.v1'&&e.schema==='chessy.hybrid-eval-counts.evidence-preservation.v1','evidence schemas');
  check(r.researchOnly===true&&s.researchOnly===true&&r.strengthClaimAllowed===false&&r.productionIntegrationAllowed===false&&[r,s,a].every(x=>x.wallTimeSharesAllowed===false),'research-only claims');
  check(r.complete===true&&a.pass===true&&a.all25PhaseBinsMatch===true&&a.engineSearchesByAuditor===0,'complete independent audit');
  check(r.registrationSha256===sha(buffers['registration.json'])&&a.registrationSha256===r.registrationSha256&&r.registrationSha256===FROZEN['registration.json'],'registration cross-file hash');
  check(r.independentAuditSha256===sha(buffers['independent-audit.json'])&&r.independentAuditSha256===FROZEN['independent-audit.json'],'audit cross-file hash');
  check(r.rawResultsSha256===RAW&&a.resultSha256===RAW,'raw result identity');
  check(s.sourceReceiptSha256===SOURCE&&g.sourceSha256===SOURCE&&s.originalModuleSha256===ORIGINAL&&g.originalSha256===ORIGINAL,'source and original module identity');
  check(g.observerSha256==='80531e1269e80e4de6afaf67de1cbdc67c7826c368c53dab41061e119b791292','observer module identity');
  check(r.privateEvidenceArchiveSha256===ZIP&&e.sha256===ZIP&&e.bytes===2782975&&e.zipEntries===38&&e.libraryVersion===0,'private archive identity');
  check(s.sourceArchiveSha256==='05f6d2059ff492c364d6e28965b165c2b783df7199735b9809713e85e751b516'&&s.originalSourceSha256==='1095afc9bc9d6155cd8ffbffc8173a22ee88cf0df8f3c8329ebe6c0a3742b48d','source archive identity');
  check(s.selectionSalt==='chessy.hybrid-eval-counts.v1|2026-09-15'&&s.sourceMoves===24467&&s.watchdogMs===60000,'selection contract');
  check(equal(s.options,{maxDepth:30,nodeLimit:16384,timeMs:0,quiesce:true}),'request contract');
  check(s.selectedCount===24&&Array.isArray(s.selected)&&s.selected.length===24&&r.selectedRoots===24&&Array.isArray(r.perRoot)&&r.perRoot.length===24,'24-root inventory');
  check(s.totalSearches===48&&r.searches===48&&a.completeRows===48&&s.totalRequestedNodes===786432&&r.totalRequestedNodes===786432,'48-search budget');
  const seen=new Set(),totals=Array(25).fill(0);let previous='',hybrid=0,nodes=0;
  for(let i=0;i<24;i++){
    const selected=s.selected[i],root=r.perRoot[i],id=selected.taskId+'|'+selected.ply;
    check(/^hybrid-n16384-o(?:[0-9]|[1-9][0-9])-[wb]$/.test(selected.taskId)&&integer(selected.ply)&&!seen.has(id),'unique selected identity');seen.add(id);
    const rank=sha(s.selectionSalt+'|'+id);
    check(selected.selectionDigest===rank&&rank>previous,'salted selection digest/order');previous=rank;
    check(selected.member===selected.taskId+'.jsonl'&&digest(selected.memberSha256)&&digest(selected.rowSha256),'selected member identity');
    check((selected.archivedModuleId==='candidate'&&selected.archivedModuleSha256===ORIGINAL)||(selected.archivedModuleId==='baseline'&&selected.archivedModuleSha256===SHIPPED),'archived module role');
    if(selected.archivedModuleSha256===ORIGINAL)hybrid++;
    check(root.taskId===selected.taskId&&root.ply===selected.ply,'per-root selected identity/order');
    check(root.nodes===16384&&integer(root.qnodes)&&root.qnodes<=root.nodes,'per-root node counters');nodes+=2*root.nodes;
    check(Array.isArray(root.phaseCounts)&&root.phaseCounts.length===25&&root.phaseCounts.every(integer)&&sum(root.phaseCounts)<=root.nodes,'per-root phase bins');
    root.phaseCounts.forEach((value,phase)=>{totals[phase]+=value;});
  }
  check(hybrid===17&&r.exactArchivedHybridComparisons===hybrid&&a.archivedHybridExactSignatures===hybrid&&r.exactObserverPairs===24&&a.pairedExactSignatures===24,'preserved parity audit coverage');
  check(r.actualNodes===nodes&&nodes===r.totalRequestedNodes,'total actual nodes');
  check(equal(r.phaseCounts,totals)&&equal(a.aggregate.phaseCounts,totals),'recomputed phase totals');
  const total=sum(totals),calls=[sum(totals.slice(0,7)),sum(totals.slice(7,12)),sum(totals.slice(12))];
  check(total===r.totalEvaluationDispatches&&total===a.totalEvaluations&&total===224201,'total evaluation dispatches');
  check(equal([a.aggregate.expandedOnly,a.aggregate.blend,a.aggregate.neuralOnly],calls),'audit endpoint totals');
  const names=['expanded HCE endpoint','blend of expanded HCE and shipped HCE plus H8','shipped HCE plus H8 endpoint'],phases=[[0,6],[7,11],[12,24]];
  check(Array.isArray(r.dispatchBranches)&&r.dispatchBranches.length===3,'dispatch branch inventory');
  r.dispatchBranches.forEach((branch,i)=>check(branch.name===names[i]&&equal(branch.phases,phases[i])&&branch.calls===calls[i]&&branch.fraction===calls[i]/total,'dispatch branch counts/fractions'));
  check(Array.isArray(g.dependencies)&&equal(g.dependencies.map(f=>f.path),PATHS)&&g.dependencies.every(f=>digest(f.sha256)),'registered dependency inventory');
  check(s.executionSnapshot.readOnly===true&&s.executionSnapshot.files.length===5&&equal(s.executionSnapshot.files.slice(0,4),g.dependencies)&&s.executionSnapshot.files[4].path==='test/training/hybrid-eval-counts.test.js'&&s.executionSnapshot.files[4].sha256==='8de577b2ad71d7dbc4439690ad9eefd914c8ffefd0dad154186064d1a4b8485b','retained execution inventory');
  const h=JSON.parse(historicalBytes);
  check(equal(Object.keys(h).sort(),['schema','originalPath','encoding','bytes','sha256','sourceBase64'].sort())&&h.schema==='chessy.retired-source.v1'&&h.originalPath===PATHS[0]&&h.encoding==='base64'&&typeof h.sourceBase64==='string','inert historical source schema');
  const decoded=Buffer.from(h.sourceBase64,'base64');
  check(decoded.toString('base64')===h.sourceBase64&&decoded.length===h.bytes&&sha(decoded)===SCRIPT&&h.sha256===SCRIPT&&g.dependencies[0].sha256===SCRIPT,'decoded historical source identity');
  for(const [name,expected]of Object.entries(FROZEN))check(sha(buffers[name])===expected,'frozen evidence bytes: '+name);
  return {selectedRoots:24,searches:48,archivedHybridComparisons:hybrid,totalNodes:nodes,totalEvaluationDispatches:total,phaseCounts:totals};
}
module.exports=Object.freeze({validatePublishedEvidence});
