#!/usr/bin/env node
'use strict';
// Separate counts-only observer; no existing experiment or production file is edited.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),vm=require('node:vm');
const {fork}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(v,m)=>{if(!v)throw Error(m);};
const encode=x=>JSON.stringify(x,null,2)+'\n';
const once=(s,a,b)=>{check(s.split(a).length===2,'missing/ambiguous anchor');return s.replace(a,b);};
const ARCHIVE_SHA='05f6d2059ff492c364d6e28965b165c2b783df7199735b9809713e85e751b516';
const ORIGINAL_SHA='18c69302d9aaecc0078a5b398e68789f24adb66e525c99f8bc9ac9ddc60e9493';
const ORIGINAL_SOURCE_SHA='1095afc9bc9d6155cd8ffbffc8173a22ee88cf0df8f3c8329ebe6c0a3742b48d';
const SALT='chessy.hybrid-eval-counts.v1|2026-09-15';
const OPTIONS=Object.freeze({maxDepth:30,nodeLimit:16384,timeMs:0,quiesce:true});
const sameOptions=o=>o&&Object.keys(o).length===4&&Object.entries(OPTIONS).every(([k,v])=>o[k]===v);
const DEPS=['tools/training/hybrid-eval-counts.js','tools/training/hybrid-eval-counts.rs.in','assets/wasm-engine.js','eval/hybrid-eval-counts-v1/PLAN.md'];
const SOURCE_FILES=['Cargo.toml','Cargo.lock','rust-toolchain.toml','build.sh','src/engine.rs','src/eval.rs','src/lib.rs','src/search.rs'];
const captureDeps=()=>Object.fromEntries(DEPS.map(p=>[p,fs.readFileSync(path.join(ROOT,p))]));
const digestFiles=(buffers=captureDeps())=>DEPS.map(p=>({path:p,sha256:sha(buffers[p])}));
function authenticated(p,digest){const b=fs.readFileSync(p);check(sha(b)===digest,'identity changed: '+p);return b;}
function instrument(files,template){
  return {...files,'src/eval.rs':Buffer.from(once(files['src/eval.rs'].toString(),'    let phase = hybrid_phase(position);\n    if phase <= HYBRID_LOW','    let phase = hybrid_phase(position);\n    unsafe { profile_observe(phase); }\n    if phase <= HYBRID_LOW')+'\n'+template)};
}
function verifySource(directory,s,dependencies){
  const originalSource=JSON.parse(authenticated(path.join(directory,'original-source.json'),ORIGINAL_SOURCE_SHA));
  const entry=originalSource.emitted.find(x=>x.variant==='hybrid');
  check(entry&&JSON.stringify(entry.files.map(f=>f.path))===JSON.stringify(SOURCE_FILES),'original source inventory');
  check(JSON.stringify(s.source)===JSON.stringify(entry.files),'declared original source differs from authenticated receipt');
  const original=Object.fromEntries(entry.files.map(f=>[f.path,authenticated(path.join(directory,'original-src',f.path),f.sha256)]));
  const expected=instrument(original,dependencies['tools/training/hybrid-eval-counts.rs.in']);
  const inventory=Object.entries(expected).map(([p,b])=>({path:p,sha256:sha(b)}));
  check(JSON.stringify(s.generated)===JSON.stringify(inventory),'observer must be exactly the sole counter transform');
  for(const f of inventory)authenticated(path.join(directory,'observer',f.path),f.sha256);
}
function select(archiveBytes){
  check(sha(archiveBytes)===ARCHIVE_SHA,'wrong fixed-node archive');
  const archive=JSON.parse(archiveBytes);check(archive.schema==='chessy.hybrid-retained-game-archive.v1'&&archive.compressionAfterTimedSearches===true&&archive.entries.length===201,'archive inventory');
  const candidates=[],names=new Set(),ids=new Set();let games=0;
  for(const e of archive.entries){
    check(!names.has(e.path),'duplicate member');names.add(e.path);
    const raw=zlib.gunzipSync(Buffer.from(e.gzipBase64,'base64'));
    check(raw.length===e.bytes&&sha(raw)===e.sha256&&raw.at(-1)===10,'member bytes');
    const lines=raw.toString().trimEnd().split('\n');check(lines.length===e.rows,'member rows');
    if(e.path==='warmup.jsonl')continue;
    games++;const header=JSON.parse(lines[0]),last=JSON.parse(lines.at(-1));
    check(header.schema==='chessy.natural-runtime-game-header.v1'&&last.schema==='chessy.natural-runtime-game-result.v1','complete game required');
    for(let i=1;i<lines.length-1;i++){
      const row=JSON.parse(lines[i]);check(row.schema==='chessy.natural-runtime-move.v1'&&row.taskId===header.taskId&&row.ply===i-1,'move inventory');
      check(sameOptions(row.requested),'unexpected archived request');
      const id=row.taskId+'|'+row.ply;check(!ids.has(id),'duplicate move');ids.add(id);
      candidates.push({taskId:row.taskId,ply:row.ply,selectionDigest:sha(SALT+'|'+id),member:e.path,memberSha256:e.sha256,rowSha256:sha(lines[i]+'\n'),archivedModuleSha256:row.moduleSha256,archivedModuleId:row.moduleId,fen:row.fenBefore,positions:row.positions,requested:row.requested,archivedResult:row.result});
    }
  }
  check(games===200&&candidates.length===24467&&names.has('warmup.jsonl'),'complete source moves required');
  candidates.sort((a,b)=>a.selectionDigest.localeCompare(b.selectionDigest)||a.taskId.localeCompare(b.taskId)||a.ply-b.ply);
  return candidates.slice(0,24);
}
function prepare(destination,archivePath,originalDirectory){
  destination=path.resolve(destination);check(!fs.existsSync(destination)&&!destination.startsWith(ROOT+path.sep),'new private output outside checkout required');
  const retained=captureDeps(),dependencies=digestFiles(retained),archiveBytes=authenticated(archivePath,ARCHIVE_SHA);
  const sourceBytes=authenticated(path.join(originalDirectory,'../hybrid-source.json'),ORIGINAL_SOURCE_SHA),source=JSON.parse(sourceBytes);
  const entry=source.emitted.find(x=>x.variant==='hybrid');check(entry&&source.config.id==='smooth-6-12','original hybrid source required');
  check(JSON.stringify(entry.files.map(f=>f.path))===JSON.stringify(SOURCE_FILES),'original source inventory');
  const files=Object.fromEntries(entry.files.map(f=>[f.path,authenticated(path.join(originalDirectory,f.path),f.sha256)]));
  const original=authenticated(path.join(originalDirectory,'dist/chessy-ai-fast.wasm'),ORIGINAL_SHA);
  const observer=instrument(files,retained['tools/training/hybrid-eval-counts.rs.in']);
  check(JSON.stringify(dependencies)===JSON.stringify(digestFiles()),'dependency changed during preparation');
  const selected=select(archiveBytes);
  fs.mkdirSync(destination);fs.mkdirSync(path.join(destination,'observer'));fs.mkdirSync(path.join(destination,'observer/src'));
  fs.mkdirSync(path.join(destination,'original-src'));fs.mkdirSync(path.join(destination,'original-src/src'));
  for(const [p,b]of Object.entries(files))fs.writeFileSync(path.join(destination,'original-src',p),b,{flag:'wx'});
  for(const [p,b]of Object.entries(observer))fs.writeFileSync(path.join(destination,'observer',p),b,{flag:'wx'});
  fs.writeFileSync(path.join(destination,'original.wasm'),original,{flag:'wx'});
  fs.writeFileSync(path.join(destination,'original-source.json'),sourceBytes,{flag:'wx'});
  const plan={schema:'chessy.hybrid-eval-counts.source.v1',researchOnly:true,wallTimeSharesAllowed:false,productionIntegrationAllowed:false,selectionSalt:SALT,sourceArchiveSha256:ARCHIVE_SHA,sourceArchivePath:path.resolve(archivePath),sourceMoves:24467,selectedCount:24,totalSearches:48,totalRequestedNodes:786432,watchdogMs:60000,options:OPTIONS,originalSha256:ORIGINAL_SHA,originalSourceSha256:sha(sourceBytes),dependencies,source:entry.files,generated:Object.entries(observer).map(([p,b])=>({path:p,sha256:sha(b)})),selected};
  fs.writeFileSync(path.join(destination,'source.json'),encode(plan),{flag:'wx'});return plan;
}
function register(directory){
  const retained=captureDeps(),sourceBytes=fs.readFileSync(path.join(directory,'source.json')),source=JSON.parse(sourceBytes);
  check(JSON.stringify(source.dependencies)===JSON.stringify(digestFiles(retained)),'source dependencies changed');
  verifySource(directory,source,retained);
  authenticated(path.join(directory,'original.wasm'),ORIGINAL_SHA);
  const observer=fs.readFileSync(path.join(directory,'observer/dist/chessy-ai-fast.wasm'));
  const registration={schema:'chessy.hybrid-eval-counts.registration.v1',sourceSha256:sha(sourceBytes),observerSha256:sha(observer),originalSha256:ORIGINAL_SHA,node:process.version,versions:process.versions,dependencies:digestFiles(retained)};
  fs.writeFileSync(path.join(directory,'registration.json'),encode(registration),{flag:'wx'});return registration;
}
function preflight(directory){
  const retained=captureDeps();
  const registrationBytes=fs.readFileSync(path.join(directory,'registration.json')),r=JSON.parse(registrationBytes);
  check(r.schema==='chessy.hybrid-eval-counts.registration.v1'&&r.node===process.version&&JSON.stringify(r.versions)===JSON.stringify(process.versions),'runtime identity');
  check(JSON.stringify(r.dependencies)===JSON.stringify(digestFiles(retained)),'executing dependencies changed');
  const sourceBytes=authenticated(path.join(directory,'source.json'),r.sourceSha256),s=JSON.parse(sourceBytes);
  check(s.schema==='chessy.hybrid-eval-counts.source.v1'&&s.researchOnly===true&&s.wallTimeSharesAllowed===false&&s.productionIntegrationAllowed===false,'source schema');
  check(s.selected.length===24&&s.totalSearches===48&&s.totalRequestedNodes===786432&&s.watchdogMs===60000&&sameOptions(s.options)&&s.selectionSalt===SALT&&s.sourceMoves===24467&&s.sourceArchiveSha256===ARCHIVE_SHA&&s.originalSourceSha256===ORIGINAL_SOURCE_SHA,'frozen workload');
  check(JSON.stringify(s.selected)===JSON.stringify(select(authenticated(s.sourceArchivePath,ARCHIVE_SHA))),'selected replay rows changed');
  check(JSON.stringify(s.dependencies)===JSON.stringify(r.dependencies),'source dependency identity');
  verifySource(directory,s,retained);
  return {r,s,registrationSha256:sha(registrationBytes),loaderBytes:retained['assets/wasm-engine.js'],original:authenticated(path.join(directory,'original.wasm'),ORIGINAL_SHA),observer:authenticated(path.join(directory,'observer/dist/chessy-ai-fast.wasm'),r.observerSha256)};
}
function load(bytes,loaderBytes){
  // Expose only the existing wrapper to this research harness. Its FEN/history,
  // request validation and result decoding are unchanged; no source file is edited.
  const source=loaderBytes.toString();
  const adapted=once(source,'    loadSync: loadSync,','    wrapInstance: wrap,\n    loadSync: loadSync,');
  const scope={module:{exports:{}},WebAssembly,TextEncoder,performance};vm.runInNewContext(adapted,scope);
  const api=new WebAssembly.Instance(new WebAssembly.Module(bytes),{env:{now_ms:()=>performance.now()}}).exports;
  return {api,engine:scope.module.exports.wrapInstance({exports:api})};
}
const fields=['move','score','scorePov','depth','attemptedDepth','nodes','qnodes','cutoffs','researches','stopReason'];
const signature=r=>fields.map(k=>k==='move'?(r.move?[r.move.from,r.move.to,r.move.promotion??null]:null):r[k]);
function validateRows(rows,selected){
  check(rows.length===48,'complete 48-row inventory required');
  const total=Array(25).fill(0);
  for(let i=0;i<24;i++){
    const pair={};
    for(let offset=0;offset<2;offset++){
      const row=rows[2*i+offset],arm=(i+offset)%2===0?'original':'observer';
      check(row.index===i&&row.taskId===selected[i].taskId&&row.ply===selected[i].ply&&row.arm===arm,'row identity/order');pair[arm]=row;
      check(!row.invalid&&!row.countsError&&row.result&&fields.every(k=>Object.hasOwn(row.result,k)),'complete valid result fields required');
      check(['score','depth','nodes','qnodes','cutoffs','researches'].every(k=>Number.isSafeInteger(row.result[k]))&&row.result.scorePov==='white','result field types');
      check(row.result.attemptedDepth===null||Number.isSafeInteger(row.result.attemptedDepth),'attempted depth');
      check(['max-depth','node-limit','mate','game-over'].includes(row.result.stopReason),'unexpected stop reason');
      check(row.result.stopReason!=='node-limit'||row.result.nodes===16384,'early node-limit stop');
      check(row.result.nodes<=16384&&row.result.nodes>=0,'node budget');
      if(arm==='observer'){
        check(Array.isArray(row.counts)&&row.counts.length===25&&row.counts.every(x=>Number.isSafeInteger(x)&&x>=0),'phase counter range');
        check(row.counts.reduce((a,b)=>a+b,0)<=row.result.nodes,'more evaluations than visited nodes');
        row.counts.forEach((n,p)=>{total[p]+=n;});
      }else check(row.counts===null,'original must have no observer counts');
    }
    check(JSON.stringify(signature(pair.original.result))===JSON.stringify(signature(pair.observer.result)),'observer/original mismatch');
    if(selected[i].archivedModuleSha256===ORIGINAL_SHA)check(JSON.stringify(signature(pair.original.result))===JSON.stringify(signature(selected[i].archivedResult)),'archived hybrid mismatch');
  }
  return {phaseCounts:total,expandedOnly:total.slice(0,7).reduce((a,b)=>a+b,0),blend:total.slice(7,12).reduce((a,b)=>a+b,0),neuralOnly:total.slice(12).reduce((a,b)=>a+b,0)};
}
async function child(directory){
  check(typeof process.send==='function'&&process.connected,'child requires parent IPC before any engine load');
  const ledger=JSON.parse(fs.readFileSync(path.join(directory,'started.json')));
  check(ledger.parentPid===process.ppid&&ledger.token===process.env.CHESSY_PROFILE_PARENT_TOKEN,'child requires authenticated parent attempt');
  const p=preflight(directory);check(ledger.registrationSha256===p.registrationSha256,'child registration differs from parent attempt');
  const modules=[load(p.original,p.loaderBytes),load(p.observer,p.loaderBytes)];
  check(typeof modules[1].api.profile_reset==='function'&&typeof modules[1].api.profile_count==='function','counter exports missing');
  for(let i=0;i<24;i++){
    const root=p.s.selected[i],rows=[];
    for(let offset=0;offset<2;offset++){
      const arm=(i+offset)%2,m=modules[arm];if(arm===1)m.api.profile_reset();
      let result;
      try{result=m.engine.search(root.fen,{...OPTIONS,positions:root.positions});}
      catch(error){
        const pointer=m.api.result_ptr(),raw=Buffer.from(m.api.memory.buffer,pointer,64).toString('base64');
        await new Promise(resolve=>process.send({type:'row',row:{index:i,taskId:root.taskId,ply:root.ply,arm:arm===0?'original':'observer',invalid:true,error:String(error),rawResultBase64:raw}},resolve));
        throw error;
      }
      const counts=arm===1?[]:null;let countsError=null;
      if(arm===1)try{for(let phase=0;phase<25;phase++)counts.push(Number(m.api.profile_count(phase)));}catch(error){countsError=String(error);}
      const row={index:i,taskId:root.taskId,ply:root.ply,arm:arm===0?'original':'observer',result,counts,...(countsError?{countsError}:{})};rows[arm]=row;
      await new Promise((resolve,reject)=>process.send({type:'row',row},error=>error?reject(error):resolve()));
      check(!countsError,countsError);if(counts)check(counts.every(x=>Number.isSafeInteger(x)&&x>=0),'counter range');
    }
    check(JSON.stringify(signature(rows[0].result))===JSON.stringify(signature(rows[1].result)),'observer search parity failed at '+i);
    if(root.archivedModuleSha256===ORIGINAL_SHA)check(JSON.stringify(signature(rows[0].result))===JSON.stringify(signature(root.archivedResult)),'original archived hybrid result changed at '+i);
  }
  preflight(directory);process.send({type:'complete'});
}
async function run(directory){
  const p=preflight(directory),ledger=path.join(directory,'started.json'),token=crypto.randomBytes(32).toString('hex');fs.writeFileSync(ledger,encode({registrationSha256:p.registrationSha256,parentPid:process.pid,token,started:new Date().toISOString()}),{flag:'wx'});
  const rows=[],worker=fork(__filename,['child',directory],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,CHESSY_PROFILE_PARENT_TOKEN:token}});let complete=false,stderr='',failure=null;
  worker.stderr.on('data',b=>{stderr+=b;});worker.on('message',m=>{if(m.type==='row')rows.push(m.row);else if(m.type==='complete')complete=true;});
  const timer=setTimeout(()=>{failure='60-second watchdog';worker.kill('SIGKILL');},60000);
  const code=await new Promise(resolve=>{worker.on('error',e=>{failure=String(e);resolve(null);});worker.on('close',resolve);});clearTimeout(timer);
  let aggregate=null;
  try{check(code===0&&complete&&rows.length===48&&!failure,'incomplete observer run');preflight(directory);aggregate=validateRows(rows,p.s.selected);}
  catch(e){failure=failure||String(e);}
  const value={schema:'chessy.hybrid-eval-counts.results.v1',researchOnly:true,wallTimeSharesAllowed:false,registrationSha256:p.registrationSha256,complete:!failure,failure,stderr,aggregate,rows};
  fs.writeFileSync(path.join(directory,failure?'failure.json':'results.json'),encode(value),{flag:'wx'});check(!failure,failure);return value;
}
if(require.main===module){const [command,...args]=process.argv.slice(2);Promise.resolve().then(()=>{
  if(command==='prepare'){check(args.length===3,'prepare DIRECTORY ARCHIVE ORIGINAL_CRATE');return prepare(...args);}
  check(args.length===1,'register/run DIRECTORY');if(command==='register')return register(args[0]);if(command==='run')return run(args[0]);check(command==='child','unknown command');return child(args[0]);
}).then(x=>{if(command!=='child')console.log(JSON.stringify({command,complete:true,selected:x.selected?.length,rows:x.rows?.length}));}).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={select,prepare,register,preflight,signature,load,validateRows};
