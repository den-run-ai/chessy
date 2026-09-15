'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const C=require('../../tools/training/hybrid-match-capture-v1'),N=require('../../tools/training/natural-runtime-run');
test('post-close live truncation cannot destroy exact retained game evidence',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-retained-trace-')),file=path.join(dir,'game.jsonl'),retained=new Map();
  try{const writer=new C.RetainedWriter(file,retained);writer.append({type:'header',name:'Unicode é ♞'});writer.append({type:'move',ply:0});writer.append({type:'end',result:'1/2-1/2'});
    const receipt=writer.close(),original=fs.readFileSync(file);assert.equal(N.sha(original),receipt.sha256);
    fs.truncateSync(file,original.indexOf(10)+1);assert.notEqual(N.sha(fs.readFileSync(file)),receipt.sha256);
    const archive=path.join(dir,'archive.json'),info=C.archive(archive,retained,[receipt]);const recovered=C.readArchive(archive,info,[receipt]).get('game.jsonl');
    assert(recovered.equals(original));assert.equal(N.sha(recovered),receipt.sha256);assert.equal(recovered.length,receipt.bytes);
    assert.notEqual(fs.readFileSync(file).length,receipt.bytes); // Live evidence remains untouched.
    fs.appendFileSync(archive,' ');assert.throws(()=>C.readArchive(archive,info,[receipt]),/archive hash/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('immutable archive publication refuses overwrite',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-retained-atomic-')),file=path.join(dir,'archive.json');
  try{C.atomic(file,Buffer.from('first'));assert.throws(()=>C.atomic(file,Buffer.from('second')),/EEXIST/);assert.equal(fs.readFileSync(file,'utf8'),'first');}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('missing retained game and corrupted retained bytes fail closed',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-retained-invalid-')),retained=new Map();
  try{const writer=new C.RetainedWriter(path.join(dir,'g.jsonl'),retained);writer.append({type:'end'});const receipt=writer.close();
    assert.throws(()=>C.archive(path.join(dir,'missing.json'),new Map(),[receipt]),/inventory/);
    retained.get('g.jsonl').raw[0]=0;assert.throws(()=>C.archive(path.join(dir,'corrupt.json'),retained,[receipt]),/digest/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
