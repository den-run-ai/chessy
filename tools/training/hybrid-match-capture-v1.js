'use strict';
// Preserve exact emitted bytes independently of mutable live trace files.
// Compression and final archival occur only after all timed searches stop.
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const N=require('./natural-runtime-run');
function check(ok,message){if(!ok)throw Error(message);}
class RetainedWriter extends N.Writer {
  constructor(file,retained){super(file);this.retained=retained;this.chunks=[];}
  append(row){const bytes=Buffer.from(N.stable(row)+'\n');super.append(row);this.chunks.push(bytes);}
  close(){const raw=Buffer.concat(this.chunks),receipt=super.close();
    check(raw.length===receipt.bytes&&N.sha(raw)===receipt.sha256,'retained emitted stream differs from verified close receipt');
    check(!this.retained.has(receipt.path),'duplicate retained trace');this.retained.set(receipt.path,{receipt,raw});this.chunks=[];return receipt;}
}
class AtomicRetainedWriter {
  constructor(file,retained){check(!fs.existsSync(file),'new atomic trace path required');this.file=file;this.retained=retained;this.chunks=[];this.rows=0;this.closed=false;}
  append(row){check(!this.closed,'trace already closed');this.chunks.push(Buffer.from(N.stable(row)+'\n'));this.rows++;}
  close(){check(!this.closed,'trace already closed');const raw=Buffer.concat(this.chunks),name=path.basename(this.file);
    check(!this.retained.has(name),'duplicate retained trace');const receipt={...atomic(this.file,raw),rows:this.rows};
    check(N.sha(raw)===receipt.sha256&&raw.length===receipt.bytes,'atomic retained stream differs');
    this.retained.set(name,{receipt,raw});this.chunks=[];this.closed=true;return receipt;}
}
function atomic(file,bytes){
  const staging=file+'.staged-'+process.pid,fd=fs.openSync(staging,'wx');
  try{let offset=0;while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);check(n>0,'short archive write');offset+=n;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  check(fs.readFileSync(staging).equals(bytes),'staged archive differs from retained stream');
  // link() atomically creates the destination and fails if it already exists.
  fs.linkSync(staging,file);fs.unlinkSync(staging);
  const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  check(fs.readFileSync(file).equals(bytes),'published immutable archive differs');
  return {path:path.basename(file),bytes:bytes.length,sha256:N.sha(bytes)};
}
function archive(file,retained,expected){
  check(retained.size===expected.length,'retained archive inventory incomplete');
  const entries=expected.map(receipt=>{const saved=retained.get(receipt.path);check(saved,'missing retained trace');
    for(const key of ['path','bytes','rows','sha256'])check(saved.receipt[key]===receipt[key],'retained close receipt differs');
    check(saved.raw.length===receipt.bytes&&N.sha(saved.raw)===receipt.sha256,'retained raw digest differs');
    return {...saved.receipt,gzipBase64:zlib.gzipSync(saved.raw).toString('base64')};});
  const value={schema:'chessy.hybrid-retained-game-archive.v1',compressionAfterTimedSearches:true,entries};
  const result={...atomic(file,Buffer.from(N.stable(value)+'\n')),entries:entries.length};readArchive(file,result,expected);return result;
}
function readArchive(file,info,expected){
  const bytes=fs.readFileSync(file);check(bytes.length===info.bytes&&N.sha(bytes)===info.sha256,'immutable archive hash differs');
  const value=JSON.parse(bytes);check(value.schema==='chessy.hybrid-retained-game-archive.v1'&&value.compressionAfterTimedSearches===true&&
    value.entries.length===expected.length&&value.entries.length===info.entries,'archive schema/inventory differs');
  const result=new Map();for(let i=0;i<expected.length;i++){const entry=value.entries[i],receipt=expected[i];
    for(const key of ['path','bytes','rows','sha256'])check(entry[key]===receipt[key],'archive/close receipt differs');
    check(!result.has(entry.path),'duplicate archive entry');const raw=zlib.gunzipSync(Buffer.from(entry.gzipBase64,'base64'));
    check(raw.length===entry.bytes&&N.sha(raw)===entry.sha256,'decompressed emitted stream differs');
    check(raw.length>0&&raw.at(-1)===10&&raw.toString().trimEnd().split('\n').length===entry.rows,'decompressed row count differs');result.set(entry.path,raw);
  }return result;
}
module.exports={RetainedWriter,AtomicRetainedWriter,atomic,archive,readArchive};
