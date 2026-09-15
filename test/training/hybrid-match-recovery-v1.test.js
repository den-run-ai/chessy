'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{EventEmitter}=require('events');
const C=require('../../tools/training/hybrid-match-capture-v1'),R=require('../../tools/training/hybrid-match-recovery-v1'),N=require('../../tools/training/natural-runtime-run');
test('atomic game publication exposes no partial trace and retained archive survives later live loss',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chessy-recovery-atomic-')),file=path.join(dir,'g.jsonl'),retained=new Map();
  try{const writer=new C.AtomicRetainedWriter(file,retained);const rows=[{type:'header'},{type:'move',ply:0},{type:'end',result:'draw'}];
    for(const row of rows){writer.append(row);assert.equal(fs.existsSync(file),false);}
    const receipt=writer.close(),raw=Buffer.from(rows.map(row=>N.stable(row)+'\n').join(''));assert(fs.readFileSync(file).equals(raw));
    fs.truncateSync(file,raw.indexOf(10)+1);const archive=path.join(dir,'retained.json'),info=C.archive(archive,retained,[receipt]);
    const restored=C.readArchive(archive,info,[receipt]).get('g.jsonl');assert(restored.equals(raw));assert.equal(N.sha(restored),receipt.sha256);
    assert.equal(R.liveDiscrepancies(dir,[receipt]).length,1);assert.throws(()=>writer.append({type:'late'}),/closed/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('child cannot advance until parent acknowledges the exact captured game',async()=>{
  const channel=new EventEmitter(),sent=[];channel.send=(message,callback)=>{sent.push(message);callback(null);};let resolved=false;
  const wait=R.awaitCaptured('hybrid-o0-w',channel).then(()=>{resolved=true;});await Promise.resolve();assert.equal(resolved,false);
  assert.deepEqual(sent,[{control:'game-ready',taskId:'hybrid-o0-w'}]);channel.emit('message',{control:'game-captured',taskId:'wrong'});
  await Promise.resolve();assert.equal(resolved,false);channel.emit('message',{control:'game-captured',taskId:'hybrid-o0-w'});await wait;
  assert.equal(resolved,true);assert.equal(channel.listenerCount('message'),0);
});
test('failed capture transport rejects acknowledgement wait',async()=>{const channel=new EventEmitter();channel.send=(_message,callback)=>callback(Error('closed IPC'));
  await assert.rejects(R.awaitCaptured('game',channel),/closed IPC/);assert.equal(channel.listenerCount('message'),0);});
