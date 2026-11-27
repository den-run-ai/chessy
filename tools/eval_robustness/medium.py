"""Play the no-clock Medium preset on the previously exposed unscaled opening bank."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

import chess

from tools.eval_pipeline import games

ROOT = Path(__file__).resolve().parents[2]
BANK = ROOT / 'eval/eval-robustness-v1/match-unscaled-openings.jsonl'
BASE = 'fa3e1f4f64cc082e5ffc1ef64b802f5477041938ca8864f77f82518e859cffb5'
CANDIDATE = '1f7aa35c560e4b94d11c578b94a6be2d7fae4a34b45dd7356961888bc97992e4'
CAP = 180


def digest_file(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def make_request(slot, plies, history, board, preset):
    if len(history) < 13:
        raise ValueError('this study only supports midgame roots beyond the opening variety window')
    candidate = board.turn == (slot['candidateColor'] == 'white')
    return {'id': f"{slot['scheduleId']}-{plies}", 'op': 'search', 'engine': 'candidate' if candidate else 'base',
            'fen': history[-1], 'historyFens': history, 'rootSeed': None,
            **{k: preset[k] for k in ('maxDepth', 'quiesce', 'timeMs', 'nodeLimit')}}


def register(out, base, candidate, *, replication_shard=None):
    if (digest_file(base), digest_file(candidate)) != (BASE, CANDIDATE):
        raise ValueError('unexpected control or candidate module')
    if replication_shard not in (None, 0, 1):
        raise ValueError('invalid replication shard')
    cpu = 4 if replication_shard is None else 3 + replication_shard
    if os.sched_getaffinity(0) != {cpu}:
        raise ValueError(f'run registration and campaign under taskset -c {cpu}')
    node = Path(shutil.which('node')).resolve()
    preset_path = ROOT / 'assets/level-presets.js'
    preset = json.loads(subprocess.check_output([node, '-e', "console.log(JSON.stringify(require(process.argv[1]).forClock('2',null,null)))", preset_path]))
    if preset != dict(label='Medium', target='1700', maxDepth=30, nodeLimit=10000, timeMs=5000, quiesce=True):
        raise ValueError('production Medium preset identity changed')
    source_bank = BANK if replication_shard is None else BANK.with_name('match-replication-openings.jsonl')
    all_rows = source_bank.read_bytes().splitlines(keepends=True)
    size = 32 if replication_shard is None else 128
    if len(all_rows) != size:
        raise ValueError('wrong bank size')
    bank_bytes = b''.join(all_rows if replication_shard is None else all_rows[replication_shard::2])
    bank = [json.loads(line) for line in bank_bytes.splitlines()]
    if len(bank) != (32 if replication_shard is None else 64) or min(r['selectedPly'] for r in bank) < 12 or len({r['sourceGameId'] for r in bank}) != len(bank):
        raise ValueError('unexpected opening bank')
    out.mkdir(parents=True, exist_ok=False)
    modules = {'host.mjs': ROOT/'tools/eval_pipeline/host.mjs', 'engine.cjs': ROOT/'assets/engine.js',
               'wasm-engine.cjs': ROOT/'assets/wasm-engine.js', 'candidate.wasm': candidate, 'base.wasm': base}
    files = {}
    for name, source in modules.items():
        key = 'backend/' + name
        files[key] = games.retained(out, key, source.read_bytes())
    files['bank.jsonl'] = games.retained(out, 'bank.jsonl', bank_bytes)
    for name, source in [('level-presets.js',preset_path),('app.js',ROOT/'assets/app.js'),
                         ('medium.py',Path(__file__)),('games.py',Path(games.__file__)),('frontier.py',Path(games.frontier.__file__))]:
        files[name] = games.retained(out, name, source.read_bytes())
    schedule = []
    for i, row in enumerate(bank):
        index = i if replication_shard is None else i * 2 + replication_shard
        for color in (['white', 'black'] if i % 2 == 0 else ['black', 'white']):
            schedule.append(dict(scheduleId=f'medium-{index:02d}-{color}', openingId=row['sourceGameId'],
                                 candidateColor=color, candidateId='r85-unscaled-no-pawn', baseId='r85-hce-memory', timeMs=preset['timeMs']))
    config = {'protocol': 'Medium without clocks, one paired game per color, all 32 exposed unscaled-bank openings in file order; alternating first color. No adjudication or resignation. Stops follow product rules with a 180-ply development cap after the opening. A draw scores 0.5. Resample four-ply opening families, retaining both colors, 10000 bootstrap samples, seed 20261127.',
              'preset':preset, 'cpu':cpu, 'postOpeningPlyCap':CAP, 'rootSeedPolicy':'Product openingSeed returns null after 12 plies; every measured root has 16+ plies. Both sides use the unseeded ABI, including the same Rust default seed. The previous 25ms screen used explicit zero.',
              'schedule':schedule, 'nodeExecutable':games.identity(node), 'selectedCpu':cpu,
              'runtime':{'nodeArguments':['--no-liftoff','--no-wasm-lazy-compilation'],'timeoutPerRequestSeconds':15},
              'config':{}, 'files':files}
    if replication_shard is not None:
        config['protocol'] = config['protocol'].replace('all 32 exposed unscaled-bank openings in file order', 'all 128 replication openings in file order, split by index modulo two')
        config['replicationShard'] = replication_shard
        config['replicationBankSha256'] = digest_file(source_bank)
        files['medium_replication.py'] = games.retained(out,'medium_replication.py',Path(__file__).with_name('medium_replication.py').read_bytes())
    games.write(out/'registration.json', games.encoded(config))
    return config, {r['sourceGameId']:r for r in bank}


def play(out, config, bank):
    backend = games.Backend(config, out)
    try:
        with gzip.open(out/'raw.jsonl.gz','xt', compresslevel=2) as raw, (out/'games.pgn').open('xb') as pgn:
            def log(kind, **kwargs):
                raw.write(games.encoded({'event':kind, **kwargs}).decode())

            request = {'id':'info','op':'info'}
            line, _ = backend.request(request)
            info = games.info_contract(config, request, json.loads(line))
            log('header', registrationSha256=digest_file(out/'registration.json'), host=info)
            # Warm both persistent engines on identical work before measuring latency.
            fen = chess.STARTING_FEN
            for cycle in range(4):
                for side in (('base','candidate') if cycle % 2 == 0 else ('candidate','base')):
                    req = {'id':f'warm-{cycle}-{side}', 'op':'search','engine':side,'fen':fen,'historyFens':[fen],
                           'rootSeed':0,'quiesce':True,'nodeLimit':10000,'timeMs':0,'maxDepth':30}
                    line, _ = backend.request(req)
                    games.search_contract(req, json.loads(line), chess.Board())
            for slot in config['schedule']:
                opening = bank[slot['openingId']]
                board, history = games.prefix_board(opening)
                moves = list(opening['prefixUci'])
                plies = 0
                log('start', slot=slot)
                while (end := games.ending(board, plies, CAP)) is None:
                    request = make_request(slot, plies, history, board, config['preset'])
                    line, wall = backend.request(request)
                    response = json.loads(line)
                    result = games.search_contract(request, response, board)
                    log('move', requestSha256=games.sha(games.encoded(request)), response=response, wallNs=wall)
                    board.push_uci(result['uci'])
                    moves.append(result['uci'])
                    history.append(board.fen(en_passant='fen'))
                    plies += 1
                req = {'id':slot['scheduleId']+'-replay','op':'replay','moves':moves}
                line, _ = backend.request(req)
                games.replay_contract(req, json.loads(line), board, history, end)
                game = games.game_pgn(slot, opening, moves, end).replace(b'5000ms/move', b'10000 nodes; max depth 30; deadline 5000ms/move; quiescence on')
                pgn.write(game)
                pgn.flush()
                log('end', terminal=end, historySha256=games.sha(games.encoded(history)), pgnSha256=games.sha(game),
                    replaySha256=games.sha(line), plies=plies)
    finally:
        if backend.close() != 0:
            raise RuntimeError('production host exited unsuccessfully')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ('base','candidate','output'):
        parser.add_argument(arg,type=Path)
    args = parser.parse_args()
    out = args.output.resolve()
    config, bank = register(out, args.base, args.candidate)
    print('Registration',digest_file(out/'registration.json'),flush=True)
    play(out, config, bank)


if __name__ == '__main__':
    main()
