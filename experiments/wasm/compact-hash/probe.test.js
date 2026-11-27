'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {render,prepare,sha}=require('./prepare.js');
const {assertReceiptBindings,summary}=require('./measure.js');
const read=name=>fs.readFileSync(path.join(__dirname,'evidence',name));
const json=name=>JSON.parse(read(name));
const clone=x=>JSON.parse(JSON.stringify(x));
const source=read('source-final.json'),validation=read('validation.json'),registration=json('registration.json');
let checks=0;
function test(name,fn){fn();checks++;console.log('ok '+name);}
test('frozen measured receipt remains internally bound',()=>assertReceiptBindings(registration,source,validation));
for(const [name,mutate] of [
  ['changed candidate',p=>p.modules[1].sha256='0'.repeat(64)],
  ['changed byte count',p=>p.modules[1].rawBytes=37172],
  ['false raw-size pass',p=>p.rawGatePassed=true],
  ['changed baseline',p=>p.modules[0].sha256='0'.repeat(64)]
])test('rejects '+name,()=>{const changed=clone(registration);mutate(changed);assert.throws(()=>assertReceiptBindings(changed,source,validation));});
for(const [name,mutate] of [
  ['incomplete validation',v=>v.complete=false],
  ['unearned equivalence claim',v=>v.universalEquivalenceProven=true],
  ['missing finite cases',v=>v.signatureCases=143],
  ['unearned production authority',v=>v.productionIntegrationAllowed=true]
])test('rejects '+name,()=>{const changed=json('validation.json');mutate(changed);assert.throws(()=>assertReceiptBindings(registration,source,Buffer.from(JSON.stringify(changed))));});
test('archived measured implementation matches the exact registration',()=>{
  const expected=registration.dependencies.find(r=>r.path.endsWith('/measure.js')).sha256;
  assert.equal(sha(read('measured-runner.js.txt')),expected);
});
test('all retained negative variants reproduce their generated search identities',()=>{
  const original=fs.readFileSync(path.join(__dirname,'../src/search.rs'),'utf8');
  for(const [key,variant] of [['v1','threaded'],['v2','shared-update'],['v3','proven-indices'],['final','threaded']]){
    const receipt=json('source-'+key+'.json');
    assert.equal(sha(render(original,variant)),receipt.generated.find(r=>r.path==='src/search.rs').sha256,key);
  }
});
test('generator refuses an unknown variant or a changed canonical anchor',()=>{
  const original=fs.readFileSync(path.join(__dirname,'../src/search.rs'),'utf8');
  assert.throws(()=>render(original,'unknown'));
  assert.throws(()=>render(original.replace('unsafe fn hash_position(','unsafe fn renamed_hash_position(')));
});
test('generator refuses writes inside the repository',()=>assert.throws(()=>prepare(path.join(__dirname,'forbidden-generated-crate')),/outside repository/));
test('measured summary uses all pairs and keeps the original routing decision',()=>{
  const report=json('measurement.json');assert.equal(report.status,'complete');
  assert.equal(report.fixed.length,432);assert.equal(report.master.length,8);
  assert.deepEqual(summary(report.fixed),report.summary);
  assert.throws(()=>summary(report.fixed.slice(1)));
  const changed=clone(report.fixed);changed[0].result.nodes++;
  assert.throws(()=>summary(changed),/signature mismatch/);
});
if(process.argv[2])test('fresh candidate bytes match the measured module exactly',()=>{
  const bytes=fs.readFileSync(path.join(path.resolve(process.argv[2]),'dist/chessy-ai-fast.wasm'));
  assert.equal(sha(bytes),'7d1f2f9046dc46ca754445577a74a50e34f1eaaf6360fce9a1b07ddd9ff94a79');
  assert.equal(bytes.length,37885);
});
console.log(checks+' checks passed; no timing executed');
