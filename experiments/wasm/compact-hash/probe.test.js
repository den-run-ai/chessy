'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const cp=require('node:child_process'),os=require('node:os');
const {render,prepare,readBaseline,sha,BASE,ROOT}=require('./prepare.js');
const {snapshot}=require('./validate.js');
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
test('archived generation and validation keep their measured identities',()=>{
  const receipt=json('source-final.json'), report=json('validation.json');
  assert.equal(sha(read('measured-prepare.js.txt')),receipt.recipe.find(r=>r.path==='prepare.js').sha256);
  assert.equal(sha(read('measured-validate.js.txt')),report.implementation.find(r=>r.path.endsWith('/validate.js')).sha256);
});
const original=readBaseline().source['src/search.rs'].toString();
test('all retained negative variants reproduce their generated search identities',()=>{
  for(const [key,variant] of [['v1','threaded'],['v2','shared-update'],['v3','proven-indices'],['final','threaded']]){
    const receipt=json('source-'+key+'.json');
    assert.equal(sha(render(original,variant)),receipt.generated.find(r=>r.path==='src/search.rs').sha256,key);
  }
});
test('generator refuses an unknown variant or a changed canonical anchor',()=>{
  assert.throws(()=>render(original,'unknown'));
  assert.throws(()=>render(original.replace('unsafe fn hash_position(','unsafe fn renamed_hash_position(')));
});
test('generator refuses writes inside the repository',()=>assert.throws(()=>prepare(path.join(__dirname,'forbidden-generated-crate')),/outside repository/));
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-compact-reproduction-'));
try {
  const checkout=path.join(scratch,'checkout'), generated=path.join(scratch,'candidate');
  cp.execFileSync('git',['clone','--shared','--no-checkout','--quiet',ROOT,checkout]);
  // These active inputs are deliberately unusable. Reproduction must still
  // consume the historical Git objects, including the old strict loader.
  for(const file of ['experiments/wasm/src/search.rs','assets/chessy-ai-fast.wasm',
    'assets/engine.js','assets/wasm-engine.js','test/fixtures/wasm-r69-signatures.json']){
    const target=path.join(checkout,file);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,'changed active input: '+file);
  }
  test('active production changes cannot alter historical candidate generation',()=>{
    const receipt=prepare(generated,'threaded',checkout);
    assert.equal(receipt.schema,'chessy.compact-hash.source.v2');
    assert.equal(receipt.purpose,'historical-correctness-reproduction');
    assert.deepEqual(receipt.source,json('source-final.json').source);
    assert.deepEqual(receipt.generated,json('source-final.json').generated);
    assert.notDeepEqual(receipt.recipe,json('source-final.json').recipe,
      'fresh adapters must not claim the measured generator identity');
  });
  // snapshot() verifies input binding only; the CLI validator separately
  // instantiates and searches the compiled candidate. This inert placeholder
  // keeps the source/runtime isolation tests independent of a build or search.
  fs.mkdirSync(path.join(generated,'dist'));
  fs.writeFileSync(path.join(generated,'dist/chessy-ai-fast.wasm'),'unbuilt candidate placeholder');
  test('validation retains the historical module, loaders and fixture after activation',()=>{
    const frozen=snapshot(generated,checkout);
    assert.equal(sha(frozen.modules[0].bytes),registration.modules[0].sha256);
    for(const file of ['assets/engine.js','assets/wasm-engine.js','test/fixtures/wasm-r69-signatures.json']){
      const expected=json('validation.json').implementation.find(r=>r.path===file).sha256;
      assert.equal(sha(frozen.baseline.runtime[file]),expected,file);
    }
  });
  test('Git replacement refs cannot substitute a different historical baseline',()=>{
    const git=(args,opts={})=>cp.execFileSync('git',['-C',checkout,...args],opts).toString().trim();
    const tree=git(['mktree'],{input:''});
    const commit=git(['-c','user.name=Chessy test','-c','user.email=chessy-test@example.invalid',
      'commit-tree',tree,'-m','Synthetic replacement with no baseline inputs']);
    git(['replace',BASE,commit]);
    assert.equal(sha(readBaseline(checkout).source['src/search.rs']),sha(original));
    assert.equal(sha(snapshot(generated,checkout).modules[0].bytes),registration.modules[0].sha256);
  });
  for(const file of ['src/search.rs','Cargo.toml']){
    test('coherent source/receipt mutation fails with unchanged module: '+file,()=>{
      const receiptFile=path.join(generated,'source.json'), sourceFile=path.join(generated,file);
      const savedReceipt=fs.readFileSync(receiptFile), savedSource=fs.readFileSync(sourceFile);
      const moduleFile=path.join(generated,'dist/chessy-ai-fast.wasm'), savedModule=fs.readFileSync(moduleFile);
      try {
        const comment=file.endsWith('.rs')?'//':'#';
        const modified=Buffer.concat([savedSource,Buffer.from('\n'+comment+' coherent receipt mutation\n')]);
        const receipt=JSON.parse(savedReceipt);
        receipt.generated.find(entry=>entry.path===file).sha256=sha(modified);
        fs.writeFileSync(sourceFile,modified);fs.writeFileSync(receiptFile,JSON.stringify(receipt));
        assert.throws(()=>snapshot(generated,checkout),/generated recipe output drift/);
        assert.deepEqual(fs.readFileSync(moduleFile),savedModule,'the candidate module was not changed');
      } finally {
        fs.writeFileSync(sourceFile,savedSource);fs.writeFileSync(receiptFile,savedReceipt);
      }
      assert.equal(snapshot(generated,checkout).source.generated.find(entry=>entry.path===file).sha256,sha(savedSource));
    });
  }
  test('corrupted reproduction anchors and generated source still fail',()=>{
    const receiptFile=path.join(generated,'source.json'), saved=fs.readFileSync(receiptFile);
    const changed=JSON.parse(saved);changed.baseline[0].sha256='0'.repeat(64);
    fs.writeFileSync(receiptFile,JSON.stringify(changed));
    assert.throws(()=>snapshot(generated,checkout),/baseline runtime drift/);
    fs.writeFileSync(receiptFile,saved);
    fs.appendFileSync(path.join(generated,'src/search.rs'),'\n');
    assert.throws(()=>snapshot(generated,checkout),/generated source drift/);
  });
} finally {fs.rmSync(scratch,{recursive:true,force:true});}
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
