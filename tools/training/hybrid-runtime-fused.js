#!/usr/bin/env node
'use strict';

// Bounded exact-score mechanism study. The preceding fitted runtime receipt,
// selected model and smooth-6-12 policy are immutable. No original dependency
// is edited, no model/gate is selected, and no strength game is run here.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {performance}=require('node:perf_hooks');
const Runtime=require('./hybrid-runtime'),Phase=require('./nnue-phase-runtime'),Exporter=require('./natural-runtime-export');
const Wasm=require('../../assets/wasm-engine');
const ROOT=path.resolve(__dirname,'../..'),TEMPLATE=path.join(__dirname,'hybrid-runtime-fused.rs.in');
const CONTRACT=path.join(ROOT,'eval/training/hybrid-runtime-fused-v1.md');
const FILES=['Cargo.toml','Cargo.lock','rust-toolchain.toml','build.sh','src/engine.rs','src/eval.rs','src/lib.rs','src/search.rs'];
const sha=Phase.sha,encode=x=>JSON.stringify(x,null,2)+'\n';
const check=(v,m)=>{if(!v)throw Error(m);};
const once=(s,a,b)=>{check(s.split(a).length===2,'missing/ambiguous phase-cache anchor: '+a);return s.replace(a,b);};
const VARIANTS=['original','cached','fused'];
const PLAN=Object.freeze({...Runtime.PLAN,order:'rotate [shipped,original,cached,fused] by (position+repetition)%4',
  configurations:VARIANTS,selectionByTimingAllowed:true,modelSelectionAllowed:false,requiredExactSearchSignatures:['nodes4096','nodes16384'],
  mechanismSelection:{minimumMedianNpsRatioVsOriginal16384:1.05,minimumEachPhaseNpsRatioVsOriginal16384:0.95,
    rankBy:'smallest absolute median elapsedMs across48 candidate16384-node records',tieBreak:'cached',
    requiresAll501ExactEvaluations:true,requiresAll96ExactNodeBudgetSearchResultsPerMechanism:true,
    noEligible:'none',followup:'one separately registered200-game20ms diagnostic arm versus shipped for selected mechanism only'}});

function patchEngine(source) {
  source=once(source,'    pub board: [Piece; BOARD_SQUARES],','    pub board: [Piece; BOARD_SQUARES],\n    pub hybrid_material_phase: i16,');
  source=once(source,'        board: [Piece::Empty; BOARD_SQUARES],','        board: [Piece::Empty; BOARD_SQUARES],\n        hybrid_material_phase: 0,');
  let writes=0,parseWrites=0;const parseStart=source.indexOf('pub fn parse_fen(');check(parseStart>0,'FEN parse boundary missing');
  source=source.replace(/^(\s*)position\.board\[(.*?)\] = ([\s\S]*?);/gm,(_,space,square,expression,offset)=>{
    writes++;const owned=offset>parseStart;if(owned)parseWrites++;
    return `${space}{\n${space}    let phase_next_piece = ${expression};\n${space}    let phase_square = ${square};\n${space}    hybrid_replace_square(${owned?'&mut position':'position'}, phase_square, phase_next_piece);\n${space}}`;
  });
  check(writes===16&&parseWrites===1&&!/position\.board\[.*?\]\s*=\s*[^=]/.test(source),'complete 16-write/one-parser mutation closure required');
  return source+`\n// Raw material phase tracks every transient board, without clipping.\n#[inline]\nfn hybrid_piece_phase(piece: Piece) -> i16 {\n    match piece_type(piece) { Some(PieceType::Knight | PieceType::Bishop) => 1, Some(PieceType::Rook) => 2, Some(PieceType::Queen) => 4, _ => 0 }\n}\n#[inline]\nfn hybrid_replace_square(position: &mut Position, square: usize, piece: Piece) {\n    position.hybrid_material_phase += hybrid_piece_phase(piece) - hybrid_piece_phase(position.board[square]);\n    position.board[square] = piece;\n}\n`;
}
function cachedEvaluator(source) {
  return once(source,`fn hybrid_phase(position: &Position) -> i32 {\n    let mut phase = 0;\n    for &piece in &position.board {\n        if let Some(kind) = engine::piece_type(piece) { phase += PHASE[kind as usize]; }\n    }\n    core::cmp::min(24, phase)\n}`,`fn hybrid_phase(position: &Position) -> i32 {\n    core::cmp::min(24, position.hybrid_material_phase as i32)\n}`);
}
function mechanismTests(original) {
  const fens=[...Runtime.FIXTURES.map(x=>x.fen),...Runtime.SPECIAL_FENS];
  return '\n#[cfg(test)]\nmod scalar_reference {\n'+original+'\n}\n'+`
#[cfg(test)]
mod phase_cache_fused_tests {
    use super::*;
    fn verify(position: &Position) {
        let raw: i16 = position.board.iter().map(|&piece| match engine::piece_type(piece) {
            Some(PieceType::Knight | PieceType::Bishop) => 1, Some(PieceType::Rook) => 2,
            Some(PieceType::Queen) => 4, _ => 0,
        }).sum();
        assert_eq!(position.hybrid_material_phase, raw);
        assert_eq!(evaluate(position), scalar_reference::evaluate(position));
    }
    fn walk(position: &mut Position, depth: u8, nodes: &mut u32) {
        verify(position); *nodes += 1;
        let original = *position;
        let _ = engine::has_legal_en_passant(position); assert!(*position == original); verify(position);
        let mut moves = [0; engine::MAX_MOVES];
        let count = engine::generate_legal(position, &mut moves); assert!(*position == original); verify(position);
        if depth == 0 { return; }
        for &mv in &moves[..count] {
            let undo = engine::make_move(position, mv);
            walk(position, depth - 1, nodes);
            engine::unmake_move(position, mv, undo);
            assert!(*position == original); verify(position);
        }
    }
    #[test]
    fn exact_score_and_raw_phase_through_every_special_move() {
        let fixtures: &[&[u8]] = &[${fens.map(f=>'b"'+f+'"').join(',\n')}];
        let mut nodes = 0;
        for &fen in fixtures { let mut position = engine::parse_fen(fen).unwrap();
            verify(&position); position.turn = engine::opposite(position.turn); verify(&position);
            position.turn = engine::opposite(position.turn); walk(&mut position, 2, &mut nodes);
        }
        assert!(nodes > 13900);
        assert_eq!(core::mem::size_of::<Position>(), 76);
        assert_eq!(core::mem::size_of::<engine::Undo>(), 10);
        println!("mechanism verified positions {}; Position bytes {}; Undo bytes {}", nodes,
            core::mem::size_of::<Position>(), core::mem::size_of::<engine::Undo>());
    }
    #[test]
    fn uncapped_parser_and_transient_queen_phase() {
        let all_queens = engine::parse_fen(b"QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ w - - 0 1").unwrap();
        assert_eq!(all_queens.hybrid_material_phase, 256);
        let mut promoted = engine::parse_fen(b"rnbq1k1r/pP1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8").unwrap();
        let mut nodes = 0; walk(&mut promoted, 2, &mut nodes);
        assert!(nodes > 1);
    }
}
`;
}
function fusedEvaluator(baseline,data,original) {
  check(data.config.id==='smooth-6-12'&&data.config.lo===6&&data.config.hi===12,'only frozen selected smooth-6-12 is allowed');
  const start=baseline.indexOf('pub fn evaluate(position: &Position) -> i32 {');check(start>0,'baseline evaluate boundary missing');
  const prefix=baseline.slice(0,start);
  const expanded=Exporter.exportRust(baseline,data.weights);
  const names=['PST_MG','PST_EG','MOBILITY','PASSED_MG','PASSED_EG','DOUBLED','ISOLATED','SHIELD','PAWN_ATTACK_MG','PAWN_ATTACK_EG'];
  const constants=names.map(name=>{const matches=expanded.match(new RegExp('^const '+name+': [\\s\\S]*?;\\n','gm'));
    check(matches?.length===1,'expanded constant unavailable: '+name);return matches[0].replace('const '+name+':','const X_'+name+':');}).join('\n');
  const neuralStart=original.indexOf('// Synthetic/private research template;');
  const neuralEnd=original.indexOf('#[cfg(test)]\nmod nnue_research_parity',neuralStart);
  check(neuralStart>0&&neuralEnd>neuralStart,'neural helper boundary missing');
  return prefix+constants+'\n'+original.slice(neuralStart,neuralEnd)+'\n'+fs.readFileSync(TEMPLATE,'utf8')+mechanismTests(original)+`
#[cfg(test)]
mod fused_rounding_tests {
    use super::*;
    #[test]
    fn negative_ties_and_common_mop_translation() {
        assert_eq!(hybrid_round(-3, 6), 0);
        assert_eq!(hybrid_round(-9, 6), -1);
        assert_eq!(hybrid_round(-12, 24), 0);
        assert_eq!(hybrid_round(-36, 24), -1);
        for phase in 7..12 { for neural in -4..=4 { for expanded in -4..=4 { for mop in [-67, 0, 61] {
            let n = (phase - 6) * neural + (12 - phase) * expanded;
            assert_eq!(hybrid_round(n, 6) + mop, hybrid_round(n + 6 * mop, 6));
            assert_eq!(hybrid_round(n, 6), ((n as f64) / 6.0 + 0.5).floor() as i32);
        }}}}
    }
}
`;
}
function rendered(prior,variant) {
  const original=Object.fromEntries(FILES.map(p=>[p,fs.readFileSync(path.join(prior,'hybrid',p))]));
  if(variant==='original')return {...original,'src/lib.rs':Buffer.from(original['src/lib.rs'].toString()+
    '\n#[cfg(test)]\nmod original_layout_test { #[test] fn unchanged_layout() { assert_eq!(core::mem::size_of::<crate::engine::Position>(), 74); assert_eq!(core::mem::size_of::<crate::engine::Undo>(), 10); } }\n')};
  const data=Runtime.inputs(JSON.parse(fs.readFileSync(path.join(prior,'inputs.json'))));
  const baseline=fs.readFileSync(path.join(ROOT,'experiments/wasm/src/eval.rs'),'utf8');
  const evalSource=original['src/eval.rs'].toString();
  return {...original,'src/engine.rs':Buffer.from(patchEngine(original['src/engine.rs'].toString())),
    'src/eval.rs':Buffer.from(variant==='cached'?cachedEvaluator(evalSource)+mechanismTests(evalSource):fusedEvaluator(baseline,data,evalSource))};
}
function prepare(destination,prior) {
  destination=Phase.outsideRepository(destination);const verified=Runtime.verifyPrepared(prior);
  check(verified.data.config.id==='smooth-6-12','original selected config differs');
  const dependencies=[__filename,TEMPLATE,CONTRACT].map(p=>({path:path.relative(ROOT,p),sha256:sha(fs.readFileSync(p))}));
  const outputs=VARIANTS.map(variant=>({variant,files:rendered(prior,variant)}));fs.mkdirSync(destination);
  for(const {variant,files}of outputs){fs.mkdirSync(path.join(destination,variant));fs.mkdirSync(path.join(destination,variant,'src'));
    for(const p of FILES)fs.writeFileSync(path.join(destination,variant,p),files[p],{flag:'wx'});}
  const receipt={schema:'chessy.hybrid-runtime-mechanism-build.v1',researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,
    modelSelectionAllowed:false,priorDirectory:fs.realpathSync(prior),priorSourceReceiptSha256:verified.receiptSha256,config:verified.data.config,
    plan:PLAN,dependencies,emitted:outputs.map(({variant,files})=>({variant,files:FILES.map(p=>({path:p,sha256:sha(files[p]),bytes:files[p].length}))}))};
  fs.writeFileSync(path.join(destination,'mechanism-source.json'),encode(receipt),{flag:'wx'});return receipt;
}
function verifyPrepared(directory) {
  const bytes=fs.readFileSync(path.join(directory,'mechanism-source.json')),receipt=JSON.parse(bytes);
  check(receipt.schema==='chessy.hybrid-runtime-mechanism-build.v1'&&receipt.productionIntegrationAllowed===false&&receipt.strengthClaimAllowed===false&&receipt.modelSelectionAllowed===false,'invalid mechanism receipt');
  check(JSON.stringify(receipt.plan)===JSON.stringify(PLAN),'mechanism plan changed');
  const paths=[__filename,TEMPLATE,CONTRACT];check(receipt.dependencies.length===paths.length,'dependency closure missing');
  receipt.dependencies.forEach((d,i)=>check(d.path===path.relative(ROOT,paths[i])&&d.sha256===sha(fs.readFileSync(paths[i])),'mechanism dependency changed'));
  const prior=Runtime.verifyPrepared(receipt.priorDirectory);check(prior.receiptSha256===receipt.priorSourceReceiptSha256&&JSON.stringify(receipt.config)===JSON.stringify(prior.data.config),'original receipt changed');
  check(JSON.stringify(receipt.emitted.map(x=>x.variant))===JSON.stringify(VARIANTS),'mechanism variants changed');
  for(const {variant,files}of receipt.emitted){const output=rendered(receipt.priorDirectory,variant);check(JSON.stringify(files.map(x=>x.path))===JSON.stringify(FILES),'mechanism inventory changed');
    for(const f of files){const actual=fs.readFileSync(path.join(directory,variant,f.path));check(actual.equals(output[f.path])&&sha(actual)===f.sha256&&actual.length===f.bytes,'mechanism source does not reproduce');}}
  return {receipt,receiptSha256:sha(bytes),prior};
}
function moduleFrom(bytes){return {bytes,engine:Wasm.loadSync(bytes),api:new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{now_ms:()=>performance.now()}}).exports};}
function direct(api,fen){const bytes=Buffer.from(fen);new Uint8Array(api.memory.buffer,api.input_ptr(),bytes.length).set(bytes);check(api.load_position(bytes.length)===0,'FEN rejected');
  for(let i=0;i<PLAN.evaluationWarmupCalls;i++)api.evaluate_loaded();const started=performance.now();let checksum=0;
  for(let i=0;i<PLAN.evaluationMeasuredCalls;i++)checksum+=api.evaluate_loaded();return {elapsedMs:performance.now()-started,checksum,repetitions:PLAN.evaluationMeasuredCalls};}
function summarize(records){const report={};for(const stage of ['all','opening','middlegame','endgame']){report[stage]={};
  for(const variant of VARIANTS){report[stage][variant]={};for(const comparator of ['shipped','original']){if(variant===comparator)continue;
    const groups={};for(const [kind,budget]of [['evaluation',null],...PLAN.nodeBudgets.map(n=>['nodes',n]),...PLAN.timeBudgetsMs.map(n=>['time',n])]){
      const times=[],elapsed=[],nps=[],depth=[];for(const row of records.filter(r=>r.variant===variant&&r.kind===kind&&r.budget===budget&&(stage==='all'||r.stage===stage))){
        const other=records.find(r=>r.variant===comparator&&r.kind===kind&&r.budget===budget&&r.position===row.position&&r.repetition===row.repetition);
        check(other&&row.elapsedMs>0&&other.elapsedMs>0,'missing/nonfinite timing pair');times.push(row.elapsedMs/other.elapsedMs);elapsed.push(row.elapsedMs);
        if(kind!=='evaluation'){check(row.result.nodes>0&&other.result.nodes>0,'invalid search nodes');nps.push((row.result.nodes/row.elapsedMs)/(other.result.nodes/other.elapsedMs));depth.push(row.result.depth-other.result.depth);}}
      groups[kind+(budget??'')]={pairs:times.length,medianElapsedMs:Phase.median(elapsed),pairedMedianTimeRatio:Phase.median(times)};if(nps.length)Object.assign(groups[kind+budget],{pairedMedianNpsRatio:Phase.median(nps),medianCompletedDepthDifference:Phase.median(depth)});}
    report[stage][variant][comparator]=groups;}}}return report;}
function selectMechanism(summary,searchMismatches,parityMismatches=[]) {
  const candidates=['cached','fused'].map(variant=>{
    const all=summary.all[variant].original.nodes16384;
    const phaseNpsRatios=Object.fromEntries(['opening','middlegame','endgame'].map(stage=>[stage,summary[stage][variant].original.nodes16384.pairedMedianNpsRatio]));
    check([all.pairedMedianNpsRatio,all.pairedMedianTimeRatio,all.medianElapsedMs,...Object.values(phaseNpsRatios)].every(x=>Number.isFinite(x)&&x>0),'invalid mechanism selection statistics');
    const exactEvaluation=!parityMismatches.some(x=>x.variant===variant),exactSearch=!searchMismatches.some(x=>x.variant===variant);
    const eligible=exactEvaluation&&exactSearch&&all.pairedMedianNpsRatio>=1.05&&Object.values(phaseNpsRatios).every(x=>x>=0.95);
    return {variant,eligible,exactEvaluation,exactSearch,medianNpsRatioVsOriginal16384:all.pairedMedianNpsRatio,
      medianTimeRatioVsOriginal16384:all.pairedMedianTimeRatio,medianElapsedMs16384:all.medianElapsedMs,phaseNpsRatios};
  });
  const eligible=candidates.filter(x=>x.eligible).sort((a,b)=>a.medianElapsedMs16384-b.medianElapsedMs16384||a.variant.localeCompare(b.variant));
  return {selected:eligible[0]?.variant||null,candidates,criteria:PLAN.mechanismSelection,followupGamesAllowed:eligible.length>0};
}
function measure(directory,output) {
  check(!fs.existsSync(output),'mechanism output already exists');const checked=verifyPrepared(directory),{receipt,prior}=checked;
  const modules={shipped:moduleFrom(fs.readFileSync(path.join(ROOT,'assets/chessy-ai-fast.wasm')))};
  for(const v of VARIANTS)modules[v]=moduleFrom(fs.readFileSync(path.join(directory,v,'dist/chessy-ai-fast.wasm')));
  check(sha(modules.shipped.bytes)===prior.receipt.baselineWasmSha256,'shipped baseline changed');
  check(modules.original.bytes.equals(fs.readFileSync(path.join(receipt.priorDirectory,'hybrid/dist/chessy-ai-fast.wasm'))),'concurrent original must reproduce exact prior module');
  for(const [name,m]of Object.entries(modules))check(m.engine.memoryBytes()===(name==='shipped'?26542080:26607616),'unexpected fixed memory');
  const parity=Runtime.parityFens().map(fen=>{const wanted=modules.original.engine.evaluate(fen),cached=modules.cached.engine.evaluate(fen),fused=modules.fused.engine.evaluate(fen);
    check(wanted===cached&&wanted===fused,'mechanism exact compiled parity failed: '+fen);return {fen,wanted,cached,fused};});
  fs.writeFileSync(output+'.preflight.json',encode({sourceReceiptSha256:checked.receiptSha256,parity}),{flag:'wx'});
  const names=['shipped',...VARIANTS],records=[];
  for(let repetition=0;repetition<PLAN.pairedRepetitions;repetition++)for(let position=0;position<Runtime.FIXTURES.length;position++){
    const {fen,stage}=Runtime.FIXTURES[position],offset=(position+repetition)%4;
    for(const variant of names.slice(offset).concat(names.slice(0,offset))){const m=modules[variant];
      records.push({variant,stage,position,repetition,kind:'evaluation',budget:null,...direct(m.api,fen)});
      for(const [kind,budget]of [...PLAN.nodeBudgets.map(n=>['nodes',n]),...PLAN.timeBudgetsMs.map(n=>['time',n])]){
        const started=performance.now(),result=m.engine.search(fen,{maxDepth:111,nodeLimit:kind==='nodes'?budget:0,timeMs:kind==='time'?budget:0,quiesce:true});
        records.push({variant,stage,position,repetition,kind,budget,elapsedMs:performance.now()-started,result});}}}
  check(records.length===768,'incomplete mechanism grid');
  const mismatches=[];for(const row of records.filter(r=>r.variant!=='shipped'&&r.variant!=='original'&&r.kind==='nodes')){
    const original=records.find(r=>r.variant==='original'&&r.position===row.position&&r.repetition===row.repetition&&r.kind===row.kind&&r.budget===row.budget);
    if(JSON.stringify(original.result)!==JSON.stringify(row.result))mismatches.push({variant:row.variant,position:row.position,repetition:row.repetition,budget:row.budget});}
  const details=Object.fromEntries(Object.entries(modules).map(([name,m])=>[name,{sha256:sha(m.bytes),rawBytes:m.bytes.length,
    brotliBytes:zlib.brotliCompressSync(m.bytes,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}).length,memoryBytes:m.engine.memoryBytes()}]));
  const summary=summarize(records),selection=selectMechanism(summary,mismatches);
  const report={schema:'chessy.hybrid-runtime-mechanism-cost.v1',status:mismatches.length?'failed':'completed',researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,
    modelSelectionAllowed:false,sourceReceiptSha256:checked.receiptSha256,priorSourceReceiptSha256:receipt.priorSourceReceiptSha256,config:receipt.config,
    modelSha256:prior.receipt.modelSha256,expandedWeightsSha256:prior.receipt.expandedWeightsSha256,plan:PLAN,
    runtime:{node:process.versions.node,v8:process.versions.v8,brotli:process.versions.brotli},modules:details,parity,parityMismatches:0,
    exactNodeBudgetSearchSignatures:mismatches.length===0,searchSignatureMismatches:mismatches,records,summary,selection,
    limitations:['One concurrent diagnostic V8 run; no hardware-independent cost or physical-device admission.',
      'Same selected model/gate; optimized mechanisms cannot change offline scores or claim further training saturation.',
      'A separate registered200-game arm may test the prospectively selected eligible mechanism; original game scores do not transfer automatically.',
      'Cached phase adds two bytes to Position and work to all board mutations; no neural accumulator cache or Undo growth.',
      'Research copies retain the extra memory page; production cap remains unchanged.']};
  fs.writeFileSync(output,encode(report),{flag:'wx'});return {status:report.status,modules:details,parityRows:parity.length,searchSignatureMismatches:mismatches,summary:report.summary,selection};
}
module.exports={PLAN,patchEngine,cachedEvaluator,fusedEvaluator,prepare,verifyPrepared,summarize,selectMechanism,measure};
if(require.main===module){const [command,...args]=process.argv.slice(2);try{
  if(command==='prepare'&&args.length===2)console.log(encode(prepare(...args)));
  else if(command==='measure'&&args.length===2){const result=measure(...args);console.log(encode(result));if(result.status!=='completed')process.exitCode=1;}
  else throw Error('usage: hybrid-runtime-fused.js prepare SCRATCH_DIRECTORY PRIOR_PRIVATE_BUILD; measure SCRATCH_DIRECTORY OUTPUT.json');
}catch(error){console.error(error.stack);process.exitCode=1;}}
