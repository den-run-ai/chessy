'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Adapter=require('../../tools/training/nnue-incremental');
const Legacy=require('../../tools/training/nnue-phase-runtime');
const root=path.resolve(__dirname,'../..');
const files=['Cargo.toml','Cargo.lock','rust-toolchain.toml','build.sh','src/engine.rs','src/eval.rs','src/lib.rs','src/search.rs'];
const source=Object.fromEntries(files.map(p=>[p,fs.readFileSync(path.join(root,'experiments/wasm',p))]));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-incremental-'));
try {
  for(const hidden of [4,8])for(const implementation of ['fused','incremental']) {
    const directory=path.join(tmp,`${hidden}-${implementation}`);
    const receipt=Adapter.prepare(directory,hidden,implementation);
    assert.equal(receipt.syntheticOnly,true);assert.equal(receipt.strengthClaimAllowed,false);
    assert.equal(receipt.productionIntegrationAllowed,false);assert.equal(receipt.emitted.length,8);
    assert.equal(receipt.accumulatorPayloadBytes,implementation==='incremental'?hidden*8:0);
    const engine=fs.readFileSync(path.join(directory,'src/engine.rs'),'utf8');
    const evaluator=fs.readFileSync(path.join(directory,'src/eval.rs'),'utf8');
    if(implementation==='incremental') {
      assert.equal((engine.match(/position\.board\[.*?\]\s*=\s*[^=]/g)||[]).length,1);
      assert.equal((engine.match(/nnue_replace_square\((?:&mut )?position, nnue_square, nnue_next_piece\);/g)||[]).length,16);
      assert.equal((engine.match(/nnue_replace_square\(&mut position, nnue_square, nnue_next_piece\);/g)||[]).length,1);
      assert(engine.includes('nnue_acc: [crate::eval::NNUE_B1; 2]'));
      assert(evaluator.includes('nnue_finish(position.nnue_acc, position.turn, phase)'));
      assert(!evaluator.includes('nnue_add_piece(&mut nnue_acc, piece, square)'));
      assert(evaluator.includes('coverage.iter().all'));
    } else assert.equal(engine,source['src/engine.rs'].toString());
    assert.equal(fs.readFileSync(path.join(directory,'src/search.rs')).compare(source['src/search.rs']),0);
    assert.throws(()=>Adapter.prepare(directory,hidden,implementation),/EEXIST/);
    assert.throws(()=>Adapter.loadPrepared(directory),/ENOENT/);
    const file=path.join(directory,'src/engine.rs');fs.appendFileSync(file,'\n');
    assert.throws(()=>Adapter.loadPrepared(directory),/does not reproduce/);
  }
  assert.throws(()=>Adapter.patchEngine(source['src/engine.rs'].toString().replace('position.board[square] = piece;','')),/16-write/);
  assert.throws(()=>Adapter.renderAll(source,16,'incremental'),/registered/);
  const contract=JSON.parse(fs.readFileSync(path.join(root,'eval/training/nnue-incremental-v1.json')));
  Adapter.validateContract(contract);
  for(const key of Object.keys(contract.timing)) {
    const bad=structuredClone(contract);bad.timing[key]=null;
    assert.throws(()=>Adapter.validateContract(bad),/diagnostic plan/);
  }
  for(const hidden of [4,8]) {
    const bad=structuredClone(contract);bad.syntheticParameters[`hidden${hidden}Sha256`]='0'.repeat(64);
    assert.throws(()=>Adapter.validateContract(bad),/parameter digest/);
  }
  for(const p of files)assert.equal(Legacy.sha(fs.readFileSync(path.join(root,'experiments/wasm',p))),Legacy.sha(source[p]));
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
console.log('PASS: incremental synthetic adapter,16-write closure,isolation,no-replace and mutation checks');
