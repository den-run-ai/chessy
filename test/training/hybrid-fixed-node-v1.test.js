'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path'),os=require('os'),cp=require('child_process');
const H=require('../../tools/training/hybrid-fixed-node-v1');
const Opening=require('../../tools/training/hybrid-match-v1');
const N=require('../../tools/training/natural-runtime-run');
const Chess=globalThis.Chess;
const protocol=JSON.parse(fs.readFileSync(require('path').join(__dirname,'../../eval/training/hybrid-fixed-node-v1.json')));
const copy=x=>JSON.parse(JSON.stringify(x));
function fixture(){
  const r={protocol:{...protocol,maxSearchedPlies:2},modules:{shipped:{sha256:'a'.repeat(64)},hybrid:{sha256:'b'.repeat(64)},expanded:{sha256:'c'.repeat(64)}}};
  const task=H.makeTasks(Opening.openings().slice(0,1),r.protocol)[0],rows=[];
  const engine={search(fen){const state=Chess.parseFen(fen),m=Chess.legalMoves(state)[0];return {move:{from:m.from,to:m.to,promotion:m.promotion||null},score:0,scorePov:'white',depth:2,
    attemptedDepth:3,nodes:16384,qnodes:10000,cutoffs:300,researches:0,stopReason:'node-limit'};}};
  H.playGame(task,{baseline:engine,candidate:engine},{baseline:r.modules.shipped,candidate:r.modules.hybrid},r.protocol,row=>{if(!row.control)rows.push(row);});
  return {r,task,rows};
}
test('one complete 100-opening color-paired fixed-node arm frozen before outcomes',()=>{
  const rows=Opening.openings(),tasks=H.makeTasks(rows,protocol);assert.equal(rows.length,100);assert.equal(tasks.length,200);
  assert.equal(new Set(tasks.map(t=>t.taskId)).size,200);
  for(const opening of rows)assert.deepEqual(tasks.filter(t=>t.opening.index===opening.index).map(t=>t.candidateColor).sort(),['b','w']);
  assert.deepEqual(tasks.slice(0,4).map(t=>t.candidateColor),['w','b','b','w']);
  assert(tasks.every(t=>t.nodeLimit===16384&&t.timeMs===0&&t.arm==='hybrid'));
  assert.equal(protocol.formalHoldoutAccessAllowed,false);assert.equal(protocol.formalPass,false);
});
test('legal game and genuine ply-cap termination independently replay',()=>{const f=fixture();const audited=H.auditGame(f.rows,f.task,f.r);assert.equal(audited.reason,'ply-cap');assert.equal(audited.searchedPlies,2);});
for(const [name,mutate] of [
  ['history omission',rows=>{rows[1].positions={};}],
  ['wrong evaluator',rows=>{rows[1].moduleSha256='d'.repeat(64);}],
  ['unequal search time',rows=>{rows[1].requested.timeMs=40;}],
  ['endpoint corruption',rows=>{rows[1].fenAfter=rows[1].fenBefore;}],
  ['counter inconsistency',rows=>{rows[1].result.qnodes=20000;}],
  ['unequal nodes',rows=>{rows[1].requested.nodeLimit=16385;}],
  ['node overrun',rows=>{rows[1].result.nodes=16385;}],
  ['under-budget false exhaustion',rows=>{rows[1].result.nodes=16383;}],
  ['time-limited node search',rows=>{rows[1].result.stopReason='time-limit';}],
  ['invented score',rows=>{rows.at(-1).candidateScore=1;}],
  ['premature termination',rows=>{rows.splice(2,1);}],
  ['extra move',rows=>{rows.splice(3,0,copy(rows[2]));}],
  ['missing end',rows=>{rows.pop();}],
  ['wrong opening color',rows=>{rows[0].candidateColor='b';}]
])test('audit rejects '+name,()=>{const f=fixture();mutate(f.rows);assert.throws(()=>H.auditGame(f.rows,f.task,f.r));});
test('canonical raw parser refuses truncated or duplicate-key evidence',()=>{
  assert.throws(()=>Opening.parseLines(Buffer.from('{"x":1}')));
  assert.throws(()=>Opening.parseLines(Buffer.from('{"x":1,"x":1}\n')));
  assert.deepEqual(Opening.parseLines(Buffer.from('{"x":1}\n')),[{x:1}]);
});
test('partial schedule cannot be scored',()=>{const f=fixture();const audited=H.auditGame(f.rows,f.task,f.r);
  f.r.tasks=H.makeTasks(Opening.openings(),protocol);f.r.openings=Opening.openings();assert.throws(()=>H.analyzeAudited([audited],f.r),/inventory/);});
test('CLI rejects duplicates and unknown parameters',()=>{
  assert.throws(()=>H.args(['run','--registration','x','--registration','y']));
  assert.throws(()=>H.args(['run','--time-ms','100']));
});

if(process.env.CHESSY_EXPORT_FIXED_NODE_FIXTURE)fs.writeFileSync(process.env.CHESSY_EXPORT_FIXED_NODE_FIXTURE,JSON.stringify(fixture()));

test('invalid search evidence is emitted before a hard failure',()=>{
 const rows=[],state=N.replay(Opening.openings()[0].prefixUci);
 const invalid={move:Chess.legalMoves(state)[0],nodes:16385};
 assert.throws(()=>H.timedSearch({search:()=>invalid},'candidate','b'.repeat(64),state,{maxDepth:30,nodeLimit:16384,timeMs:0,quiesce:true},row=>rows.push(row)));
 assert.equal(rows[1].schema,'chessy.hybrid-fixed-node-invalid-search.v1');assert.deepEqual(rows[1].rawResult,invalid);
});

test('retained execution rejects writable files/directories, aliases and changed bytes',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-retained-execution-'));
  const directory=path.join(root,'tools'),file=path.join(directory,'runner.js');
  fs.mkdirSync(directory);fs.writeFileSync(file,'frozen implementation');
  const registration={implementation:[{path:file,bytes:21,sha256:N.sha(Buffer.from('frozen implementation'))}]};
  try{
    fs.chmodSync(file,0o444);fs.chmodSync(directory,0o555);fs.chmodSync(root,0o555);
    H.requireRetainedExecution(root,[file],registration);
    fs.chmodSync(file,0o644);
    assert.throws(()=>H.requireRetainedExecution(root,[file],registration),/read-only regular/);
    fs.chmodSync(file,0o444);fs.chmodSync(directory,0o755);
    assert.throws(()=>H.requireRetainedExecution(root,[file],registration),/directories must be read-only/);
    fs.chmodSync(directory,0o555);fs.chmodSync(root,0o755);
    assert.throws(()=>H.requireRetainedExecution(root,[file],registration),/directories must be read-only/);
    const alias=path.join(root,'alias.js');fs.symlinkSync(file,alias);fs.chmodSync(root,0o555);
    assert.throws(()=>H.requireRetainedExecution(root,[alias]),/without symlinks/);
    assert.throws(()=>H.requireRetainedExecution(root,[file],{implementation:[{...registration.implementation[0],path:alias}]}),/implementation paths/);
    fs.chmodSync(file,0o644);fs.writeFileSync(file,'changed implementation');fs.chmodSync(file,0o444);
    assert.throws(()=>H.requireRetainedExecution(root,[file],registration),/SHA|sha|hash|snapshot|identity/i);
  }finally{
    fs.chmodSync(root,0o755);fs.chmodSync(directory,0o755);fs.rmSync(root,{recursive:true,force:true});
  }
});

for(const [name,receipt,digest] of [
  ['hybrid-fixed-node-v1','hybrid-fixed-node','b3e3f5be084f325da2a4bdb263f1c20cc415f5516dc010cd1565685e3d017962'],
  ['hybrid-equal-time-200ms-v1','hybrid-equal-time-200ms','0025243225792e557b6d57f4bde7064248ef4b8550f2664b6e2ea2f9885b8ba6']]){
  const root=path.resolve(__dirname,'../..'),entry=path.join(root,'tools/training/'+name+'.js');
  test(name+' preserves exact measured source and retires the registration API before arguments',()=>{
    assert.equal(N.sha(fs.readFileSync(path.join(root,'tools/training/'+name+'.executed.js.txt'))),digest);
    const poisoned=new Proxy({},{get(){throw Error('must not read arguments');}});
    assert.throws(()=>require(entry).register(poisoned),/completed diagnostic recipe is retired/);
  });
  test(name+' refuses original and copied producer CLI paths without a ledger',()=>{
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-retired-cli-'));
    const copied=path.join(temporary,'copy'),output=path.join(temporary,'output');fs.mkdirSync(output);
    try{
      const inventory=JSON.parse(fs.readFileSync(path.join(root,'eval/training/'+receipt+'-execution-snapshot-2026-09.json'))).files;
      for(const item of inventory){const target=path.join(copied,item.relativePath);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,item.relativePath),target);}
      const copiedEntry=path.join(copied,'tools/training/'+name+'.js');
      for(const file of [entry,copiedEntry])for(const command of ['register','run','--internal-child']){
        const result=cp.spawnSync(process.execPath,[file,command],{encoding:'utf8',cwd:output});
        assert.equal(result.status,1);assert.match(result.stderr,/completed diagnostic recipe is retired/);
        assert.deepEqual(fs.readdirSync(output),[]);
      }
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  });
}
