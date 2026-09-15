#!/usr/bin/env node
'use strict';
// Read-only auditors for the completed, single-attempt v1 study.
// The exact executed runner is preserved as inert encoded JSON; never evaluate the decoded bytes.
const crypto=require('node:crypto'),zlib=require('node:zlib');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(v,m)=>{if(!v)throw Error(m);};
const ARCHIVE_SHA='05f6d2059ff492c364d6e28965b165c2b783df7199735b9809713e85e751b516';
const ORIGINAL_SHA='18c69302d9aaecc0078a5b398e68789f24adb66e525c99f8bc9ac9ddc60e9493';
const SALT='chessy.hybrid-eval-counts.v1|2026-09-15';
const OPTIONS=Object.freeze({maxDepth:30,nodeLimit:16384,timeMs:0,quiesce:true});
const sameOptions=o=>o&&Object.keys(o).length===4&&Object.entries(OPTIONS).every(([k,v])=>o[k]===v);
const RETIRED='Counts v1 is completed and retired; prepare/register/run/child are disabled for every path. No rerun or new registration is permitted.';
// Keep former public names as unconditional failures, even for cached imports,
// copied studies, fresh output directories, symlinks, or fabricated IPC state.
function retired(){throw Error(RETIRED);}
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
if(require.main===module){console.error(RETIRED);process.exitCode=2;}
module.exports=Object.freeze({select,signature,validateRows,prepare:retired,register:retired,run:retired,child:retired,preflight:retired,load:retired});
