#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const FILES=['Cargo.toml','Cargo.lock','rust-toolchain.toml','build.sh','src/engine.rs','src/eval.rs','src/lib.rs','src/search.rs'];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(v,m)=>{if(!v)throw Error(m);};
const once=(s,a,b)=>{check(s.split(a).length===2,'missing/ambiguous anchor '+a);return s.replace(a,b);};
function patchSearch(original,templates){
  const start=original.indexOf('unsafe fn hash_position('),end=original.indexOf('\n#[inline]\nfn history_start_index',start);
  check(start>=0&&end>start,'canonical hash anchors missing');
  const oracle=original.slice(start,end),tail=oracle.slice(oracle.indexOf('    if position.turn == Color::White {'));
  check(tail.includes('engine::has_legal_en_passant(position)'),'EP semantics missing');
  const finish='unsafe fn finish_board_hash(position: &mut Position, mut h1: u32, mut h2: u32) -> Hash {\n'+tail;
  let out=once(original,'    let ctx = context();\n    ctx.quiesce = quiesce;',
    '    reset_board_hashes();\n    let ctx = context();\n    ctx.quiesce = quiesce;');
  out=once(out,'        hash = hash_position(position);','        hash = searched_hash(position, ply);');
  const searchStart=out.indexOf('unsafe fn search_node('),searchEnd=out.indexOf('\nunsafe fn shuffle_root(',searchStart);
  let search=out.slice(searchStart,searchEnd);
  search=once(search,'    let hash = hash_position(position);','    let hash = searched_hash(position, ply);');
  search=once(search,'        let mut score;\n        let mut child_rep;',
    '        advance_board_hash(position, mv, ply, true);\n        let mut score;\n        let mut child_rep;');
  out=out.slice(0,searchStart)+search+out.slice(searchEnd);
  out=once(out,'        let score = quiesce_node(position, alpha, beta, ply + 1, qply + 1);',
    '        advance_board_hash(position, mv, ply, position.halfmove >= 4);\n        let score = quiesce_node(position, alpha, beta, ply + 1, qply + 1);');
  check(out.split('    let root_hash = hash_position(position);').length===3,'two root hash sites required');
  out=out.replaceAll('    let root_hash = hash_position(position);','    let root_hash = searched_hash(position, 0);');
  out=once(out,'    engine::make_move(&mut child, root_move);\n    let score = search_node(',
    '    engine::make_move(&mut child, root_move);\n    advance_board_hash(&child, root_move, 0, true);\n    let score = search_node(');
  out=once(out,'                let undo = engine::make_move(position, mv);\n                let mut score;',
    '                let undo = engine::make_move(position, mv);\n                advance_board_hash(position, mv, 0, true);\n                let mut score;');
  const pv='\n#[cfg(test)] pub unsafe fn research_pv() -> std::vec::Vec<u32> { (0..PV_LENGTH).map(|i| *pv_entry(i)).collect() }\n';
  return out+'\n'+finish+'\n'+templates['hash-board.rs.in']+pv+'\n#[cfg(test)] mod reference_search {\n'+original+pv+'\n}\n'+templates['hash-parity.rs.in'];
}
function prepare(destination){
  destination=path.resolve(destination);destination=path.join(fs.realpathSync(path.dirname(destination)),path.basename(destination));
  check(destination!==ROOT&&!destination.startsWith(ROOT+path.sep),'research output must be outside repository');
  const files=Object.fromEntries(FILES.map(p=>[p,fs.readFileSync(path.join(ROOT,'experiments/wasm',p))]));
  const deps=['hash-cost.js','hash-board.rs.in','hash-parity.rs.in'];
  const retained=Object.fromEntries(deps.map(p=>[p,fs.readFileSync(path.join(__dirname,p))]));
  const templates=Object.fromEntries(Object.entries(retained).map(([p,b])=>[p,b.toString()]));
  const generated={...files,'src/search.rs':Buffer.from(patchSearch(files['src/search.rs'].toString(),templates))};
  fs.mkdirSync(destination);fs.mkdirSync(path.join(destination,'src'));
  for(const p of FILES)fs.writeFileSync(path.join(destination,p),generated[p],{flag:'wx'});
  const manifest={schema:'chessy.searched-board-hash.source.v1',researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,
    source:FILES.map(p=>({path:p,sha256:sha(files[p])})),generated:FILES.map(p=>({path:p,sha256:sha(generated[p])})),dependencies:deps.map(p=>({path:p,sha256:sha(retained[p])}))};
  fs.writeFileSync(path.join(destination,'source.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}
if(require.main===module){check(process.argv.length===4&&process.argv[2]==='prepare','usage: hash-cost.js prepare /outside/research-directory');console.log(JSON.stringify(prepare(process.argv[3]),null,2));}
module.exports={prepare,patchSearch,sha};
