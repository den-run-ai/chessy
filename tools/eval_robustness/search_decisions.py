"""Rank the registered held-out siblings with the production exact-root ABI."""
import argparse
from collections import Counter
import gzip
import json
from pathlib import Path
from statistics import fmean
import subprocess

import chess

from tools.eval_pipeline.games import response_result
from .cross_teacher import select, write_jsonl
from .fit import digest, integer_score, read_groups, regret_interval


ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / 'eval/eval-robustness-v1'
PROTOCOL_SHA = '4961fbf6ee22c1864ade9f1c3b359cba723b21270117097da48f1866bc871c63'
MODEL_IDS = ('hce', 'full', 'nopawn', 'fitted')
MODEL_FIELDS = ('hce', 'full', 'noPawn')
DEPTHS = (1, 3)
NODES = 10_000


def inputs():
    files = {key: (EVIDENCE / name).read_bytes() for key, name in (
        ('collection', 'collection.jsonl.gz'), ('fit', 'fit-results.json'),
        ('excluded', 'fit-exclusions.json'), ('labels', 'cross-teacher-labels.jsonl.gz'),
        ('manifest', 'cross-teacher-manifest.json'), ('protocol', 'search-decisions-protocol.json'))}
    fit = json.loads(files['fit'])
    manifest = json.loads(files['manifest'])
    raw = gzip.decompress(files['collection'])
    if (digest(files['protocol']) != PROTOCOL_SHA or
            fit['collectionSha256'] != digest(files['collection']) or
            fit['exclusionsSha256'] != digest(files['excluded']) or
            manifest['collectionSha256'] != digest(raw) or
            manifest['labelsGzSha256'] != digest(files['labels'])):
        raise ValueError('protocol, fit, or teacher identity mismatch')
    pool = select(read_groups(raw))
    if digest('\n'.join(row['root'] for row in pool).encode()) != manifest['sampleIdSha256']:
        raise ValueError('unexpected sampled roots')
    exclusions = json.loads(files['excluded'])['excludedGroups']
    labels = [json.loads(line) for line in gzip.decompress(files['labels']).splitlines()]
    selection = []
    for row, label in zip(pool, labels, strict=True):
        if (row['group'], row['root']) != (label['group'], label['root']):
            raise ValueError('misaligned source root')
        if row['group'] in exclusions:
            continue
        for a, b in zip(row['children'], label['children'], strict=True):
            if a['uci'] != b['uci']:
                raise ValueError('misaligned sibling')
            a['sf11'] = b['teacher']
        selection.append(row)
    if len(selection) != len({r['group'] for r in selection}):
        raise ValueError('repeated game')
    return selection, fit['fits']['calibrated']['numerator'], {k: digest(v) for k, v in files.items()}


def as_uci(move):
    squares = [chess.square_name(chess.square_mirror(move[k])) for k in ('from', 'to')]
    return ''.join(squares) + (move.get('promotion') or '').lower()


def collect(rows, modules, numerator):
    args = ['node', str(ROOT / 'tools/eval_pipeline/host.mjs'),
            '--loader', str(ROOT / 'assets/wasm-engine.js'), '--rules', str(ROOT / 'assets/engine.js')]
    for model, filename in zip(MODEL_IDS, modules, strict=True):
        args.extend(['--wasm', model + '=' + str(filename)])
    with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as host:
        number = 0

        def request(op, **fields):
            nonlocal number
            number += 1
            payload = dict(id=number, op=op, **fields)
            host.stdin.write(json.dumps(payload) + '\n')
            host.stdin.flush()
            return response_result(payload, json.loads(host.stdout.readline()))

        info = request('info')
        identities = {k: v['sha256'] for k, v in info['engines'].items()}
        if identities != {k: digest(v.read_bytes()) for k, v in zip(MODEL_IDS, modules)}:
            raise ValueError('loaded module differs from input')
        records = []
        for row in rows:
            replay = request('replay', moves=row['prefixUci'])
            root = chess.Board(row['fen'])
            if chess.Board(replay['fen']).fen() != root.fen():
                raise ValueError('JS move history and source disagree')
            sign = 1 if root.turn == chess.WHITE else -1
            for child in row['children']:
                after = root.copy()
                after.push_uci(child['uci'])
                if after.fen() != child['fen']:
                    raise ValueError('child position mismatch')
                for model, field in zip(MODEL_IDS, (*MODEL_FIELDS, numerator)):
                    static = request('evaluate', engine=model, fen=child['fen'])
                    if sign * static['score'] != integer_score(child, field) or static['scorePov'] != 'white':
                        raise ValueError(f'static model/scale or POV mismatch: {model}')
                    for depth in DEPTHS:
                        found = request('root', engine=model, fen=replay['fen'], historyFens=replay['historyFens'],
                                        uci=child['uci'], maxDepth=depth, nodeLimit=NODES, quiesce=True,
                                        timeMs=0, pvLen=depth)
                        pv = [as_uci(move) for move in found['pv']]
                        ok = found['complete']
                        if (found['scorePov'] != 'white' or found['uci'] != child['uci'] or
                                not 0 < found['nodes'] <= NODES or found['qnodes'] > found['nodes']):
                            raise ValueError('invalid exact-root result')
                        if ok:
                            if found['depth'] != depth or not pv or pv[0] != child['uci']:
                                raise ValueError('incomplete reported as complete')
                            board = root.copy()
                            for uci in pv:
                                board.push_uci(uci)
                        elif pv or found['nodes'] != NODES or found['stopReason'] != 'node-limit':
                            raise ValueError('unexplained incompletion')
                        records.append(dict(group=row['group'], root=row['root'], move=child['uci'],
                                            model=model, depth=depth, complete=ok, nodes=found['nodes'],
                                            qnodes=found['qnodes'], pv=pv,
                                            moverScore=sign * found['score'] if ok else None))
        host.stdin.close()
        if host.wait() != 0:
            raise ValueError('host failed')
    return records, {'modulesSha256': identities, 'nodeVersion': info['nodeVersion'],
                     'loaderSha256': info['loaderSha256'], 'rulesSha256': info['rulesSha256'],
                     'hostSha256': digest((ROOT / 'tools/eval_pipeline/host.mjs').read_bytes())}


def measures(row, score, label):
    children = row['children']
    chosen = min(children, key=lambda c: (-score[c['uci']], c['uci']))
    best = max(c[label] for c in children)
    clip = lambda x: max(-2000, min(2000, x))
    regret = clip(best) - clip(chosen[label])
    return {'regretCp': regret, 'severe150Rate': int(regret >= 150), 'topAgreement': int(chosen[label] == best)}


def summarize(rows, numerator, records):
    lookup = {(r['root'], r['move'], r['depth'], r['model']): r for r in records}
    expected = sum(len(r['children']) for r in rows) * len(DEPTHS) * len(MODEL_IDS)
    if len(records) != expected or len(lookup) != expected:
        raise ValueError('wrong search schedule coverage')
    result = {}
    for depth in DEPTHS:
        complete_children = Counter(r['model'] for r in records if r['depth'] == depth and r['complete'])
        completed = {m: {r['root'] for r in rows if all(
            lookup[r['root'], c['uci'], depth, m]['complete'] for c in r['children'])} for m in MODEL_IDS}
        common = set.intersection(*completed.values())
        by_teacher = {}
        for label, name in [('sf11', 'stockfish11'), ('teacher', 'chatarunga')]:
            groups, summary = {}, {}
            for model, field in zip(MODEL_IDS, (*MODEL_FIELDS, numerator)):
                for searched in (False, True):
                    key = ('searched-' if searched else 'static-') + model
                    outcomes = {}
                    for row in rows:
                        if row['root'] not in common:
                            continue
                        scores = {c['uci']: lookup[row['root'], c['uci'], depth, model]['moverScore']
                                  if searched else integer_score(c, field) for c in row['children']}
                        outcomes[row['group']] = measures(row, scores, label)
                    summary[key] = {k: fmean(v[k] for v in outcomes.values())
                                    for k in ('regretCp', 'severe150Rate', 'topAgreement')}
                    groups[key] = {g: val['regretCp'] for g, val in outcomes.items()}
            deltas = {}
            for model in MODEL_IDS:
                search = groups['searched-' + model]
                deltas[model] = {'vsSearchedHce': regret_interval(groups['searched-hce'], search),
                                 'vsOwnStatic': regret_interval(groups['static-' + model], search)}
            by_teacher[name] = {'choices': summary, 'pairedRegretCp': deltas}
        result[str(depth)] = {'completeChildren': dict(complete_children),
                              'completeRoots': {m: len(r) for m, r in completed.items()},
                              'commonCompleteRoots': len(common), 'byTeacher': by_teacher}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in MODEL_IDS:
        parser.add_argument(name, type=Path, help=f'{name} production ABI-v2 WASM')
    parser.add_argument('raw', type=Path)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    rows, numerator, inputs_sha = inputs()
    records, executions = collect(rows, [getattr(args, m) for m in MODEL_IDS], numerator)
    write_jsonl(args.raw, records)
    result = {'schema': 'chessy.robustness.search-decisions.v1', 'inputsSha256': inputs_sha,
              'scriptSha256': digest(Path(__file__).read_bytes()),
              'recordsSha256': digest(args.raw.read_bytes()), 'runtime': executions,
              'fittedNumerator': numerator, 'denominator': 16, 'roots': len(rows),
              'children': sum(len(r['children']) for r in rows), 'calls': len(records),
              'nodes': sum(r['nodes'] for r in records), 'depths': summarize(rows, numerator, records)}
    with args.report.open('x') as stream:
        stream.write(json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + '\n')


if __name__ == '__main__':
    main()
