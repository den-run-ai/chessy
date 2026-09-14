'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require('../../tools/training/natural-pilot-label');
const L = require('./label-stockfish');
const Corpus = require('./corpus');
const Chess = globalThis.Chess;
const ROOT = path.resolve(__dirname, '../..');
const teacher = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/training/natural-teacher-v1.json')));
const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/training/natural-pilot-v1.json')));
const fit = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/training/natural-fit-v1.json')));
const copy = value => JSON.parse(JSON.stringify(value));
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log('ok ' + name); }
function fixtureRow(prefix = ['e2e4', 'e7e5', 'g1f3', 'b8c6']) {
  let state = Chess.newGameState();
  for (const uci of prefix) {
    const move = Chess.legalMoves(state).find(m => Chess.sqName(m.from) + Chess.sqName(m.to) + (m.promotion || '') === uci);
    state = Chess.playMove(state, move);
  }
  const fen = Chess.toFen(state), family = Corpus.positionFamilyKey(fen);
  const cell = parseInt(family.slice(0, 12), 16) % 100;
  const role = N.ROLES.find(r => cell >= rules.selection.roles[r][0] && cell < rules.selection.roles[r][1]);
  return { schema: 'chessy.natural-pilot-row.v1',
    id: N.sha256(rules.id + '\0' + rules.source.sha256 + '\0abcdefgh\0' + prefix.length),
    sourceId: 'abcdefgh', sourceGame: { id: 'abcdefgh', selectedPly: prefix.length },
    fen, fen4: fen.split(' ').slice(0, 4).join(' '), prefixUci: prefix,
    cluster: Corpus.clusterKey(fen), positionFamily: family, phaseBucket: Corpus.phaseBucket(fen), role };
}
function result() {
  return { info: L.parseInfo('info depth 12 seldepth 14 score cp 18 wdl 40 940 20 nodes 90000 pv f1b5 a7a6 b5a4'),
    terminalInfo: L.parseInfo('info depth 13 seldepth 15 score cp 20 lowerbound nodes 100021 pv f1b5'), bestMove: 'f1b5' };
}
async function main() {
  await test('frozen100k/Hash64/Threads1/exact SF18 network contract cannot drift', () => {
    N.teacherContract(teacher);
    for (const change of [t => t.search.nodeLimit--, t => t.uci.Hash = 16, t => t.uci.Threads = 2,
      t => t.engine.networks[0].sha256 = '0'.repeat(64), t => t.labels.eligibility.boundScoresAllowed = true]) {
      const t = copy(teacher); change(t); assert.throws(() => N.teacherContract(t));
    }
  });
  await test('independent full-prefix replay preserves six-field clocks and repetition map', () => {
    const row = fixtureRow(['g1f3', 'g8f6', 'f3g1', 'f6g8', 'e2e4']);
    const state = N.replayRow(row);
    assert.strictEqual(Chess.toFen(state), row.fen);
    assert.strictEqual(state.positions[Chess.positionKey(Chess.newGameState())], 2);
    const wrong = copy(row); wrong.fen = wrong.fen.split(' ').slice(0, 4).join(' ') + ' 0 1';
    assert.throws(() => N.replayRow(wrong), /six-field FEN/);
    const illegal = copy(row); illegal.prefixUci[0] = 'a1a8';
    assert.throws(() => N.replayRow(illegal), /illegal UCI/);
  });
  await test('historical unclaimed draws may continue; current drawn endpoints are excluded', () => {
    const prefix = ['g1f3','g8f6','f3g1','f6g8','g1f3','g8f6','f3g1','f6g8'];
    const row = fixtureRow([...prefix,'e2e4']), state = N.replayRow(row);
    assert.strictEqual(state.positions[Chess.positionKey(Chess.newGameState())],3);
    assert.strictEqual(Chess.toFen(state),row.fen);
    assert.throws(() => N.replayRow(fixtureRow(prefix)), /endpoint is terminal/);
  });
  await test('exact score may precede terminal bound effort; all PV moves must replay', () => {
    const row = fixtureRow(), assessed = N.assess(result(), row, teacher, 2000, N.replayRow(row));
    assert.strictEqual(assessed.eligible, true);
    assert.deepStrictEqual(assessed.teacher, { scoreCp: 18, wdl: [40,940,20], targetWhite: 0.51,
      depth: 12, seldepth: 14, nodes: 100021, scoreNodes: 90000, bestmove: 'f1b5', pv: ['f1b5','a7a6','b5a4'] });
    const bad = result(); bad.info.pvUci.push('a8a4');
    assert.strictEqual(N.assess(bad,row,teacher,2000,N.replayRow(row)).reason, 'illegal-pv');
  });
  await test('frozen exclusions reject depth, node, WDL, mate, PV and cp-range mutations', () => {
    const row = fixtureRow();
    for (const change of [r => r.info.seldepth = 11, r => r.info.depth = 0,
      r => r.terminalInfo.nodes = 99999, r => r.info.nodes = 100022,
      r => r.info.wdlSideToMove = [-1, 1000, 1], r => r.info.wdlSideToMove = [1,2,3],
      r => r.info.cpSideToMove = 2001, r => r.info.scoreBound = 'lowerbound',
      r => r.terminalInfo.mateSideToMove = 2, r => r.bestMove = 'a2a3']) {
      const r = result(); change(r);
      assert.strictEqual(N.assess(r,row,teacher,2000,N.replayRow(row)).eligible, false);
    }
  });
  await test('Black score/WDL storage is White POV', () => {
    const row = fixtureRow(['e2e4']), r = result();
    r.info.pvUci = ['e7e5']; r.bestMove = 'e7e5';
    const a = N.assess(r,row,teacher,2000,N.replayRow(row));
    assert.strictEqual(a.teacher.scoreCp, -18); assert.deepStrictEqual(a.teacher.wdl,[20,940,40]);
    assert.strictEqual(a.teacher.targetWhite,0.49);
  });
  await test('legal PV validation does not invent a claim after historical repetition', () => {
    const row = fixtureRow(['e2e4']), r = result();
    r.info.pvUci = ['e7e5','g1f3','g8f6','f3g1','f6g8','g1f3','g8f6','f3g1','f6g8','b1c3'];
    r.bestMove = 'e7e5';
    assert.strictEqual(N.assess(r,row,teacher,2000,N.replayRow(row)).eligible,true);
  });
  await test('transport sends exact prefix, never synthetic FEN clocks; mate invalidates older CP', async () => {
    const row = fixtureRow(), sent = [];
    const lines = ['readyok', 'info depth 12 seldepth 14 score cp 18 wdl 40 940 20 nodes 90000 pv f1b5',
      'info depth 13 seldepth 15 score mate 2 nodes 95000 pv f1b5',
      'info depth 13 seldepth 15 score cp 19 lowerbound nodes 100021 pv f1b5', 'bestmove f1b5'];
    const engine = Object.create(N.NaturalUci.prototype);
    engine.watchdog = teacher.watchdog; engine.send = line => sent.push(line);
    engine.readUntil = async predicate => { const line = lines.shift(); assert.ok(predicate(line)); return line; };
    const r = await engine.labelNatural(row,teacher);
    assert.ok(sent.includes('position startpos moves e2e4 e7e5 g1f3 b8c6'));
    assert.ok(sent.includes('go nodes 100000'));
    assert.strictEqual(r.info,null);
    assert.ok(!sent.some(line => line.startsWith('position fen')));
  });
  await test('worker partitions require every exact input identity once', () => {
    const row = fixtureRow();
    const r = {index:0,id:row.id,accepted:false,reason:'teacher-failure',attempted:true};
    assert.strictEqual(N.partition([row],[r]).excluded.length,1);
    assert.throws(() => N.partition([row],[]));
    assert.throws(() => N.partition([row],[{...r,id:'0'.repeat(64)}]));
  });
  await test('authenticated snapshots consume retained bytes and reject incorrect digests', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'natural-label-snapshot-'));
    try {
      const file = path.join(dir,'input'); fs.writeFileSync(file,'old');
      const s = N.snapshot(file,N.sha256('old')); fs.writeFileSync(file,'new');
      assert.strictEqual(s.bytes.toString(),'old');
      assert.throws(() => N.snapshot(file,s.sha256), /digest mismatch/);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  await test('Writer publishes actual pathname bytes matching its append digest', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'natural-writer-valid-'));
    try {
      const file=path.join(dir,'raw.jsonl'),writer=new N.Writer(file);
      writer.append({row:1});writer.sync();writer.append({row:2});
      const result=writer.close(),bytes=fs.readFileSync(file);
      assert.strictEqual(result.sha256,N.sha256(bytes));assert.strictEqual(result.bytes,bytes.length);assert.strictEqual(result.rows,2);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  await test('Writer rejects same-content pathname replacement before append and close', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'natural-writer-replaced-'));
    try {
      const file=path.join(dir,'raw.jsonl'),writer=new N.Writer(file);writer.append({row:1});
      fs.renameSync(file,file+'.original');fs.copyFileSync(file+'.original',file);
      assert.throws(()=>writer.append({row:2}),/inode changed/);
      assert.throws(()=>writer.close(),/inode changed/);
      assert.strictEqual(fs.readFileSync(file+'.original','utf8'),'{"row":1}\n');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  await test('Writer detects a replacement performed during append and sync', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'natural-writer-during-'));
    try {
      for(const method of ['writeSync','fsyncSync']) {
        const file=path.join(dir,method+'.jsonl'),writer=new N.Writer(file),original=fs[method];
        let replaced=false;
        fs[method]=function(fd,...args){
          const result=original.call(fs,fd,...args);
          if(fd===writer.fd&&!replaced){replaced=true;fs.renameSync(file,file+'.original');fs.copyFileSync(file+'.original',file);}
          return result;
        };
        try {assert.throws(()=>method==='writeSync'?writer.append({row:1}):writer.sync(),/inode changed/);}
        finally {fs[method]=original;}
        assert.throws(()=>writer.close(),/inode changed/);
      }
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  await test('Writer rejects truncation promptly and same-size overwrite at final rehash', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'natural-writer-overwrite-'));
    try {
      for(const kind of ['truncate','overwrite']) {
        const file=path.join(dir,kind+'.jsonl'),writer=new N.Writer(file);writer.append({row:1});
        if(kind==='truncate') {
          fs.truncateSync(file,2);
          assert.throws(()=>writer.append({row:2}),/size differs/);
          assert.throws(()=>writer.close(),/size differs/);
        }else{
          fs.writeFileSync(file,'{"row":2}\n');
          assert.throws(()=>writer.close(),/digest differs/);
        }
      }
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  await test('interrupted inventory reports hashes and coverage without reading out scores', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'natural-interrupted-inventory-'));
    try {
      fs.writeFileSync(path.join(dir,'worker-2.uci.jsonl'),N.stable({rowId:null,index:null,line:'> uci'})+'\n');
      fs.writeFileSync(path.join(dir,'worker-2.partition.jsonl'),N.stable({id:'a'.repeat(64),index:2,accepted:true,
        teacher:{scoreCp:123456,pv:['forbidden-score-evidence-marker']}})+'\n{');
      const inventory=N.inventoryInterruptedRun(dir);
      assert.strictEqual(inventory.status,'infrastructure-invalid');assert.strictEqual(inventory.completionMarkerPresent,false);
      assert.strictEqual(inventory.files.find(x=>x.path.endsWith('.uci.jsonl')).uniqueRowIdentities,0);
      const partition=inventory.files.find(x=>x.path.endsWith('.partition.jsonl'));
      assert.strictEqual(partition.uniqueRowIdentities,1);assert.strictEqual(partition.completeLines,1);
      assert.strictEqual(partition.endsWithNewline,false);assert.strictEqual(partition.dispositions.accepted,1);
      assert.ok(!N.stable(inventory).includes('forbidden-score-evidence-marker'));
      assert.ok(!N.stable(inventory).includes('scoreCp'));
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  await test('failed executable still publishes complete exclusion/transcript partition and blocks replacement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'natural-label-failed-'));
    try {
      const a = {}, snapshots = {};
      function json(name, value) {
        const bytes = N.stable(value)+'\n', file = path.join(dir,name+'.json'); fs.writeFileSync(file,bytes);
        a[name]=file; a[name+'-sha256']=N.sha256(bytes); snapshots[name] = a[name+'-sha256'];
      }
      json('rules',rules); json('fit-rules',fit); json('teacher-manifest',teacher);
      const row = fixtureRow(), files = N.ROLES.map(role => {
        const bytes = role === row.role ? N.stable(row)+'\n' : '';
        fs.writeFileSync(path.join(dir,role+'.ndjson'),bytes);
        return {role,path:role+'.ndjson',bytes:Buffer.byteLength(bytes),rows:role===row.role?1:0,sha256:N.sha256(bytes)};
      });
      json('selection-manifest',{schema:'chessy.natural-pilot-selection.v1',status:'complete-research-only-selection',
        productionFitAllowed:false,coverage:{fullPilotReady:true},preregistration:{sha256:snapshots.rules},
        fitPreregistration:{sha256:snapshots['fit-rules']},teacherContract:{sha256:snapshots['teacher-manifest']},
        source:{sha256:rules.source.sha256,uncompressedSha256:'a'.repeat(64),games:rules.source.games},selection:{rows:1,files}});
      a.stockfish=path.join(dir,'missing-executable');a.output=path.join(dir,'out');
      const summary = await N.run(a);
      assert.strictEqual(summary.status,'failed');assert.strictEqual(summary.output.acceptedRows,0);
      assert.strictEqual(summary.output.excludedRows,1);assert.strictEqual(summary.workers.length,8);
      const exclusion = JSON.parse(fs.readFileSync(path.join(a.output,'excluded.ndjson')));
      assert.strictEqual(exclusion.id,row.id);assert.strictEqual(exclusion.exclusion.attempted,false);
      assert.ok(summary.workers.every(w=>w.status==='failed' && w.transcript.rows>=1));
      assert.ok(fs.existsSync(path.join(a.output,'summary.json')));
      await assert.rejects(N.run(a),/EEXIST/);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  console.log(checks+' natural label tests passed; no real teacher or holdout search');
}
main().catch(error => {console.error(error);process.exitCode=1;});
