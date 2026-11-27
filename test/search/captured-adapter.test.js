'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const os=require('node:os'),{spawnSync}=require('node:child_process');
const {createAdapter}=require('../../tools/search/captured-adapter');
const root=path.resolve(__dirname,'../..');
const fixture={path:path.join(root,'test/fixtures/wasm-r69-signatures.json'),bytes:fs.readFileSync(path.join(root,'test/fixtures/wasm-r69-signatures.json'))};
const source=text=>({path:path.join(root,'experiments/wasm/bench.js'),bytes:Buffer.from(text)});
const wrap=text=>'module.exports={POSITIONS:[["synthetic","retained"]]};\n'+text;

// Every indirect import route previously available through unrestricted
// built-ins fails inside the adapter realm, including in another Node process.
const blocked=[
  "require('module').createRequire(__filename)('./unretained')",
  "require('node:module').createRequire(__filename)('./unretained')",
  "require('fs/promises').readFile(__filename)",
  "require('child_process')", "require('node:vm')", "require('worker_threads')",
  "require('process')", "require('./unretained')", "process.getBuiltinModule('fs')",
  "process.mainModule.require('fs')", "process.env.UNRECORDED", "process.binding('fs')",
  "require('fs').readFileSync(__filename,'utf8')",
  "globalThis.constructor.constructor('return process')().getBuiltinModule('fs').readFileSync(__filename,'utf8')",
  "require.constructor('return process')()",
  "require('path').join.constructor('return process')()",
  "require('perf_hooks').performance.now.constructor('return process')()",
  "process.hrtime.bigint.constructor('return process')()",
  "TextEncoder.constructor('return process')()",
  "new TextEncoder().encode('x').constructor.constructor('return process')()",
  "module.constructor.constructor('return process')()",
  "try {require('path').join({});} catch(error) {error.constructor.constructor('return process')();}",
  "globalThis.__capturedBridge('path.resolve','[]')"
];
for(const code of blocked)assert.throws(()=>createAdapter(source(wrap(code)),fixture),undefined,code);
assert.equal(globalThis.__capturedBridge,undefined);

// A substituted dispatcher Proxy must never be called from the host: its apply
// trap would otherwise receive a host arguments array. The original dispatcher
// is captured and its global removed before evaluating this adapter.
const replaced=createAdapter(source(wrap(`
  globalThis.__adapterDispatch=new Proxy(function(){},{apply(target,self,args){
    const hostProcess=args.constructor.constructor('return process')();
    return JSON.stringify({value:{POSITIONS:[['host dispatcher leaked',hostProcess.version]]}});
  }});
`)),fixture);
assert.deepEqual(replaced.POSITIONS,[['synthetic','retained']]);

// The original review crossed registration/execution process boundaries with
// a replaced helper. Both independent processes reject that import route even
// though the unrecorded helper exists and changes between invocations.
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'captured-adapter-process-'));
try{
  const helper=path.join(temporary,'unretained.js');
  const probe=`const assert=require('node:assert/strict');
    const {createAdapter}=require(${JSON.stringify(path.join(root,'tools/search/captured-adapter.js'))});
    assert.throws(()=>createAdapter({path:${JSON.stringify(path.join(temporary,'bench.js'))},
      bytes:Buffer.from(${JSON.stringify("module.exports=require('module').createRequire(__filename)("+JSON.stringify(helper)+");")})},
      {path:'retained.json',bytes:Buffer.from('{}')}),/only captured adapter built-ins/);`;
  for(const label of ['registration','execution']){
    fs.writeFileSync(helper,'module.exports={POSITIONS:[['+JSON.stringify(label)+',"changed input"]]};');
    const child=spawnSync(process.execPath,['-e',probe],{encoding:'utf8',timeout:5000});
    assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'');
  }
}finally{fs.rmSync(temporary,{recursive:true,force:true});}

(async()=>{
  // Both incoming byte arrays and search options are created in the adapter's
  // realm. A leaked host Buffer/object would make these constructor escapes work.
  const isolated=createAdapter(source(`module.exports={POSITIONS:[],async loadOrdinaryWasmBytes(bytes){
    try {bytes.constructor.constructor('return process')();throw Error('host bytes leaked');}
    catch(error){if(error.message==='host bytes leaked')throw error;}
    return {binaryBytes:bytes.byteLength,brotliBytes:1,memoryBytes:()=>1,search(fen,options){
      try {options.constructor.constructor('return process')();throw Error('host options leaked');}
      catch(error){if(error.message==='host options leaked')throw error;}
      options.nodeLimit=999;return {move:'a2a3',fen,nodes:1};
    }};
  }};`),fixture);
  const incoming=Buffer.from([1,2,3]),options={nodeLimit:1};
  const engine=await isolated.loadOrdinaryWasmBytes(incoming,'synthetic','synthetic.wasm');
  assert.equal(engine.binaryBytes,3);assert.deepEqual(engine.search('retained',options),{move:'a2a3',fen:'retained',nodes:1});
  assert.equal(options.nodeLimit,1);assert.deepEqual([...incoming],[1,2,3]);
  // Actual adapter compatibility: retained fixture, UTF-8, Brotli and WASM
  // imports are exercised by loading the module. No chess search is run.
  const actual=createAdapter({path:path.join(root,'experiments/wasm/bench.js'),bytes:fs.readFileSync(path.join(root,'experiments/wasm/bench.js'))},fixture);
  const moduleBytes=fs.readFileSync(path.join(root,'assets/chessy-ai-fast.wasm'));
  const loaded=await actual.loadOrdinaryWasmBytes(moduleBytes,'compatibility','retained.wasm');
  assert.equal(actual.POSITIONS.length,18);assert.equal(loaded.binaryBytes,moduleBytes.length);
  assert(loaded.brotliBytes>0);assert.equal(loaded.memoryBytes(),26542080);
  console.log('Captured adapter strict imports, host/constructor isolation and actual WASM loading PASS (no search)');
})().catch(error=>{console.error(error);process.exitCode=1;});
