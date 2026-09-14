#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../../tools/training/natural-runtime-run');
const Chess = globalThis.Chess;
let checks = 0;
function test(name, run) { run(); checks++; console.log('ok ' + name); }
function result(move, overrides) { return { move, score: 0, scorePov: 'white', depth: 1, attemptedDepth: 2,
  nodes: 100, qnodes: 50, cutoffs: 2, researches: 0, stopReason: 'time-limit', ...overrides }; }
const modules = { baseline: { sha256: 'a'.repeat(64) }, candidate: { sha256: 'b'.repeat(64) } };
const config = { maxSearchedPlies: 180, maxDepth: 30, quiesce: true };
function fakeEngines(moves, calls) {
  let serial = 0;
  const engine = { search(fen, request) {
    const state = Chess.newGameState(fen), uci = moves[serial++];
    const move = Chess.legalMoves(state).find(m => Chess.sqName(m.from)+Chess.sqName(m.to)+(m.promotion||'').toLowerCase() === uci);
    assert(move, 'synthetic fixture move is legal'); calls.push({ fen, request }); return result(move);
  } };
  return { baseline: engine, candidate: engine };
}
function task(prefix, candidateColor='w') { return { taskId: 'fixture', timeMs: 50, candidateColor,
  opening: { index: 0, name: 'synthetic fixture', prefixUci: prefix, fen: Chess.toFen(R.replay(prefix)) } }; }

test('full opening repetition reaches current threefold without extra search', () => {
  const records=[],calls=[];
  const outcome=R.playGame(task(['g1f3','g8f6','f3g1','f6g8']),fakeEngines(['g1f3','g8f6','f3g1','f6g8'],calls),modules,config,r=>records.push(r));
  assert.strictEqual(outcome.reason,'threefold repetition'); assert.strictEqual(outcome.searchedPlies,4);
  const key=Chess.positionKey(Chess.newGameState()); assert.strictEqual(calls[0].request.positions[key],2);
  const moves=records.filter(r=>r.schema==='chessy.natural-runtime-move.v1');
  assert.strictEqual(moves.length,4); assert.strictEqual(moves[0].moduleId,'candidate');
  assert.deepStrictEqual(moves[0].positions,calls[0].request.positions); assert.strictEqual(moves[0].requested.timeMs,50);
});
test('terminal checkmate at searched-ply cap outranks diagnostic draw',()=>{
  const records=[],calls=[];
  const out=R.playGame(task(['f2f3','e7e5','g2g4'],'b'),fakeEngines(['d8h4'],calls),modules,{...config,maxSearchedPlies:1},r=>records.push(r));
  assert.strictEqual(out.reason,'checkmate'); assert.strictEqual(out.result,'0-1'); assert.strictEqual(out.candidateScore,1);
});
test('nonterminal searched-ply cap is explicitly retained',()=>{
  const out=R.playGame(task([]),fakeEngines(['e2e4','e7e5'],[]),modules,{...config,maxSearchedPlies:2},()=>{});
  assert.strictEqual(out.reason,'ply-cap'); assert.strictEqual(out.searchedPlies,2); assert.strictEqual(out.candidateScore,.5);
});
test('incoherent node and search-stop telemetry fails closed',()=>{
  const move=Chess.legalMoves(Chess.newGameState())[0];
  assert.throws(()=>R.validateSearchResult(result(move,{nodes:10001,stopReason:'node-limit'}),30,{nodeLimit:10000}),/budget/);
  assert.throws(()=>R.validateSearchResult(result(move,{qnodes:101}),30,{timeMs:50}),/incoherent/);
  assert.throws(()=>R.validateSearchResult(result(move,{stopReason:'game-over'}),30,{timeMs:50}),/stop reason/);
  assert.throws(()=>R.validateSearchResult(result(move,{stopReason:'mate',score:0,attemptedDepth:null}),30,{timeMs:50}),/mate/);
  assert.throws(()=>R.validateSearchResult(result(move,{attemptedDepth:9}),30,{timeMs:50}),/incoherent/);
  assert.throws(()=>R.validateSearchResult(result(move,{cutoffs:999}),30,{timeMs:50}),/cutoff/);
});
test('benchmark warmup pairs are excluded and each budget gate enforced',()=>{
  const spec={positions:2,measuredPairsPerPositionBudget:3,nodeBudgets:[10000,100000],minimumMedianPairedNpsRatio:.95,minimumAggregateNpsRatio:.95};
  const rows=[];
  for(const budget of spec.nodeBudgets)for(let position=0;position<2;position++)for(let repeat=0;repeat<4;repeat++)for(const moduleId of ['baseline','candidate']){
    rows.push({positionId:'p'+position,repeat,warmup:repeat===0,moduleId,requested:{nodeLimit:budget},result:{nodes:budget},elapsedMs:repeat===0?100:(moduleId==='candidate'&&budget===100000?11:10)});
  }
  const analysis=R.benchAnalysis(rows,spec); assert.strictEqual(analysis.byBudget[10000].pass,true);
  assert.strictEqual(analysis.byBudget[100000].pass,false); assert.strictEqual(analysis.costGatePassed,false);
  assert(Math.abs(analysis.byBudget[100000].medianPairedNpsRatio-10/11)<1e-12);
  assert.throws(()=>R.benchAnalysis(rows.filter(r=>!(r.repeat===1&&r.positionId==='p0'&&r.moduleId==='candidate')),spec),/incomplete/);
});
test('raw benchmark evidence requires all registered cells including warmups',()=>{
  const spec={positions:1,maxDepth:30,quiesce:true,nodeBudgets:[10000,100000],warmupPairsPerPositionBudget:1,measuredPairsPerPositionBudget:3};
  const registration={benchPositions:[{id:'synthetic',phase:'opening',fen:Chess.START_FEN,prefixUci:[]}]};
  const fake={search(fen,request){return result(Chess.legalMoves(Chess.newGameState(fen))[0],{nodes:request.nodeLimit,stopReason:'node-limit'});}};
  const records=[];R.runBench(registration,{baseline:fake,candidate:fake},modules,spec,row=>{if(!row.control)records.push(row);});
  R.validateBenchInventory(records,registration,spec,modules);assert.strictEqual(records.length,16);
  for(const mutation of [{positionId:'unregistered'},{repeat:999},{moduleSha256:'0'.repeat(64)}]){
    const changed=records.map(row=>({...row}));changed[1]={...changed[1],...mutation};assert.throws(()=>R.validateBenchInventory(changed,registration,spec,modules),/registration/);
  }
  assert.throws(()=>R.validateBenchInventory(records.filter(row=>!row.warmup),registration,spec,modules),/registration/);
});
test('paired game dispatch order is fixed and covers both colors per budget',()=>{
  const registration={openings:R.expectedOpeningIndices().map(index=>({index}))};
  const tasks=R.makeTasks(registration,{matches:{timeBudgetsMs:[50,200]}});
  assert.strictEqual(tasks.length,80); assert.strictEqual(new Set(tasks.map(t=>t.taskId)).size,80);
  assert.strictEqual(tasks[0].candidateColor,'w');assert.strictEqual(tasks[1].candidateColor,'b');
  assert.strictEqual(tasks[0].opening.index,tasks[1].opening.index);assert.strictEqual(tasks[40].timeMs,200);
});
test('module receipt cannot omit parity or size gates',()=>{
  const c={candidate:{weightsSha256:'c'.repeat(64),frozenSelectionSha256:'e'.repeat(64),testReportSha256:'f'.repeat(64)},toolchain:{node:process.versions.node,brotli:process.versions.brotli},baseline:{wasmSha256:'a'.repeat(64),rawBytes:37172},parity:{minimumNaturalRows:42498},privateSizeGate:{maximumRawBytes:37915,maximumBrotliBytes:18043}};
  const receipt={schema:'chessy.natural-runtime-build-parity.v1',status:'PASS',researchOnly:true,productionIntegrationAllowed:false,shippingOrEloClaimAllowed:false,contractSha256:'d'.repeat(64),frozenSelectionSha256:c.candidate.frozenSelectionSha256,testReportSha256:c.candidate.testReportSha256,runtime:c.toolchain,weightsSha256:c.candidate.weightsSha256,gates:{baselineRebuildByteIdentical:true,parityRows:42498,parityMismatches:0,authoredFixtureRows:1,authoredFixtureMismatches:0,sizePass:true},
    modules:{baseline:{sha256:'a'.repeat(64),rawBytes:37172},candidate:{sha256:'b'.repeat(64),rawBytes:37900,brotliBytes:18000}}};
  R.validateReceipt(receipt,c,'d'.repeat(64));
  for(const mutation of [{schema:'wrong'},{contractSha256:'0'.repeat(64)},{testReportSha256:'0'.repeat(64)},{gates:{...receipt.gates,authoredFixtureRows:0,authoredFixtureMismatches:99}}])assert.throws(()=>R.validateReceipt({...receipt,...mutation},c,'d'.repeat(64)));
  assert.throws(()=>R.validateReceipt({...receipt,gates:{...receipt.gates,parityMismatches:1}},c,'d'.repeat(64)),/gates/);
  assert.throws(()=>R.validateReceipt({...receipt,modules:{...receipt.modules,candidate:{...receipt.modules.candidate,rawBytes:37916}}},c,'d'.repeat(64)),/size gate/);
});
test('persisted output identity and no-replace rules catch pathname replacement',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'natural-runtime-writer-'));
  try { const file=path.join(directory,'records.jsonl'),writer=new R.Writer(file);writer.append({first:true});
    fs.unlinkSync(file);fs.writeFileSync(file,'replacement\n');
    assert.throws(()=>writer.append({second:true}),/identity changed/);const observed=R.closeObserved(writer);assert.strictEqual(observed.status,'invalid');assert.strictEqual(observed.sha256,R.sha('replacement\n'));
    assert.throws(()=>new R.Writer(file),/EEXIST/);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
console.log(checks+' private runtime runner tests passed; all searches were synthetic fakes');
