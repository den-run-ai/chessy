#!/usr/bin/env node
'use strict';

// A separately registered synthetic mechanism experiment. The preceding probe
// and all production files remain untouched. No trained-model input is accepted.
const fs=require('node:fs'), path=require('node:path'), zlib=require('node:zlib');
const {performance}=require('node:perf_hooks');
const Legacy=require('./nnue-phase-runtime');
const Ref=require('../../test/training/h4-v3-reference');
const Wasm=require('../../assets/wasm-engine');
const ROOT=path.resolve(__dirname,'../..');
const CONTRACT=path.join(ROOT,'eval/training/nnue-incremental-v1.json');
const TEMPLATE=path.join(__dirname,'nnue-incremental.rs.in');
const FILES=['Cargo.toml','Cargo.lock','rust-toolchain.toml','build.sh','src/engine.rs','src/eval.rs','src/lib.rs','src/search.rs'];
const DEPENDENCIES=[__filename,TEMPLATE,CONTRACT,path.join(__dirname,'nnue-phase-runtime.js'),
  path.join(__dirname,'nnue-phase-runtime.rs.in'),path.join(ROOT,'test/training/h4-v3-reference.js'),path.join(ROOT,'assets/wasm-engine.js')];
const sha=Legacy.sha, encode=x=>JSON.stringify(x,null,2)+'\n';
const check=(condition,message)=>{if(!condition)throw Error(message);};
const once=(source,anchor,value)=>{check(source.split(anchor).length===2,'missing/ambiguous anchor: '+anchor);return source.replace(anchor,value);};

function contract() {
  const bytes=fs.readFileSync(CONTRACT), value=JSON.parse(bytes);
  check(value.schema==='chessy.nnue-incremental-protocol.v1' && value.syntheticOnly===true &&
    value.productionIntegrationAllowed===false && value.strengthClaimAllowed===false,'prospective synthetic contract required');
  validateContract(value);
  return {value,sha256:sha(bytes)};
}

function validateContract(value) {
  const expected={positions:8,positionsSha256:sha(JSON.stringify(Legacy.FENS)),
    positionSource:'exact original eight legal authored timing fixtures; six are endgames',pairedRepetitions:4,
    engineOrder:'candidate-first iff (position+repetition) odd; baseline-first otherwise',
    evaluationWarmupCalls:1000,evaluationMeasuredCalls:10000,nodeBudgets:[4096,16384],maxDepth:111,
    timeLimitMs:0,quiescence:true,completeRecordsPerConfiguration:192,perPositionDisclosureRequired:true};
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  check(value.trainedModelInputsAllowed===false&&Object.keys(value.timing).length===Object.keys(expected).length&&
    Object.entries(expected).every(([key,wanted])=>same(value.timing[key],wanted)), 'frozen diagnostic plan differs');
  check(same(value.configurations.hiddenWidths,[4,8])&&same(value.configurations.implementations,['fused','incremental'])&&
    same(value.configurations.order,['h4-fused','h4-incremental','h8-fused','h8-incremental'])&&value.configurations.selectionAfterRunAllowed===false,'configuration plan differs');
  for(const hidden of [4,8])check(value.syntheticParameters[`hidden${hidden}Sha256`]===sha(Legacy.synthetic(hidden).bytes),'registered synthetic parameter digest differs');
  check(value.mutation.boardAssignmentClosure===16&&value.mutation.undoChangeAllowed===false&&
    value.mutation.extraMutableGlobalCacheAllowed===false&&value.mutation.cachedPhase===false&&
    value.mutation.transientAccumulatorClippingAllowed===false&&same(value.mutation.positionPayloadBytes,{H4:32,H8:64}),'mutation contract differs');
  check(value.preflight.buildAndNativeTestsForAllFourBeforeTiming===true&&value.preflight.staticWasmParityForAllFourBeforeTiming===true&&
    value.preflight.staticCasesPerConfiguration===Legacy.PARITY_FENS.length,'preflight contract differs');
  check(value.validation.sameWidthFusedAndIncrementalSearchSignaturesMustMatch===true&&value.validation.completeGridRequired===true&&
    value.validation.incompleteRunCannotBeScored===true&&value.validation.noSelectiveRetry===true&&
    value.validation.failedCompleteGridRetained===true,'validation contract differs');
  check(value.build.productionMemoryBytes===26542080&&value.build.researchInitialAndMaximumMemoryBytes===26607616&&
    value.build.productionFilesMayChange===false,'build allowance differs');
}

function patchEngine(source) {
  source=once(source,'    pub board: [Piece; BOARD_SQUARES],',
    '    pub board: [Piece; BOARD_SQUARES],\n    pub nnue_acc: [[i32; crate::eval::NNUE_H]; 2],');
  source=once(source,'        board: [Piece::Empty; BOARD_SQUARES],',
    '        board: [Piece::Empty; BOARD_SQUARES],\n        nnue_acc: [crate::eval::NNUE_B1; 2],');
  let writes=0,parseWrites=0;
  const parseStart=source.indexOf('pub fn parse_fen(');
  check(parseStart>0,'FEN parser boundary missing');
  source=source.replace(/^(\s*)position\.board\[(.*?)\] = ([\s\S]*?);/gm, (_,space,square,expression,offset)=>{
    writes++;
    const argument=offset>parseStart?'&mut position':'position';
    if(offset>parseStart)parseWrites++;
    return `${space}{\n${space}    let nnue_next_piece = ${expression};\n${space}    let nnue_square = ${square};\n${space}    nnue_replace_square(${argument}, nnue_square, nnue_next_piece);\n${space}}`;
  });
  check(writes===16&&parseWrites===1,'expected complete frozen 16-write board mutation inventory including one owned FEN write');
  check(!/position\.board\[.*?\]\s*=\s*[^=]/.test(source),'unconverted board write');
  return source+`\n// All board mutation in this copied research core passes here.\n#[inline]\nfn nnue_replace_square(position: &mut Position, square: usize, piece: Piece) {\n    let old = position.board[square];\n    if old != piece {\n        if old != Piece::Empty { crate::eval::nnue_adjust_piece(&mut position.nnue_acc, old, square, -1); }\n        if piece != Piece::Empty { crate::eval::nnue_adjust_piece(&mut position.nnue_acc, piece, square, 1); }\n    }\n    position.board[square] = piece;\n}\n`;
}

function renderAll(captured,hidden,implementation) {
  check([4,8].includes(hidden)&&['fused','incremental'].includes(implementation),'registered H4/H8 implementations only');
  const fixture=Legacy.synthetic(hidden), output={...captured};
  output['build.sh']=Buffer.from(Legacy.researchBuild(captured['build.sh'].toString()));
  let evaluator=Legacy.render(captured['src/eval.rs'].toString(),
    fs.readFileSync(path.join(__dirname,'nnue-phase-runtime.rs.in'),'utf8'),fixture.model,'fused');
  if(implementation==='incremental') {
    evaluator=once(evaluator,'const NNUE_H: usize =','pub(crate) const NNUE_H: usize =');
    evaluator=once(evaluator,'const NNUE_B1: [i32; NNUE_H] =','pub(crate) const NNUE_B1: [i32; NNUE_H] =');
    evaluator=once(evaluator,'    let mut nnue_acc = [NNUE_B1; 2];\n','');
    evaluator=once(evaluator,'        nnue_add_piece(&mut nnue_acc, piece, square);\n','');
    evaluator=once(evaluator,'nnue_finish(nnue_acc, position.turn, phase)','nnue_finish(position.nnue_acc, position.turn, phase)');
    evaluator+='\n'+fs.readFileSync(TEMPLATE,'utf8');
    output['src/engine.rs']=Buffer.from(patchEngine(captured['src/engine.rs'].toString()));
  }
  output['src/eval.rs']=Buffer.from(evaluator);
  // Same measurement exports in both controls. No new mutable global cache.
  output['src/lib.rs']=Buffer.from(captured['src/lib.rs'].toString()+
    '\n#[no_mangle]\npub extern "C" fn research_position_bytes() -> u32 { core::mem::size_of::<engine::Position>() as u32 }\n'+
    '#[no_mangle]\npub extern "C" fn research_undo_bytes() -> u32 { core::mem::size_of::<engine::Undo>() as u32 }\n');
  return {output,fixture};
}

function prepare(destination,hidden,implementation) {
  destination=Legacy.outsideRepository(destination);
  const registration=contract();
  const dependencies=DEPENDENCIES.map(p=>({path:path.relative(ROOT,p),sha256:sha(fs.readFileSync(p))}));
  const captured=Object.fromEntries(FILES.map(p=>[p,fs.readFileSync(path.join(ROOT,'experiments/wasm',p))]));
  const {output,fixture}=renderAll(captured,hidden,implementation);
  fs.mkdirSync(destination);fs.mkdirSync(path.join(destination,'src'));
  for(const filename of FILES)fs.writeFileSync(path.join(destination,filename),output[filename],{flag:'wx'});
  const receipt={schema:'chessy.nnue-incremental-build.v1',researchOnly:true,syntheticOnly:true,
    productionIntegrationAllowed:false,strengthClaimAllowed:false,hidden,implementation,
    contractSha256:registration.sha256,dependencies,fixtureSha256:sha(fixture.bytes),
    parameterBytes:fixture.bytes.length,parameterCount:fixture.metadata.parameters,
    baselineWasmSha256:sha(fs.readFileSync(path.join(ROOT,'assets/chessy-ai-fast.wasm'))),
    sourceInputs:FILES.map(p=>({path:p,sha256:sha(captured[p])})),
    emitted:FILES.map(p=>({path:p,sha256:sha(output[p]),bytes:output[p].length})),
    boardWritesAdapted:implementation==='incremental'?16:0,
    accumulatorPayloadBytes:implementation==='incremental'?8*hidden:0,
    candidateMemoryBytes:26607616,additionalMutableGlobalCache:false};
  for(const entry of dependencies)check(sha(fs.readFileSync(path.join(ROOT,entry.path)))===entry.sha256,'implementation changed during preparation');
  for(const entry of receipt.sourceInputs)check(sha(fs.readFileSync(path.join(ROOT,'experiments/wasm',entry.path)))===entry.sha256,'source changed during preparation');
  fs.writeFileSync(path.join(destination,'incremental-source.json'),encode(receipt),{flag:'wx'});
  return receipt;
}

function loadPrepared(directory) {
  const registration=contract(),receiptBytes=fs.readFileSync(path.join(directory,'incremental-source.json')),receipt=JSON.parse(receiptBytes);
  check(receipt.schema==='chessy.nnue-incremental-build.v1'&&receipt.syntheticOnly===true&&
    receipt.productionIntegrationAllowed===false&&receipt.strengthClaimAllowed===false&&receipt.contractSha256===registration.sha256,'frozen receipt differs');
  check(JSON.stringify(receipt.sourceInputs.map(x=>x.path))===JSON.stringify(FILES)&&
    JSON.stringify(receipt.emitted.map(x=>x.path))===JSON.stringify(FILES),'complete source inventory required');
  check(receipt.dependencies.length===DEPENDENCIES.length,'complete dependency closure required');
  receipt.dependencies.forEach((entry,index)=>check(entry.path===path.relative(ROOT,DEPENDENCIES[index])&&
    sha(fs.readFileSync(DEPENDENCIES[index]))===entry.sha256,'dependency identity differs'));
  const captured=Object.fromEntries(FILES.map(p=>[p,fs.readFileSync(path.join(ROOT,'experiments/wasm',p))]));
  const {output,fixture}=renderAll(captured,receipt.hidden,receipt.implementation);
  for(let i=0;i<FILES.length;i++) {
    const p=FILES[i];check(sha(captured[p])===receipt.sourceInputs[i].sha256,'baseline source differs');
    check(sha(output[p])===receipt.emitted[i].sha256&&output[p].length===receipt.emitted[i].bytes&&
      output[p].equals(fs.readFileSync(path.join(directory,p))),'copied source does not reproduce');
  }
  check(sha(fixture.bytes)===receipt.fixtureSha256,'synthetic fixture differs');
  const bytes=fs.readFileSync(path.join(directory,'dist/chessy-ai-fast.wasm'));
  const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{now_ms:()=>performance.now()}});
  const api=instance.exports,engine=Wasm.loadSync(bytes);
  check(engine.memoryBytes()===26607616,'fixed research memory differs');
  return {receipt,receiptSha256:sha(receiptBytes),bytes,engine,api,fixture,
    layout:{positionBytes:api.research_position_bytes(),undoBytes:api.research_undo_bytes(),
      accumulatorPayloadBytes:receipt.accumulatorPayloadBytes}};
}

function directEvaluate(api,fen) {
  const bytes=Buffer.from(fen);new Uint8Array(api.memory.buffer,api.input_ptr(),bytes.length).set(bytes);
  check(api.load_position(bytes.length)===0,'evaluation FEN rejected');
  for(let i=0;i<1000;i++)api.evaluate_loaded();
  const start=performance.now();let checksum=0;
  for(let i=0;i<10000;i++)checksum+=api.evaluate_loaded();
  return {elapsedMs:performance.now()-start,repetitions:10000,checksum};
}

function measureAll(directory,outputFile) {
  check(!fs.existsSync(outputFile),'result already exists');
  const registration=contract(),baselineBytes=fs.readFileSync(path.join(ROOT,'assets/chessy-ai-fast.wasm'));
  const baseline=Wasm.loadSync(baselineBytes);
  check(baseline.memoryBytes()===26542080,'production baseline memory changed');
  const baselineApi=new WebAssembly.Instance(new WebAssembly.Module(baselineBytes),{env:{now_ms:()=>performance.now()}}).exports;
  const prepared=[];
  for(const hidden of [4,8])for(const implementation of ['fused','incremental']) {
    const loaded=loadPrepared(path.join(directory,`h${hidden}-${implementation}`));
    check(loaded.receipt.hidden===hidden&&loaded.receipt.implementation===implementation&&
      loaded.receipt.baselineWasmSha256===sha(baselineBytes),'configuration/baseline mismatch');
    const parity=Legacy.PARITY_FENS.map(fen=>{
      const baselineCp=baseline.evaluate(fen),wanted=Ref.infer(loaded.fixture.model,fen,baselineCp),actual=loaded.engine.evaluate(fen);
      check(actual===wanted,'compiled static parity failed');return {fen,baselineCp,wanted,actual};
    });
    prepared.push({hidden,implementation,loaded,parity});
  }
  // Validate the entire built grid before collecting the first timing sample.
  const configurations=[];
  for(const {hidden,implementation,loaded,parity}of prepared) {
    const records=[];
    for(let repetition=0;repetition<4;repetition++)for(let position=0;position<8;position++) {
      const order=(repetition+position)%2?['candidate','baseline']:['baseline','candidate'];
      for(const name of order) {
        const fen=Legacy.FENS[position],candidate=name==='candidate';
        records.push({kind:'evaluation',name,position,repetition,...directEvaluate(candidate?loaded.api:baselineApi,fen)});
        for(const nodeLimit of [4096,16384]) {
          const started=performance.now();
          const result=(candidate?loaded.engine:baseline).search(fen,{maxDepth:111,nodeLimit,timeMs:0,quiesce:true});
          records.push({kind:'search',name,position,repetition,nodeLimit,elapsedMs:performance.now()-started,result});
        }
      }
    }
    check(loaded.engine.memoryBytes()===26607616,'memory grew');
    const ratios={};
    for(const [key,kind,budget]of[['evaluation','evaluation'],['search4096','search',4096],['search16384','search',16384]]) {
      const elapsed=[],nps=[];let complete=0;
      for(let pos=0;pos<8;pos++)for(let rep=0;rep<4;rep++) {
        const rows=records.filter(x=>x.kind===kind&&x.position===pos&&x.repetition===rep&&x.nodeLimit===budget);
        check(rows.length===2,'missing paired record');
        const b=rows.find(x=>x.name==='baseline'),c=rows.find(x=>x.name==='candidate');
        check(b.elapsedMs>0&&c.elapsedMs>0,'invalid timing');elapsed.push(c.elapsedMs/b.elapsedMs);
        if(kind==='search') {check(b.result.nodes>0&&c.result.nodes>0,'invalid node count');
          nps.push((c.result.nodes/c.elapsedMs)/(b.result.nodes/b.elapsedMs));
          complete+=Number(b.result.nodes===budget&&c.result.nodes===budget);}
      }
      ratios[key]={pairedMedianTimeRatio:Legacy.median(elapsed),pairs:32};
      if(kind==='search')Object.assign(ratios[key],{pairedMedianNpsRatio:Legacy.median(nps),bothConsumedNodeBudget:complete});
    }
    configurations.push({hidden,implementation,sourceReceiptSha256:loaded.receiptSha256,layout:loaded.layout,
      module:{sha256:sha(loaded.bytes),rawBytes:loaded.bytes.length,brotliBytes:zlib.brotliCompressSync(loaded.bytes,
        {params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}).length,memoryBytes:26607616},parity,records,ratios});
  }
  // Exactly the same synthetic evaluator must retain complete node-budget search
  // signatures across mechanisms, including nodes, qnodes, ordering and score.
  let validationError=null;
  try { for(const hidden of [4,8]) {
    const fused=configurations.find(x=>x.hidden===hidden&&x.implementation==='fused');
    const incremental=configurations.find(x=>x.hidden===hidden&&x.implementation==='incremental');
    const signatures=c=>c.records.filter(x=>x.kind==='search'&&x.name==='candidate').map(x=>x.result);
    check(JSON.stringify(signatures(fused))===JSON.stringify(signatures(incremental)),'incremental search semantics differ from concurrent fused control');
    check(incremental.layout.undoBytes===fused.layout.undoBytes,'Undo grew unexpectedly');
    incremental.layout.positionGrowthBytes=incremental.layout.positionBytes-fused.layout.positionBytes;
  }} catch(error) { validationError=error.message; }
  const report={schema:'chessy.nnue-incremental-cost.v1',status:validationError?'failed':'completed',researchOnly:true,syntheticOnly:true,
    productionIntegrationAllowed:false,strengthClaimAllowed:false,contractSha256:registration.sha256,
    runtime:{node:process.versions.node,v8:process.versions.v8,brotli:process.versions.brotli},
    baseline:{sha256:sha(baselineBytes),rawBytes:baselineBytes.length,memoryBytes:26542080},
    completeInventory:true,concurrentMechanismSearchParity:!validationError,validationError,configurations,
    limitations:['Synthetic mechanisms only; no trained weights, strength or device admission.',
      'Six of eight timing fixtures are endgames; report per-position data, not only the aggregate median.',
      'New full concurrent-control run; earlier results remain a distinct canonical experiment.']};
  fs.writeFileSync(outputFile,encode(report),{flag:'wx'});
  return {schema:report.schema,status:report.status,validationError,contractSha256:report.contractSha256,
    configurations:configurations.map(({hidden,implementation,layout,module,ratios})=>({hidden,implementation,layout,module,ratios}))};
}

module.exports={validateContract,patchEngine,renderAll,prepare,loadPrepared,measureAll};
if(require.main===module) {
  const [command,...args]=process.argv.slice(2);
  if(command==='prepare'&&args.length===3)console.log(encode(prepare(args[0],Number(args[1]),args[2])));
  else if(command==='measure-all'&&args.length===2) {const result=measureAll(...args);console.log(encode(result));if(result.status!=='completed')process.exitCode=1;}
  else throw Error('usage: nnue-incremental.js prepare OUTPUT HIDDEN fused|incremental; measure-all DIRECTORY REPORT.json');
}
