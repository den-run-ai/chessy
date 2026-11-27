#!/usr/bin/env node
'use strict';
// Correctness-only reproduction of completed PR #183/#184 candidates. Never
// execute archived benchmark runners or assign new measurements to old runs.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const BASELINE='dbf67181ab5d4e1c690617c14fe160b061191adb';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const contracts={
  hash:{receipt:'eval/hash-cost-v1/source.json',receiptSha256:'90e20b7593956db90ad6eb20058da338e2f4103a2509787e2c4917c5740fad58',
    schema:'chessy.searched-board-hash.source.v2',dependencies:['hash-cost.js','hash-board.rs.in','hash-parity.rs.in']},
  checks:{receipt:'eval/qsearch-cost-v1/checks-source.json',receiptSha256:'3d174ec58f96e432f1ebad9f33297a340106c9df52d8d49c657630c882f67c65',
    schema:'chessy.qsearch-cost.source.v3',moduleSha256:'54c29d8592a1deefc49618fa99bc3dda496b08100ab16fa8d437241967d79dc0'},
  tactical:{receipt:'eval/qsearch-cost-v1/tactical-source.json',receiptSha256:'0d32c6a1e6913dc6149af1e536bdc150363e63a957c9ea1678e729e875dfad4b',
    schema:'chessy.qsearch-cost.source.v3',moduleSha256:'1a8b8bffe0bc07179829a24d5520828bfb8643da4a9e3ba40cb17b862de0b3c5'}
};
function validate(kind,directory){
  assert(Object.hasOwn(contracts,kind),'unknown historical candidate');
  const contract=contracts[kind],archiveBytes=fs.readFileSync(path.join(ROOT,contract.receipt));
  assert.equal(sha(archiveBytes),contract.receiptSha256,'archived source receipt changed');
  const archive=JSON.parse(archiveBytes),receipt=JSON.parse(fs.readFileSync(path.join(directory,'source.json')));
  assert.equal(receipt.schema,contract.schema);assert.equal(receipt.baselineCommit,BASELINE);
  if(kind!=='hash')assert.equal(receipt.variant,kind);
  assert.equal(receipt.researchOnly,true);assert.equal(receipt.productionIntegrationAllowed,false);assert.equal(receipt.strengthClaimAllowed,false);
  assert.deepEqual(receipt.source,archive.source,'historical source inventory changed');
  assert.deepEqual(receipt.generated,archive.generated,'historical generated inventory changed');
  const dependencies=contract.dependencies||['qsearch-cost.js','qsearch-checks.rs.in','qsearch-engine-tests.rs.in','qsearch-parity-tests.rs.in','qsearch-tactical.rs.in'];
  assert.deepEqual(receipt.dependencies.map(f=>f.path),dependencies,'fresh generator dependency inventory changed');
  for(const file of receipt.dependencies)assert.equal(file.sha256,sha(fs.readFileSync(path.join(__dirname,file.path))),'fresh generator dependency changed: '+file.path);
  for(const file of archive.generated)assert.equal(sha(fs.readFileSync(path.join(directory,file.path))),file.sha256,'generated build input changed: '+file.path);
  let outputs;
  if(kind==='hash'){
    const bytes=fs.readFileSync(path.join(ROOT,'eval/hash-cost-v1/execution-snapshot.json'));
    assert.equal(sha(bytes),'a0934dfc76d3fac2a39bbe792c631be657339014452166a7662971ae9b383ae9','complete archived snapshot changed');
    outputs=JSON.parse(bytes).files.filter(f=>f.path.startsWith('candidate/dist/')).map(f=>({path:f.path.slice('candidate/'.length),sha256:f.sha256}));
    assert.equal(outputs.length,4);
  }else outputs=[{path:'dist/chessy-ai-fast.wasm',sha256:contract.moduleSha256}];
  const modules=outputs.map(file=>{
    const bytes=fs.readFileSync(path.join(directory,file.path));
    assert.equal(sha(bytes),file.sha256,'historical WASM output changed: '+file.path);
    return {...file,bytes:bytes.length};
  });
  return {schema:'chessy.historical-build-reproduction.v1',kind,baselineCommit:BASELINE,
    archivedReceiptSha256:contract.receiptSha256,freshGeneratorDependencies:receipt.dependencies,
    exactHistoricalGeneratedInputs:true,exactHistoricalModules:true,modules,timingReruns:0};
}
function currentSizeComparison(directory){
  assert.equal(process.versions.node,'22.23.2','current policy size comparison requires pinned Node 22.23.2');
  assert.equal(process.versions.brotli,'1.1.0','current policy size comparison requires pinned Brotli 1.1.0');
  const bytes=fs.readFileSync(path.join(directory,'dist/chessy-ai-fast.wasm')),zlib=require('node:zlib');
  assert.equal(sha(bytes),'509a1d8e1c3fe1c05c31e57923c8127d35094bd68a704fc241cc4e8444b8fa9e');
  const compressed=zlib.brotliCompressSync(bytes,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}});
  const limits={rawBytes:40960,brotliBytes:20480},observed={rawBytes:bytes.length,brotliBytes:compressed.length};
  assert(observed.rawBytes<=limits.rawBytes&&observed.brotliBytes<=limits.brotliBytes,'historical candidate exceeds current download policy');
  return {policy:'40 KiB raw / 20 KiB Brotli-11',encoder:{node:process.versions.node,brotli:process.versions.brotli},
    limits,observed,passes:true,historicalSizeVerdictUnchanged:true,productionAdmission:false};
}
if(require.main===module){
  const [kind,directory,flag]=process.argv.slice(2);
  assert(directory&&(!flag||flag==='--current-sizes'),'usage: check-historical-build.js hash|checks|tactical CRATE [--current-sizes]');
  const report=validate(kind,directory);
  if(flag){assert.equal(kind,'hash');report.currentPolicyComparison=currentSizeComparison(directory);}
  console.log(JSON.stringify(report,null,2));
}
module.exports={validate,currentSizeComparison};
