'use strict';
// A capability-limited adapter realm. Only retained fixture text and primitive
// messages cross into it; no host require, module, Buffer, function or error is
// exposed to benchmark code. This is a provenance boundary, not an OS sandbox.
const vm=require('node:vm'),path=require('node:path'),zlib=require('node:zlib');
const {performance}=require('node:perf_hooks');

function adapterRealm(bridge,configText){
  delete globalThis.__capturedBridge;
  const parse=JSON.parse,stringify=JSON.stringify;
  const resolvePromise=Promise.resolve.bind(Promise);
  const then=Function.prototype.call.bind(Promise.prototype.then);
  const config=parse(configText),engines=[],loads=[];
  const errorText=error=>{try{return ''+error;}catch{return 'captured adapter failed';}};
  function call(operation,args){
    const result=parse(bridge(operation,stringify(args)));
    if(Object.hasOwn(result,'error'))throw Error(result.error);
    return result.value;
  }
  const builtin=Object.freeze({
    fs:Object.freeze({readFileSync(file,encoding){
      if(file!==config.fixturePath||encoding!=='utf8')throw Error('benchmark attempted an uncaptured file read');
      return config.fixtureText;
    }}),
    path:Object.freeze({join:(...args)=>call('path.join',args),resolve:(...args)=>call('path.resolve',args)}),
    zlib:Object.freeze({constants:Object.freeze({BROTLI_PARAM_QUALITY:config.brotliQuality}),
      brotliCompressSync:(bytes,options)=>({byteLength:call('brotli.size',[Array.from(bytes),options])})}),
    perf_hooks:Object.freeze({performance:Object.freeze({now:()=>call('now',[])})})
  });
  globalThis.require=function require(id){
    const name=typeof id==='string'?id.replace(/^node:/,''):'';
    if(!Object.hasOwn(builtin,name))throw Error('benchmark may import only captured adapter built-ins: '+String(id));
    return builtin[name];
  };
  globalThis.process=Object.freeze({hrtime:Object.freeze({bigint:()=>BigInt(call('hrtime',[]))})});
  globalThis.TextEncoder=class TextEncoder{encode(text){return new Uint8Array(call('utf8',[String(text)]));}};
  globalThis.module={exports:{}};globalThis.exports=module.exports;
  globalThis.__filename=config.sourcePath;globalThis.__dirname=config.sourceDirectory;
  // The host calls this realm-owned function with a serialized request only.
  // Engine handles and every object given to the adapter remain in this realm.
  globalThis.__adapterDispatch=function dispatch(operation,payload){
    try{
      const args=parse(payload);let value;
      if(operation==='constants')value={POSITIONS:module.exports.POSITIONS,
        STOP_REASONS:module.exports.STOP_REASONS,EXPERIMENT_METRIC_SLOTS:module.exports.EXPERIMENT_METRIC_SLOTS};
      else if(operation==='load'){
        const id=loads.push({pending:true})-1;value={id};
        then(resolvePromise(module.exports.loadOrdinaryWasmBytes(new Uint8Array(args.bytes),args.label,args.source)),engine=>{
          try{
            engines[id]=engine;
            loads[id]={pending:false,binaryBytes:engine.binaryBytes,brotliBytes:engine.brotliBytes};
          }catch(error){loads[id]={error:errorText(error)};}
        },error=>{loads[id]={error:errorText(error)};});
      }else if(operation==='poll')value=loads[args.id];
      else if(operation==='search')value=engines[args.id].search(args.fen,args.options);
      else if(operation==='memory')value=engines[args.id].memoryBytes();
      else throw Error('unknown captured adapter operation');
      return stringify({value});
    }catch(error){return stringify({error:errorText(error)});}
  };
}

function createAdapter(source,fixture){
  const bridge=(operation,payload)=>{
    try{
      const args=JSON.parse(payload);let value;
      if(operation==='path.join'||operation==='path.resolve'){
        if(!Array.isArray(args)||!args.every(x=>typeof x==='string'))throw Error('invalid path arguments');
        value=path[operation.slice(5)](...args);
      }else if(operation==='brotli.size')value=zlib.brotliCompressSync(Buffer.from(args[0]),args[1]).byteLength;
      else if(operation==='now')value=performance.now();
      else if(operation==='hrtime')value=process.hrtime.bigint().toString();
      else if(operation==='utf8')value=Array.from(Buffer.from(args[0],'utf8'));
      else throw Error('unknown captured adapter capability');
      return JSON.stringify({value});
    }catch(error){return JSON.stringify({error:String(error)});}
  };
  // A host Object prototype would expose its host Function constructor through
  // globalThis.constructor.constructor even with realm string codegen disabled.
  const sandbox=Object.create(null);sandbox.__capturedBridge=bridge;
  const context=vm.createContext(sandbox,{codeGeneration:{strings:false,wasm:true}});
  const config={fixturePath:fixture.path,fixtureText:fixture.bytes.toString('utf8'),
    sourcePath:source.path,sourceDirectory:path.dirname(source.path),brotliQuality:zlib.constants.BROTLI_PARAM_QUALITY};
  new vm.Script('('+adapterRealm.toString()+')(__capturedBridge,'+JSON.stringify(JSON.stringify(config))+');').runInContext(context);
  // Capture the original function before adapter code runs. Otherwise a Proxy
  // substituted at the global entrypoint can receive a host arguments array.
  const dispatch=context.__adapterDispatch;
  delete context.__adapterDispatch;
  const program='(function(){try{\n'+source.bytes.toString('utf8')+'\n;return null;}catch(error){try{return ""+error;}catch{return "captured adapter failed";}}})()';
  let failure;
  try{failure=new vm.Script(program,{filename:source.path}).runInContext(context);}
  catch{throw Error('captured benchmark evaluation failed');}
  if(failure!==null)throw Error(typeof failure==='string'?failure:'invalid captured benchmark completion');
  function invoke(operation,args){
    let encoded;
    try{encoded=dispatch(operation,JSON.stringify(args));}
    catch{throw Error('captured adapter operation failed');}
    if(typeof encoded!=='string')throw Error('captured adapter returned a nonserialized response');
    const response=JSON.parse(encoded);
    if(Object.hasOwn(response,'error'))throw Error(response.error);
    return response.value;
  }
  const constants=invoke('constants',{});
  return {
    ...constants,
    async loadOrdinaryWasmBytes(bytes,label,sourcePath){
      const {id}=invoke('load',{bytes:Array.from(bytes),label,source:sourcePath});
      let metadata;
      // Await only a host Promise. A realm-controlled thenable must never
      // receive host resolver functions through Promise assimilation.
      for(;;){
        metadata=invoke('poll',{id});
        if(Object.hasOwn(metadata,'error'))throw Error(metadata.error);
        if(!metadata.pending)break;
        await new Promise(resolve=>setImmediate(resolve));
      }
      return {binaryBytes:metadata.binaryBytes,brotliBytes:metadata.brotliBytes,
        search(fen,options){return invoke('search',{id,fen,options});},
        memoryBytes(){return invoke('memory',{id});}};
    }
  };
}
module.exports={createAdapter};
