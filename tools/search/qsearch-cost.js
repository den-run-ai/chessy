#!/usr/bin/env node
'use strict';
// Research-only source generation. Production Rust, WASM and fixtures stay frozen.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'../..');
const FILES=['Cargo.toml','Cargo.lock','rust-toolchain.toml','build.sh','src/engine.rs','src/eval.rs','src/lib.rs','src/search.rs'];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(v,m)=>{if(!v)throw Error(m);};
const once=(s,a,b)=>{check(s.split(a).length===2,'missing/ambiguous anchor '+a);return s.replace(a,b);};
// Re-execute retained generator bytes so cached code never attests a newer file.
if(typeof __qsearchGeneratorCaptured==='undefined'){
  const bytes=Buffer.from(fs.readFileSync(__filename));
  vm.compileFunction(bytes.toString('utf8').replace(/^#![^\n]*/,''),
    ['require','module','exports','__filename','__dirname','__qsearchGeneratorCaptured'],{filename:__filename})
    (require,module,module.exports,__filename,__dirname,bytes);
}else{
const generatorBytes=__qsearchGeneratorCaptured;
const template=n=>fs.readFileSync(path.join(__dirname,n),'utf8');
function patchEngine(source,variant='checks',readTemplate=template){
  let extra='';
  if(variant==='tactical'){
    const start=source.indexOf('pub fn generate_pseudo('),end=source.indexOf('\npub fn make_move(',start);
    check(start>=0&&end>start,'missing tactical generator anchors');
    extra=source.slice(start,end).replace('pub fn generate_pseudo(', 'pub fn generate_tactical(').replaceAll('append_move(', 'append_tactical_move(')
      .replace('if kind == PieceType::King {','if false && kind == PieceType::King {');
    extra+='\n'+readTemplate('qsearch-tactical.rs.in');
  }
  let tests=readTemplate('qsearch-engine-tests.rs.in');
  if(variant==='tactical')tests=once(tests,'let before=p;','assert_tactical_candidates(&p); let before=p;');
  return source+'\n'+extra+'\n'+readTemplate('qsearch-checks.rs.in')+'\n'+tests;
}
function patchSearch(original,variant='checks',readTemplate=template){
  let source=once(original,'        let generate_checks = qply < QCHECK_PLIES;',
    '        let generate_checks = qply < QCHECK_PLIES;\n        let enemy_king = position.king_sq[engine::color_index(enemy)];\n        let existing_check = generate_checks && engine::in_check(position, enemy);');
  source=once(source,'            if !keep && generate_checks {',
    '            if !keep && generate_checks && (existing_check || engine::quiet_may_give_check(position, mv, enemy_king)) {');
  if(variant==='tactical'){
    source=once(source,'    let mut count = generate_pseudo_at(position, ply);\n    if !has_legal_move(position, ply, Some(count)) {',
      `    let tactical_only = !in_check && qply >= QCHECK_PLIES && qply < QMAX && position.halfmove < 100;
    let mut count = if tactical_only {
        engine::generate_tactical(position, &mut *core::ptr::addr_of_mut!(CONTEXT.moves[ply]))
    } else { generate_pseudo_at(position, ply) };
    // A legal tactical move is sufficient to rule out stalemate. Otherwise
    // probe all moves in the unused next-ply arena without clobbering ours.
    if !has_legal_move(position, ply, Some(count))
        && !(tactical_only && has_legal_move(position, ply + 1, None)) {`);
    source=once(source,'    if !in_check {\n        let generate_checks',
      '    if !in_check && !tactical_only {\n        let generate_checks');
  }
  source+='\n#[cfg(test)]\nmod reference_search {\n'+original+'\n}\n'+readTemplate('qsearch-parity-tests.rs.in');
  return source;
}
function prepare(destination,variant='checks'){
  check(['checks','tactical'].includes(variant),'unknown qsearch variant');
  destination=path.resolve(destination);
  destination=path.join(fs.realpathSync(path.dirname(destination)),path.basename(destination));
  check(destination!==ROOT&&!destination.startsWith(ROOT+path.sep),'research output must be outside repository');
  const files=Object.fromEntries(FILES.map(p=>[p,fs.readFileSync(path.join(ROOT,'experiments/wasm',p))]));
  const deps=['qsearch-cost.js','qsearch-checks.rs.in','qsearch-engine-tests.rs.in','qsearch-parity-tests.rs.in','qsearch-tactical.rs.in'];
  const retained=Object.fromEntries(deps.map(p=>[p,p==='qsearch-cost.js'?generatorBytes:Buffer.from(fs.readFileSync(path.join(__dirname,p)))]));
  const unchanged=()=>FILES.every(p=>sha(fs.readFileSync(path.join(ROOT,'experiments/wasm',p)))===sha(files[p]))
    &&deps.every(p=>sha(fs.readFileSync(path.join(__dirname,p)))===sha(retained[p]));
  const readTemplate=p=>{check(retained[p],'missing retained template '+p);return retained[p].toString();};
  const generated={...files,'src/engine.rs':Buffer.from(patchEngine(files['src/engine.rs'].toString(),variant,readTemplate)),
    'src/search.rs':Buffer.from(patchSearch(files['src/search.rs'].toString(),variant,readTemplate))};
  check(unchanged(),'generator, template or source changed during preparation');
  fs.mkdirSync(destination);fs.mkdirSync(path.join(destination,'src'));
  for(const p of FILES)fs.writeFileSync(path.join(destination,p),generated[p],{flag:'wx'});
  const manifest={schema:'chessy.qsearch-cost.source.v2',variant,researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,
    source:FILES.map(p=>({path:p,sha256:sha(files[p])})),generated:FILES.map(p=>({path:p,sha256:sha(generated[p])})),
    dependencies:deps.map(p=>({path:p,sha256:sha(retained[p])}))};
  check(unchanged(),'generator, template or source changed before receipt publication');
  fs.writeFileSync(path.join(destination,'source.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}
if(require.main===module){check(process.argv.length>=4&&process.argv.length<=5&&process.argv[2]==='prepare','usage: qsearch-cost.js prepare /outside/research-directory');console.log(JSON.stringify(prepare(process.argv[3],process.argv[4]),null,2));}
module.exports={prepare,patchEngine,patchSearch,sha};
}
