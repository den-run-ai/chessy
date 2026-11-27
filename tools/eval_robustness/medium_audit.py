"""Rebuild every Medium search request, replay every PGN and report complete pairs."""
import argparse
from collections import Counter, defaultdict
import gzip
import io
import json
import os
import shutil
from pathlib import Path
from statistics import mean
import subprocess

import chess
import chess.pgn

from tools.eval_pipeline import frontier, games
from .medium import BASE, CANDIDATE, digest_file


def exact(obj, key, expected):
    if obj[key] != expected:
        raise ValueError(f'{key} differs from registered campaign')


def distribution(samples):
    return {'mean':mean(samples), **{f'p{q}':frontier.quantile(sorted(samples), q/100) for q in [50,95,99]},
            'max':max(samples)}


def audit(path, *, measurements=None):
    config = json.loads((path/'registration.json').read_bytes())
    if (config['files']['backend/base.wasm']['sha256'], config['files']['backend/candidate.wasm']['sha256']) != (BASE, CANDIDATE):
        raise ValueError('incorrect WASM identities')
    for binding in config['files'].values():
        games.bound(path,binding)
    preset = {'maxDepth':30, 'nodeLimit':10000, 'timeMs':5000, 'quiesce':True, 'label':'Medium','target':'1700'}
    exact(config,'preset',preset)
    bank = {r['sourceGameId']:r for r in map(json.loads,(path/'bank.jsonl').read_bytes().splitlines())}
    expected = 64 if 'replicationShard' in config else 32
    if len(bank) != expected or config['postOpeningPlyCap'] != 180:
        raise ValueError('incorrect opening count or post-opening ply cap')
    schedule = config['schedule']
    pair_ids = Counter((s['openingId'],s['candidateColor']) for s in schedule)
    if pair_ids != Counter((opening,color) for opening in bank for color in ['white','black']):
        raise ValueError('schedule does not cover each opening in each color exactly once')
    pgn_data = (path/'games.pgn').read_bytes()
    chunks = pgn_data.split(b'[Event ')[1:]
    if b''.join(b'[Event '+c for c in chunks) != pgn_data or len(chunks)!=len(schedule):
        raise ValueError('malformed or incomplete PGNs')
    telemetry = defaultdict(list)
    points = defaultdict(list)
    finishes = Counter()
    reasons = Counter()
    replay_requests, replay_hashes = [], []
    opening_plies = 0
    rows = []
    with gzip.open(path/'raw.jsonl.gz', 'rt') as f:
        def take(event):
            row = json.loads(next(f))
            exact(row, 'event', event)
            return row
        header = take('header')
        exact(header, 'registrationSha256',digest_file(path/'registration.json'))
        for slot, chunk in zip(schedule, chunks, strict=True):
            exact(take('start'),'slot',slot)
            opening = bank[slot['openingId']]
            board = chess.Board()
            history = [board.fen(en_passant='fen')]
            game = chess.pgn.read_game(io.StringIO((b'[Event '+chunk).decode()))
            if game.errors:
                raise ValueError('illegal PGN')
            for key, expected in {'ScheduleId':slot['scheduleId'],'SourceGameId':slot['openingId'],
                                  'White':slot['candidateId'] if slot['candidateColor']=='white' else slot['baseId'],
                                  'Black':slot['baseId'] if slot['candidateColor']=='white' else slot['candidateId'],
                                  'SearchLimit':'10000 nodes; max depth 30; deadline 5000ms/move; quiescence on'}.items():
                exact(game.headers,key,expected)
            moves = [m.uci() for m in game.mainline_moves()]
            prefix = opening['prefixUci']
            if moves[:len(prefix)] != prefix or len(prefix) < 12:
                raise ValueError('unexpected or too-short game prefix')
            for uci in prefix:
                board.push_uci(uci)
                history.append(board.fen(en_passant='fen'))
            opening_plies += len(prefix)
            exact(opening,'fen',history[-1])
            ply = 0
            for ply, uci in enumerate(moves[len(prefix):],start=1):
                if games.audited_ending(board,ply-1,180):
                    raise ValueError('PGN continued after terminal state')
                side = 'candidate' if (board.turn == chess.WHITE) == (slot['candidateColor'] == 'white') else 'base'
                req = {'engine':side, 'id':slot['scheduleId']+'-'+str(ply-1), 'op':'search','fen':history[-1],
                       'historyFens':history,'maxDepth':30,'nodeLimit':10000,'timeMs':5000,'quiesce':True,'rootSeed':None}
                payload = take('move')
                exact(payload,'requestSha256',games.sha(games.encoded(req)))
                result = games.search_contract(req,payload['response'],board)
                exact(result,'uci',uci)
                if result['nodes']>10000 or (result['stopReason']=='node-limit' and result['nodes']!=10000):
                    raise ValueError('incorrect node-ceiling enforcement')
                if payload['wallNs']<=0:
                    raise ValueError('invalid request timing')
                telemetry[side].append((result, payload['wallNs']/1e6))
                board.push_uci(uci)
                history.append(board.fen(en_passant='fen'))
            end = games.audited_ending(board,ply,180)
            closed = take('end')
            exact(closed,'terminal',end)
            exact(closed,'plies',ply)
            exact(closed,'historySha256',games.sha(games.encoded(history)))
            exact(closed,'pgnSha256',games.sha(b'[Event '+chunk))
            exact(game.headers,'Result',end['result'])
            exact(game.headers,'Termination',end['termination'])
            replay_requests.append({'id':slot['scheduleId']+'-replay','op':'replay','moves':moves})
            replay_hashes.append(closed['replaySha256'])
            if end['result']=='1/2-1/2':
                score = .5
            else:
                score = int((end['result']=='1-0') == (slot['candidateColor']=='white'))
            finishes[score]+=1
            reasons[end['termination']]+=1
            points[slot['openingId']].append(score)
            rows.append({**slot,'candidatePoints':score,**end,'postOpeningPlies':ply})
        if f.readline():
            raise ValueError('unexpected events after final game')
    # Replay from start a second time through the frozen JavaScript product rules.
    node = config['nodeExecutable']
    recorded = Path(node['path'])
    executable = recorded if recorded.is_file() else Path(shutil.which('node'))
    exact(node, 'sha256',digest_file(executable))
    proc = subprocess.run([executable,*config['runtime']['nodeArguments'],path/'backend/host.mjs',
                           '--rules',path/'backend/engine.cjs','--loader',path/'backend/wasm-engine.cjs',
                           '--wasm',f"base={path/'backend/base.wasm'}",'--wasm',f"candidate={path/'backend/candidate.wasm'}"],
                          input=b''.join(games.encoded(req) for req in replay_requests),capture_output=True,check=True,
                          env={**os.environ,'NODE_OPTIONS':'','NODE_PATH':''})
    if [games.sha(line) for line in proc.stdout.splitlines(keepends=True)] != replay_hashes:
        raise ValueError('fresh production replay differed from the original evidence')
    score = mean(mean(vals) for vals in points.values())
    boot = {'timeControlsMs':[5000],'openingIds':list(bank),'clusterByOpening':{k:r['ply4Family'] for k,r in bank.items()},
            'bootstrap':{'confidence':.95,'samples':10000,'seed':20261127}}
    interval, detail = frontier._bootstrap(boot, {5000:{k:mean(x) for k,x in points.items()}})
    stats = {}
    for k, observations in telemetry.items():
        if measurements is not None:
            measurements[k].extend(observations)
        results, walls = zip(*observations)
        stats[k] = {'searches':len(results),'fullRequestMs':distribution(walls),'engineCallMs':distribution([r['engineCallMs'] for r in results]),
                    'completedDepth':distribution([r['depth'] for r in results]), 'completedDepthCounts':Counter(r['depth'] for r in results),
                    'depthZeroFallbacks':sum(r['depth']==0 for r in results),'stopReason':Counter(r['stopReason'] for r in results),
                    'nodes':distribution([r['nodes'] for r in results]),'quiescenceNodes':sum(r['qnodes'] for r in results),
                    'totalNodes':sum(r['nodes'] for r in results)}
    return {'scope':'Development. Same openings and engines as initial 25ms match, different budgets and seed path.',
            'registrationSha256':digest_file(path/'registration.json'),'rawGzSha256':digest_file(path/'raw.jsonl.gz'),
            'pgnSha256':digest_file(path/'games.pgn'),'preset':preset,'games':len(schedule),'openings':len(bank),'outcomes':{'wins':finishes[1],'draws':finishes[.5],'losses':finishes[0]},
            'candidateScore':score,'clusterInterval95':interval[5000],'uncertainty':detail,'termination':reasons,
            'searchedPlies':sum(len(o) for o in telemetry.values()),'openingPliesReplayed':opening_plies,
            'telemetry':stats,'gameRows':rows}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('campaign',type=Path)
    p.add_argument('output',type=Path)
    args = p.parse_args()
    results = audit(args.campaign.resolve())
    games.write(args.output, (json.dumps(results,indent=2,sort_keys=True)+'\n').encode())
