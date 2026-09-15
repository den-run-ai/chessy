'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const H=require('../../tools/search/hash-cost');
const root=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hash-source-test-'));
try {
  const dest=path.join(tmp,'candidate'),before=fs.readFileSync(path.join(root,'experiments/wasm/src/search.rs'));
  const r=H.prepare(dest),after=fs.readFileSync(path.join(dest,'src/search.rs'),'utf8');
  assert.deepEqual(fs.readFileSync(path.join(root,'experiments/wasm/src/search.rs')),before);
  assert.equal(r.productionIntegrationAllowed,false);
  assert.equal(r.source.filter(x=>x.sha256!==r.generated.find(y=>y.path===x.path).sha256).map(x=>x.path).join(','),'src/search.rs');
  assert.match(after,/unsafe fn hash_position\(position: &mut Position\)/);
  assert.equal(after.split('advance_board_hash(position, mv, ply, true);').length,2);
  assert.equal(after.split('advance_board_hash(position, mv, ply, position.halfmove >= 4);').length,2);
  assert.match(after,/engine::has_legal_en_passant\(position\)/);
  for(const p of r.generated)assert.equal(H.sha(fs.readFileSync(path.join(dest,p.path))),p.sha256);
  assert.throws(()=>H.prepare(dest),/EEXIST/);
  assert.throws(()=>H.prepare(path.join(root,'forbidden-research-output')),/outside/);
  console.log('hash source isolation, unchanged engine/eval, anchored searched edges and exact snapshot hashes PASS');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
