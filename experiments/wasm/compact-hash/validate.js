#!/usr/bin/env node
'use strict';
// Execute the retained verifier and historical Git inputs identified in its
// fresh correctness report; the original measured verifier remains archived.
if (typeof __compactValidation === 'undefined') {
  const fs = require('node:fs'), path = require('node:path');
  const files = [__filename, ...['prepare.js', 'paired-hash.rs.in', 'parity.rs.in', 'protocol.json'].map(p => path.join(__dirname,p))]
    .map(file => ({ file, bytes: Buffer.from(fs.readFileSync(file)) }));
  require('node:vm').compileFunction(files[0].bytes.toString().replace(/^#![^\n]*/, ''),
    ['require','module','exports','__filename','__dirname','__compactValidation'], { filename: __filename })
    (require,module,module.exports,__filename,__dirname,files);
} else {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const crypto = require('node:crypto'), assert = require('node:assert/strict');
  const { performance } = require('node:perf_hooks');
  const ROOT = path.resolve(__dirname, '../../..');
  const BASE = 'f65224dece688f23d00429c148715262dd3c9b79';
  const BASE_WASM = '57166b29d8887627f659c2a012216c9879f20084451fe343692034a5c5baec5f';
  const FIXTURE = 'd500dece3ed9bfc83da5139cabf075734c1f1f465f295f9c8be7be23eccc6b6b';
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const json = x => JSON.stringify(x,null,2)+'\n';
  const retained = __compactValidation;
  const get = suffix => retained.find(f => f.file.endsWith('/'+suffix)).bytes;
  const same = (a,b,label) => assert.equal(JSON.stringify(a),JSON.stringify(b),label);
  // Compile the captured helper directly, bypassing require.cache and any
  // subsequent pathname read. Its pinned Git inputs are retained in memory.
  const helper = {exports:{}};
  const recipe = ['prepare.js', 'paired-hash.rs.in', 'parity.rs.in'].map(name => ({
    name, file:path.join(__dirname,name), bytes:get(name)
  }));
  vm.compileFunction(get('prepare.js').toString().replace(/^#![^\n]*/, ''),
    ['require','module','exports','__filename','__dirname','__capturedCompactHash'], {filename:path.join(__dirname,'prepare.js')})
    (require,helper,helper.exports,path.join(__dirname,'prepare.js'),__dirname,recipe);

  function snapshot(directory, root = ROOT) {
    directory = fs.realpathSync(directory);
    const sourceBytes = fs.readFileSync(path.join(directory,'source.json')), source = JSON.parse(sourceBytes);
    assert.equal(source.schema,'chessy.compact-hash.source.v2');
    assert.equal(source.purpose,'historical-correctness-reproduction');
    assert.equal(source.baseCommit,BASE); assert.equal(source.variant,'threaded');
    assert.equal(source.researchOnly,true); assert.equal(source.productionIntegrationAllowed,false);
    assert.equal(source.strengthClaimAllowed,false);
    assert.deepEqual(source.recipe,recipe.map(r=>({path:r.name,sha256:sha(r.bytes)})),'recipe drift');
    const baseline = helper.exports.readBaseline(root);
    assert.deepEqual(source.source,Object.entries(baseline.source).map(([p,b])=>({path:p,sha256:sha(b)})),
      'baseline source drift');
    assert.deepEqual(source.baseline,Object.entries(baseline.runtime).map(([p,b])=>({path:p,sha256:sha(b)})),
      'baseline runtime drift');
    const inputs = [];
    assert.deepEqual(source.generated.map(e=>e.path),source.source.map(e=>e.path),'generated inventory drift');
    // The generated receipt cannot authenticate its own source. Derive every
    // expected file from the pinned baseline and the captured recipe, so a
    // coherent edit to both bytes and their declared digest still fails.
    const expectedGenerated = Object.entries(baseline.source).map(([p,b])=>({
      path:p, sha256:sha(p==='src/search.rs'
        ? Buffer.from(helper.exports.render(b.toString('utf8'),source.variant)) : b)
    }));
    assert.deepEqual(source.generated,expectedGenerated,'generated recipe output drift');
    for (const entry of source.generated) {
      const file = path.join(directory,entry.path), bytes = fs.readFileSync(file);
      assert.equal(sha(bytes),entry.sha256,'generated source drift: '+entry.path); inputs.push({file,bytes});
    }
    const candidateFile = path.join(directory,'dist/chessy-ai-fast.wasm');
    const modules = [
      {gitPath:'assets/chessy-ai-fast.wasm',bytes:baseline.runtime['assets/chessy-ai-fast.wasm']},
      {file:candidateFile,bytes:fs.readFileSync(candidateFile)}
    ];
    assert.equal(sha(modules[0].bytes),BASE_WASM);
    assert.equal(sha(baseline.runtime['test/fixtures/wasm-r69-signatures.json']),FIXTURE,'frozen fixture changed');
    return {directory,sourceBytes,source,baseline,inputs,modules};
  }
  function validate(directory, output) {
    const frozen = snapshot(directory);
    const {sourceBytes,source,baseline,inputs,modules} = frozen;
    directory = frozen.directory;
    const context = {WebAssembly,TextEncoder,performance,console,module:{exports:{}}};
    vm.createContext(context);
    vm.runInContext(baseline.runtime['assets/engine.js'].toString(),context,{filename:'retained-engine.js'});
    vm.runInContext(baseline.runtime['assets/wasm-engine.js'].toString(),context,{filename:'retained-wasm-engine.js'});
    const Chess=context.Chess, engines=modules.map(m=>context.module.exports.loadSync(m.bytes));
    engines.forEach(e=>assert.equal(e.memoryBytes(),26542080));
    const uci = m => m ? Chess.sqName(m.from)+Chess.sqName(m.to)+(m.promotion||'') : '-';
    const normalize = r => Object.fromEntries(Object.entries(r).map(([k,v]) => [k,k==='move'?uci(v):k==='pv'?v.map(uci):v]));
    const legal = (fen,moves) => {
      let state=Chess.newGameState(fen);
      for(const move of moves){const found=Chess.legalMoves(state).find(m=>uci(m)===uci(move));assert.ok(found,'illegal move/PV');state=Chess.applyMove(state,found);}
    };
    const fixture=JSON.parse(baseline.runtime['test/fixtures/wasm-r69-signatures.json']), protocol=JSON.parse(get('protocol.json'));
    assert.equal(fixture.cases.length,144);
    const positions=new Map(protocol.positions.map(p=>[p.name,p.fen])), rows=[];
    for(const item of fixture.cases){
      const fen=positions.get(item.name); assert.ok(fen,'missing frozen position');
      const pair=engines.map(e=>e.search(fen,item.config));
      for(const result of pair) same(Object.fromEntries(fixture.fields.map(k=>[k,k==='move'?uci(result.move):result[k]])),item.result,'immutable frozen signature');
      same(normalize(pair[0]),normalize(pair[1]),'complete ordinary result');
      let roots=null;
      if(pair[0].move){
        legal(fen,[pair[0].move]);
        roots=engines.map(e=>{e.beginAnalysis(fen,{nodeLimit:5000,quiesce:item.config.quiesce});const r=e.searchRoot(pair[0].move,Math.max(1,Math.min(3,pair[0].depth)),16);legal(fen,r.pv);return normalize(r);});
        same(roots[0],roots[1],'complete exact-root/PV result');
      }
      rows.push({name:item.name,config:item.config,result:normalize(pair[1]),root:roots&&roots[1]});
    }
    const historyRows=[];
    for(const count of [2,3]){
      const fen='4k1n1/8/8/8/8/8/8/4K1N1 w - - 8 5';
      const config={maxDepth:5,nodeLimit:10000,timeMs:0,quiesce:true,positions:{[fen]:count}};
      const pair=engines.map(e=>normalize(e.search(fen,config))); same(pair[0],pair[1],'history-sensitive search');
      historyRows.push({fen,count,result:pair[1]});
    }
    for(const record of [...retained,...inputs,modules[1],{file:path.join(directory,'source.json'),bytes:sourceBytes}])
      assert.equal(sha(fs.readFileSync(record.file)),sha(record.bytes),'input changed during verification');
    const report={schema:'chessy.compact-hash.validation.v2',purpose:'historical-correctness-reproduction',
      researchOnly:true,productionIntegrationAllowed:false,strengthClaimAllowed:false,
      complete:true,exactFiniteParity:true,universalEquivalenceProven:false,baseCommit:BASE,sourceReceipt:source,sourceReceiptSha256:sha(sourceBytes),
      implementation:retained.map(r=>({path:path.relative(ROOT,r.file),sha256:sha(r.bytes)})),baseline:source.baseline,
      modules:modules.map(m=>({sha256:sha(m.bytes),rawBytes:m.bytes.length,memoryBytes:26542080})),
      rawLimit:37172,rawGatePassed:modules[1].bytes.length<=37172,signatureCases:rows.length,historyCases:historyRows.length,rows,historyRows};
    fs.writeFileSync(output,json(report),{flag:'wx'}); return report;
  }
  module.exports={validate,snapshot};
  if(require.main===module){
    try{assert.equal(process.argv.length,4,'usage: node validate.js GENERATED_CRATE NEW_REPORT');const r=validate(...process.argv.slice(2));console.log(json({complete:r.complete,signatureCases:r.signatureCases,historyCases:r.historyCases,rawGatePassed:r.rawGatePassed}));}
    catch(error){console.error(error.stack||error);process.exitCode=1;}
  }
}
