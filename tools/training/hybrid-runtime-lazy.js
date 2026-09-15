#!/usr/bin/env node
'use strict';

// One separately registered search-local accumulator; fitted output stays private.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),cp=require('node:child_process');
const {performance}=require('node:perf_hooks');
const Runtime=require('./hybrid-runtime'),Phase=require('./nnue-phase-runtime');
const Ref=require('../../test/training/h4-v3-reference'),Linear=require('../../test/training/hce-r3-linear');
const Wasm=require('../../assets/wasm-engine');
const ROOT=path.resolve(__dirname,'../..');
const TEMPLATE=path.join(__dirname,'hybrid-runtime-lazy.rs.in');
const TEST_TEMPLATE=path.join(__dirname,'hybrid-runtime-lazy-tests.rs.in');
const CONTRACT=path.join(ROOT,'eval/training/hybrid-runtime-lazy-v1.md');
const TEST=path.join(ROOT,'test/training/hybrid-runtime-lazy.test.js');
const FILES=['Cargo.toml','Cargo.lock','rust-toolchain.toml','build.sh','src/engine.rs','src/eval.rs','src/lib.rs','src/search.rs'];
const VARIANTS=['original','lazy'],NAMES=['shipped',...VARIANTS];
const sha=Phase.sha,encode=x=>JSON.stringify(x,null,2)+'\n';
const check=(v,m)=>{if(!v)throw Error(m);};
const once=(s,a,b)=>{check(s.split(a).length===2,'missing/ambiguous lazy anchor: '+a);return s.replace(a,b);};
const PLAN=Object.freeze({...Runtime.PLAN,order:'rotate [shipped,original,lazy] by (position+repetition)%3',configurations:VARIANTS,
  expectedRecords:576,selectionByTimingAllowed:true,modelSelectionAllowed:false,pvEqualityRequired:false,followupGamesAllowed:false,
  selection:{minimumMedianNpsRatioVsOriginal16384:1.05,minimumEachPhaseNpsRatioVsOriginal16384:0.95,
    exactCompiledEvaluations:501,exactReturnedNodeBudgetSearchPairs:96,allNativeValidationRequired:true,noEligible:'none'}});

function patchEvaluator(original) {
  const start=original.indexOf('pub fn evaluate_neural(position: &Position) -> i32 {');
  const end=original.indexOf('\n#[cfg(test)]',start);
  check(start>0&&end>start,'neural evaluator boundary missing');
  let cached=original.slice(start,end);
  cached=once(cached,'pub fn evaluate_neural(position: &Position) -> i32 {',
    'fn evaluate_neural_cached(position: &Position, nnue_acc: [[i32; NNUE_H]; 2]) -> i32 {');
  cached=once(cached,'    let mut nnue_acc = [NNUE_B1; 2];\n','');
  cached=once(cached,'        nnue_add_piece(&mut nnue_acc, piece, square);\n','');
  check(!cached.includes('nnue_add_piece(')&&cached.includes('nnue_finish(nnue_acc, position.turn, phase)'),'neural reconstruction not removed completely');
  let source=once(original,'pub fn evaluate(position: &Position) -> i32 { evaluate_hybrid(position) }',
    'pub(crate) fn evaluate_original(position: &Position) -> i32 { evaluate_hybrid(position) }');
  const tests=fs.readFileSync(TEST_TEMPLATE,'utf8').replace('{{FIXTURES}}',
    [...Runtime.FIXTURES.map(x=>x.fen),...Runtime.SPECIAL_FENS].map(f=>'b"'+f+'",').join('\n'));
  check(!tests.includes('{{'),'unexpanded lazy native test template');
  return source+'\n'+cached+'\n'+fs.readFileSync(TEMPLATE,'utf8')+'\n'+tests;
}

function patchSearch(original) {
  let source=original;
  for(const name of ['search_node','quiesce_node']) {
    source=once(source,`unsafe fn ${name}(\n    position: &mut Position,`,
      `unsafe fn ${name}(\n    position: &mut Position,\n    lazy: &mut eval::HybridLazyStack,`);
    source=source.replaceAll(`${name}(position, `,`${name}(position, lazy, `);
  }
  check((source.match(/eval::evaluate\(position\)/g)||[]).length===3,'expected three leaf evaluation sites');
  source=source.replaceAll('eval::evaluate(position)','eval::evaluate_lazy(position, lazy, ply)');
  source=once(source,'        let score = quiesce_node(position, lazy, alpha, beta, ply + 1, qply + 1);',
    '        lazy.enter(ply + 1, mv);\n        let score = quiesce_node(position, lazy, alpha, beta, ply + 1, qply + 1);');
  source=once(source,'        let mut score;\n        let mut child_rep;',
    '        lazy.enter(ply + 1, mv);\n        let mut score;\n        let mut child_rep;');
  source=once(source,'                let undo = engine::make_move(position, mv);\n                let mut score;',
    '                let undo = engine::make_move(position, mv);\n                lazy.enter(1, mv);\n                let mut score;');
  source=once(source,'    engine::make_move(&mut child, root_move);\n    let score = search_node(\n        &mut child,',
    '    engine::make_move(&mut child, root_move);\n    lazy.enter(1, root_move);\n    let score = search_node(\n        &mut child,\n        lazy,');
  const initialize='\n    let mut lazy_state = eval::HybridLazyStack::new();\n    let lazy = &mut lazy_state;';
  source=once(source,'    reset_context(quiesce, node_limit, time_ms, false);',
    '    reset_context(quiesce, node_limit, time_ms, false);'+initialize);
  source=once(source,'    reset_context(quiesce, node_limit, 0, true);',
    '    reset_context(quiesce, node_limit, 0, true);'+initialize);
  source=once(source,') -> AnalysisOutcome {\n    PV_LENGTH = 0;',') -> AnalysisOutcome {'+initialize+'\n    PV_LENGTH = 0;');
  check((source.match(/lazy\.enter\(/g)||[]).length===4,'expected four real-search edge hooks');
  check((source.match(/let mut lazy_state/g)||[]).length===3,'expected three root-owned stacks');
  check(!source.includes('eval::evaluate(position)'),'unpatched leaf evaluation');
  // Independent original search globals and control flow exist only in native tests.
  const scalar=original.replace('use crate::{engine, eval};','use crate::engine;\nmod eval { pub fn evaluate(p: &crate::engine::Position) -> i32 { crate::eval::evaluate_original(p) } }');
  const native=`
#[cfg(test)]
mod lazy_search_tests {
    use super::*;
    fn signature(r: &SearchResult) -> (Option<Move>, i32, u32, Option<u32>, u64, u64, u64, u64, u32, bool) {
        (r.mv,r.score,r.depth,r.attempted_depth,r.nodes,r.qnodes,r.cutoffs,r.researches,r.stop_reason as u32,r.tt_saturated)
    }
    fn scalar_signature(r: &scalar_search::SearchResult) -> (Option<Move>, i32, u32, Option<u32>, u64, u64, u64, u64, u32, bool) {
        (r.mv,r.score,r.depth,r.attempted_depth,r.nodes,r.qnodes,r.cutoffs,r.researches,r.stop_reason as u32,r.tt_saturated)
    }
    #[test]
    fn root_reset_abort_quiescence_and_pvs_returned_fields() {
        let _guard = crate::TEST_LOCK.lock().unwrap();
        unsafe {
            clear_game_history(); scalar_search::clear_game_history();
            let fixtures: &[&[u8]] = &[${Runtime.FIXTURES.map(x=>'b"'+x.fen+'"').join(',')}];
            let mut researches = 0; let mut qnodes = 0; let mut aborts = 0;
            for &fen in fixtures { for quiesce in [false, true] { for budget in [1, 64, 1024, 4096] {
                let mut a = engine::parse_fen(fen).unwrap(); let initial = a; let mut b = a;
                let actual = run(&mut a, 6, budget, 0, quiesce);
                let expected = scalar_search::run(&mut b, 6, budget, 0, quiesce);
                assert_eq!(signature(&actual), scalar_signature(&expected));
                assert!(a == initial && b == initial);
                researches += actual.researches; qnodes += actual.qnodes;
                if actual.stop_reason == StopReason::NodeLimit { aborts += 1; }
            }}}
            assert!(researches > 0 && qnodes > 0 && aborts > 0);
            println!("lazy native search researches {} qnodes {} budget aborts {}", researches, qnodes, aborts);
        }
    }
    #[test]
    fn fixed_and_forced_root_entrypoints() {
        let _guard = crate::TEST_LOCK.lock().unwrap();
        unsafe {
            clear_game_history(); scalar_search::clear_game_history();
            let fen = b"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
            for budget in [1, 64, 4096] { for quiesce in [false, true] {
                let mut a = engine::parse_fen(fen).unwrap(); let initial = a; let mut b = a;
                let actual = run_fixed(&mut a, 3, budget, quiesce);
                let expected = scalar_search::run_fixed(&mut b, 3, budget, quiesce);
                assert_eq!(signature(&actual), scalar_signature(&expected)); assert!(a == initial && b == initial);
                let mut moves = [0; MAX_MOVES]; let count = engine::generate_legal(&mut a, &mut moves); assert!(count > 1);
                for &mv in &moves[..2] {
                    begin_analysis(budget,quiesce); scalar_search::begin_analysis(budget,quiesce);
                    let actual = analyse_root(&mut a,abi_move(mv),3,0);
                    let expected = scalar_search::analyse_root(&mut b,scalar_search::abi_move(mv),3,0);
                    assert_eq!(actual.status as u32,expected.status as u32);
                    assert_eq!(signature(&actual.result),scalar_signature(&expected.result)); assert!(a == initial && b == initial);
                }
            }}
        }
    }
}
`;
  return source+'\n#[cfg(test)]\nmod scalar_search {\n'+scalar+'\n}\n'+native;
}

function rendered(prior,variant) {
  const files=Object.fromEntries(FILES.map(p=>[p,fs.readFileSync(path.join(prior,'hybrid',p))]));
  if(variant==='original')return files;
  return {...files,'src/eval.rs':Buffer.from(patchEvaluator(files['src/eval.rs'].toString())),
    'src/search.rs':Buffer.from(patchSearch(files['src/search.rs'].toString()))};
}
function dependencies(){return [__filename,TEMPLATE,TEST_TEMPLATE,CONTRACT,TEST].map(p=>({path:path.relative(ROOT,p),sha256:sha(fs.readFileSync(p))}));}
function prepare(destination,prior) {
  destination=Phase.outsideRepository(destination);const verified=Runtime.verifyPrepared(prior);
  check(verified.data.config.id==='smooth-6-12'&&verified.receipt.modelSha256==='3a759a37d3af0beed0dda352a05294686d286176a4dcbdfa85a3fabef0083f25','frozen fitted model/gate differs');
  const outputs=VARIANTS.map(variant=>({variant,files:rendered(prior,variant)})),deps=dependencies();fs.mkdirSync(destination);
  for(const {variant,files}of outputs){fs.mkdirSync(path.join(destination,variant));fs.mkdirSync(path.join(destination,variant,'src'));
    for(const p of FILES)fs.writeFileSync(path.join(destination,variant,p),files[p],{flag:'wx'});}
  const receipt={schema:'chessy.hybrid-runtime-lazy-build.v1',researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,modelSelectionAllowed:false,
    priorDirectory:fs.realpathSync(prior),priorSourceReceiptSha256:verified.receiptSha256,config:verified.data.config,modelSha256:verified.receipt.modelSha256,
    plan:PLAN,dependencies:deps,emitted:outputs.map(({variant,files})=>({variant,files:FILES.map(p=>({path:p,sha256:sha(files[p]),bytes:files[p].length}))}))};
  fs.writeFileSync(path.join(destination,'lazy-source.json'),encode(receipt),{flag:'wx'});return receipt;
}
function verifyPrepared(directory) {
  const bytes=fs.readFileSync(path.join(directory,'lazy-source.json')),receipt=JSON.parse(bytes);
  check(receipt.schema==='chessy.hybrid-runtime-lazy-build.v1'&&receipt.researchOnly===true&&receipt.productionIntegrationAllowed===false&&receipt.strengthClaimAllowed===false&&receipt.modelSelectionAllowed===false,'invalid lazy source receipt');
  check(JSON.stringify(receipt.plan)===JSON.stringify(PLAN),'lazy plan changed');
  check(JSON.stringify(receipt.dependencies)===JSON.stringify(dependencies()),'lazy dependency closure changed');
  const prior=Runtime.verifyPrepared(receipt.priorDirectory);
  check(prior.receiptSha256===receipt.priorSourceReceiptSha256&&receipt.modelSha256===prior.receipt.modelSha256&&JSON.stringify(receipt.config)===JSON.stringify(prior.data.config),'original reference changed');
  check(JSON.stringify(receipt.emitted.map(x=>x.variant))===JSON.stringify(VARIANTS),'lazy variant inventory differs');
  for(const {variant,files}of receipt.emitted){const expected=rendered(receipt.priorDirectory,variant);check(JSON.stringify(files.map(x=>x.path))===JSON.stringify(FILES),'lazy source inventory differs');
    for(const f of files){const actual=fs.readFileSync(path.join(directory,variant,f.path));check(actual.equals(expected[f.path])&&sha(actual)===f.sha256&&actual.length===f.bytes,'lazy generated source differs');}}
  return {receipt,receiptSha256:sha(bytes),prior};
}
function atomicNew(filename,bytes) {
  const temporary=filename+'.pending-'+process.pid;const fd=fs.openSync(temporary,'wx');
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.linkSync(temporary,filename);fs.unlinkSync(temporary);
  const parent=fs.openSync(path.dirname(path.resolve(filename)),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
  check(fs.readFileSync(filename).equals(bytes),'published bytes differ');
}
function toolchain() {
  const definitions=[['cargo',process.env.CHESSY_CARGO_BIN||'cargo',['--version']],
    ['rustc',process.env.CHESSY_RUSTC_BIN||'rustc',['--version','--verbose']],
    ['wasmOpt',process.env.CHESSY_WASM_OPT_BIN||'wasm-opt',['--version']]];
  return Object.fromEntries(definitions.map(([name,command,args])=>{
    const executable=command.includes('/')?path.resolve(command):(process.env.PATH||'').split(path.delimiter).map(p=>path.join(p,command)).find(p=>fs.existsSync(p));
    check(executable,'missing toolchain executable: '+command);const actual=fs.realpathSync(executable);
    return [name,{path:actual,sha256:sha(fs.readFileSync(actual)),version:cp.execFileSync(actual,args,{encoding:'utf8'}).trim()}];
  }));
}
function native(directory) {
  const verified=verifyPrepared(directory),output=path.join(directory,'lazy-native.json');check(!fs.existsSync(output),'native receipt exists');
  const tools=toolchain(),rows=[];
  for(const variant of VARIANTS){const result=cp.spawnSync(tools.cargo.path,['test','--locked','--offline','--target','x86_64-unknown-linux-gnu','--','--test-threads=1','--nocapture'],
    {cwd:path.join(directory,variant),env:{...process.env,RUSTC:tools.rustc.path},encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024});
    const log=Buffer.from((result.stdout||'')+(result.stderr||'')),logPath=path.join(directory,variant+'-native.log');atomicNew(logPath,log);
    rows.push({variant,status:result.status,signal:result.signal,error:result.error?String(result.error):null,logPath,logSha256:sha(log),bytes:log.length});
    if(result.status!==0)break;}
  const report={schema:'chessy.hybrid-runtime-lazy-native.v1',sourceReceiptSha256:verified.receiptSha256,toolchain:tools,passed:rows.length===2&&rows.every(r=>r.status===0),rows};
  atomicNew(output,Buffer.from(encode(report)));check(report.passed,'native validation failed; preserved logs');return report;
}
function verifyNative(directory,sourceHash) {
  const bytes=fs.readFileSync(path.join(directory,'lazy-native.json')),report=JSON.parse(bytes);
  check(report.schema==='chessy.hybrid-runtime-lazy-native.v1'&&report.sourceReceiptSha256===sourceHash&&report.passed===true&&JSON.stringify(report.rows.map(x=>x.variant))===JSON.stringify(VARIANTS),'native pass receipt missing');
  for(const row of report.rows){const log=fs.readFileSync(row.logPath);check(row.status===0&&row.logSha256===sha(log)&&row.bytes===log.length&&/test result: ok\./.test(log.toString()),'native evidence changed');}
  return {report,sha256:sha(bytes)};
}
function build(directory) {
  const verified=verifyPrepared(directory),nativeEvidence=verifyNative(directory,verified.receiptSha256);
  const output=path.join(directory,'lazy-compiled.json');check(!fs.existsSync(output),'compiled receipt exists');
  const tools=toolchain();check(JSON.stringify(tools)===JSON.stringify(nativeEvidence.report.toolchain),'toolchain changed since native checks');
  const rows=[];
  for(const variant of VARIANTS){const result=cp.spawnSync('/bin/sh',['build.sh'],{cwd:path.join(directory,variant),encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024,
    env:{...process.env,CHESSY_CARGO_BIN:tools.cargo.path,CHESSY_RUSTC_BIN:tools.rustc.path,CHESSY_WASM_OPT_BIN:tools.wasmOpt.path,
      CHESSY_CARGO_TARGET_DIR:path.join(directory,variant,'target-wasm')}});
    const log=Buffer.from((result.stdout||'')+(result.stderr||'')),logPath=path.join(directory,variant+'-build.log');atomicNew(logPath,log);
    const modulePath=path.join(directory,variant,'dist/chessy-ai-fast.wasm');
    rows.push({variant,status:result.status,signal:result.signal,error:result.error?String(result.error):null,logPath,logSha256:sha(log),bytes:log.length,
      modulePath,moduleSha256:result.status===0?sha(fs.readFileSync(modulePath)):null});if(result.status!==0)break;
  }
  const report={schema:'chessy.hybrid-runtime-lazy-compiled.v1',sourceReceiptSha256:verified.receiptSha256,nativeEvidenceSha256:nativeEvidence.sha256,
    toolchain:tools,passed:rows.length===2&&rows.every(r=>r.status===0),rows};atomicNew(output,Buffer.from(encode(report)));
  check(report.passed,'compiled build failed; preserved logs');return report;
}
function verifyBuild(directory,sourceHash,nativeHash) {
  const bytes=fs.readFileSync(path.join(directory,'lazy-compiled.json')),report=JSON.parse(bytes);
  check(report.schema==='chessy.hybrid-runtime-lazy-compiled.v1'&&report.sourceReceiptSha256===sourceHash&&report.nativeEvidenceSha256===nativeHash&&report.passed===true&&JSON.stringify(report.rows.map(x=>x.variant))===JSON.stringify(VARIANTS),'compiled build pass receipt missing');
  for(const row of report.rows){const log=fs.readFileSync(row.logPath);check(row.status===0&&row.logSha256===sha(log)&&row.bytes===log.length&&row.moduleSha256===sha(fs.readFileSync(row.modulePath)),'compiled evidence changed');}
  return {report,sha256:sha(bytes)};
}
function moduleFrom(bytes){return {bytes,engine:Wasm.loadSync(bytes),api:new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{now_ms:()=>performance.now()}}).exports};}
function direct(api,fen){const bytes=Buffer.from(fen);new Uint8Array(api.memory.buffer,api.input_ptr(),bytes.length).set(bytes);check(api.load_position(bytes.length)===0,'FEN rejected');
  for(let i=0;i<PLAN.evaluationWarmupCalls;i++)api.evaluate_loaded();let checksum=0;const started=performance.now();
  for(let i=0;i<PLAN.evaluationMeasuredCalls;i++)checksum+=api.evaluate_loaded();return {elapsedMs:performance.now()-started,checksum,repetitions:PLAN.evaluationMeasuredCalls};}
function summarize(records) {
  const report={};for(const stage of ['all','opening','middlegame','endgame']){report[stage]={};for(const variant of VARIANTS){report[stage][variant]={};
    for(const comparator of ['shipped','original']){if(comparator===variant)continue;const metrics={};
      for(const [kind,budget]of [['evaluation',null],...PLAN.nodeBudgets.map(n=>['nodes',n]),...PLAN.timeBudgetsMs.map(n=>['time',n])]){
        const times=[],nps=[],elapsed=[];let full=0;
        for(const row of records.filter(r=>r.variant===variant&&r.kind===kind&&r.budget===budget&&(stage==='all'||r.stage===stage))){
          const other=records.find(r=>r.variant===comparator&&r.kind===kind&&r.budget===budget&&r.position===row.position&&r.repetition===row.repetition);
          check(other&&row.elapsedMs>0&&other.elapsedMs>0,'missing/invalid paired observation');times.push(row.elapsedMs/other.elapsedMs);elapsed.push(row.elapsedMs);
          if(kind!=='evaluation'){check(row.result.nodes>0&&other.result.nodes>0,'invalid visited nodes');nps.push((row.result.nodes/row.elapsedMs)/(other.result.nodes/other.elapsedMs));
            if(kind==='nodes')full+=Number(row.result.nodes===budget&&other.result.nodes===budget);}}
        const metric={pairs:times.length,pairedMedianTimeRatio:Phase.median(times),medianElapsedMs:Phase.median(elapsed)};
        if(nps.length)Object.assign(metric,{pairedMedianNpsRatio:Phase.median(nps),bothConsumedNodeBudget:kind==='nodes'?full:null});metrics[kind+(budget??'')]=metric;
      }report[stage][variant][comparator]=metrics;
    }}
  }return report;
}
function select(summary,exactEvaluation,exactSearch,nativeValidationPassed) {
  const overall=summary.all.lazy.original.nodes16384.pairedMedianNpsRatio;
  const phaseNpsRatios=Object.fromEntries(['opening','middlegame','endgame'].map(s=>[s,summary[s].lazy.original.nodes16384.pairedMedianNpsRatio]));
  check([overall,...Object.values(phaseNpsRatios)].every(x=>Number.isFinite(x)&&x>0),'invalid lazy selection statistic');
  const eligible=exactEvaluation&&exactSearch&&nativeValidationPassed&&overall>=1.05&&Object.values(phaseNpsRatios).every(x=>x>=0.95);
  return {selected:eligible?'lazy':null,eligible,exactEvaluation,exactSearch,nativeValidationPassed,
    medianNpsRatioVsOriginal16384:overall,phaseNpsRatios,criteria:PLAN.selection};
}
function measure(directory,output) {
  check(!fs.existsSync(output),'lazy cost output exists');const checked=verifyPrepared(directory),{receipt,prior}=checked;
  const nativeEvidence=verifyNative(directory,checked.receiptSha256);
  const compiledEvidence=verifyBuild(directory,checked.receiptSha256,nativeEvidence.sha256);
  const modules={shipped:moduleFrom(fs.readFileSync(path.join(ROOT,'assets/chessy-ai-fast.wasm')))};
  for(const variant of VARIANTS)modules[variant]=moduleFrom(fs.readFileSync(path.join(directory,variant,'dist/chessy-ai-fast.wasm')));
  check(sha(modules.shipped.bytes)===prior.receipt.baselineWasmSha256,'shipped bytes changed');
  check(modules.original.bytes.equals(fs.readFileSync(path.join(receipt.priorDirectory,'hybrid/dist/chessy-ai-fast.wasm'))),'original module must reproduce exact bytes');
  for(const [name,m]of Object.entries(modules))check(m.engine.memoryBytes()===(name==='shipped'?26542080:26607616),'memory policy changed');
  const layout={positionBytes:modules.lazy.api.hybrid_lazy_position_bytes(),undoBytes:modules.lazy.api.hybrid_lazy_undo_bytes(),stackBytes:modules.lazy.api.hybrid_lazy_stack_bytes()};
  check(layout.positionBytes===74&&layout.undoBytes===10&&layout.stackBytes>0,'unexpected lazy layout');
  const parity=Runtime.parityFens().map(fen=>{
    const shipped=modules.shipped.engine.evaluate(fen),expanded=Linear.runtimeRoundedScore(Linear.compile(fen),prior.data.weights);
    const neural=Ref.infer(prior.data.model,fen,shipped),phase=Ref.parseFen(fen).phaseUnits;
    const wanted=Runtime.mix(receipt.config,phase,expanded,neural),original=modules.original.engine.evaluate(fen),actual=modules.lazy.engine.evaluate(fen);
    check(wanted===original&&wanted===actual,'independent lazy full score parity failed: '+fen);return {fen,phase,shipped,expanded,neural,wanted,original,actual};});
  check(parity.length===501,'compiled parity inventory differs');
  atomicNew(output+'.preflight.json',Buffer.from(encode({sourceReceiptSha256:checked.receiptSha256,nativeEvidenceSha256:nativeEvidence.sha256,layout,parity})));
  const ledger=path.join(fs.realpathSync(receipt.priorDirectory),'.hybrid-runtime-lazy-v1.started.json');
  const start={schema:'chessy.hybrid-runtime-lazy-start.v1',sourceReceiptSha256:checked.receiptSha256,directory:fs.realpathSync(directory),output:path.resolve(output),startedAt:new Date().toISOString()};
  const fd=fs.openSync(ledger,'wx');try{fs.writeFileSync(fd,encode(start));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const ledgerParent=fs.openSync(path.dirname(ledger),'r');try{fs.fsyncSync(ledgerParent);}finally{fs.closeSync(ledgerParent);}
  const records=[];
  try {
    for(let repetition=0;repetition<PLAN.pairedRepetitions;repetition++)for(let position=0;position<Runtime.FIXTURES.length;position++){
      const {fen,stage}=Runtime.FIXTURES[position],offset=(position+repetition)%NAMES.length;
      for(const variant of NAMES.slice(offset).concat(NAMES.slice(0,offset))){const m=modules[variant];
        records.push({variant,stage,position,repetition,kind:'evaluation',budget:null,...direct(m.api,fen)});
        for(const [kind,budget]of [...PLAN.nodeBudgets.map(n=>['nodes',n]),...PLAN.timeBudgetsMs.map(n=>['time',n])]){
          const started=performance.now(),result=m.engine.search(fen,{maxDepth:PLAN.maxDepth,nodeLimit:kind==='nodes'?budget:0,timeMs:kind==='time'?budget:0,quiesce:true});
          records.push({variant,stage,position,repetition,kind,budget,elapsedMs:performance.now()-started,result});
        }
      }
    }
  } catch(error) { atomicNew(output+'.incomplete.json',Buffer.from(encode({start,records,error:String(error)})));throw error; }
  check(records.length===576,'incomplete lazy grid');
  const mismatches=[];for(const row of records.filter(r=>r.variant==='lazy'&&r.kind==='nodes')){
    const original=records.find(r=>r.variant==='original'&&r.kind===row.kind&&r.budget===row.budget&&r.position===row.position&&r.repetition===row.repetition);
    if(JSON.stringify(original.result)!==JSON.stringify(row.result))mismatches.push({position:row.position,repetition:row.repetition,budget:row.budget});}
  const details=Object.fromEntries(Object.entries(modules).map(([name,m])=>[name,{sha256:sha(m.bytes),rawBytes:m.bytes.length,
    brotliBytes:zlib.brotliCompressSync(m.bytes,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}).length,memoryBytes:m.engine.memoryBytes()}]));
  const summary=summarize(records),selection=select(summary,true,mismatches.length===0,true);
  const report={schema:'chessy.hybrid-runtime-lazy-cost.v1',status:mismatches.length?'failed':'completed',researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,modelSelectionAllowed:false,
    sourceReceiptSha256:checked.receiptSha256,priorSourceReceiptSha256:receipt.priorSourceReceiptSha256,nativeEvidenceSha256:nativeEvidence.sha256,
    compiledEvidenceSha256:compiledEvidence.sha256,toolchain:compiledEvidence.report.toolchain,
    modelSha256:receipt.modelSha256,expandedWeightsSha256:prior.receipt.expandedWeightsSha256,config:receipt.config,plan:PLAN,start,
    runtime:{node:process.versions.node,v8:process.versions.v8,brotli:process.versions.brotli},modules:details,layout,parity,parityMismatches:0,
    exactReturnedNodeBudgetSearchPairs:96,exactReturnedNodeBudgetSearchSignatures:mismatches.length===0,searchSignatureMismatches:mismatches,pvEqualityClaimed:false,
    records,summary,selection,limitations:['One quiet-host diagnostic V8 grid; no physical-device or strength admission.',
      'Identical frozen fitted evaluator; this changes neither training nor teacher-test evidence.',
      'Position is unchanged; local per-search accumulator storage and initialization have cost.',
      'Returned search fields are checked exactly; the API exposes no PV and PV equality is not claimed.',
      'Any games require a separately prospectively registered protocol and independent audit.']};
  const bytes=Buffer.from(encode(report)),compressed=zlib.gzipSync(bytes,{level:9});
  atomicNew(output,bytes);atomicNew(output+'.gz',compressed);
  atomicNew(output+'.integrity.json',Buffer.from(encode({schema:'chessy.hybrid-runtime-lazy-integrity.v1',sha256:sha(bytes),bytes:bytes.length,
    gzipSha256:sha(compressed),gzipBytes:compressed.length,recordCount:records.length,sourceReceiptSha256:checked.receiptSha256})));
  return {status:report.status,modules:details,layout,selection,searchSignatureMismatches:mismatches};
}
module.exports={PLAN,patchEvaluator,patchSearch,rendered,prepare,verifyPrepared,native,verifyNative,build,verifyBuild,summarize,select,atomicNew,measure};
if(require.main===module){const [command,...args]=process.argv.slice(2);try{
  if(command==='prepare'&&args.length===2)console.log(encode(prepare(...args)));
  else if(command==='native'&&args.length===1)console.log(encode(native(...args)));
  else if(command==='build'&&args.length===1)console.log(encode(build(...args)));
  else if(command==='measure'&&args.length===2){const result=measure(...args);console.log(encode(result));if(result.status!=='completed')process.exitCode=1;}
  else throw Error('usage: hybrid-runtime-lazy.js prepare DIRECTORY PRIOR_BUILD; native DIRECTORY; build DIRECTORY; measure DIRECTORY OUTPUT.json');
}catch(error){console.error(error.stack);process.exitCode=1;}}
