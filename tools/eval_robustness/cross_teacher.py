"""Label held-out siblings with Stockfish 11 and compare their decision regret."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
from statistics import fmean, median

import chess
import chess.engine

from .fit import digest, evaluate, fen_key, held_out, position_keys, read_groups, regret_interval


ROOT = Path(__file__).resolve().parents[2]
PROTOCOL = ROOT / 'eval/eval-robustness-v1/cross-teacher-protocol.json'
NODES = 30_000


def priority(identifier):
    return hashlib.sha256(b'sf11-cross-v1\0' + identifier.encode()).hexdigest()


def select(groups):
    train = {g: rows for g, rows in groups.items() if not held_out(g)}
    train_positions = position_keys(train, 'roots') | position_keys(train, 'children')
    sample = []
    for group in sorted((g for g in groups if held_out(g)), key=priority):
        for row in sorted(groups[group], key=lambda r: priority(r['root'])):
            boards = {fen_key(child['fen']) for child in [row, *row['children']]}
            if boards.isdisjoint(train_positions):
                sample.append(row)
                break
        if len(sample) == 100:
            break
    if not sample:
        raise ValueError('no independent held-out groups')
    return sample


def write_jsonl(path, rows):
    with path.open('xb') as f, gzip.GzipFile(filename='', fileobj=f, mode='wb', mtime=0) as out:
        for row in rows:
            out.write((json.dumps(row, sort_keys=True, separators=(',', ':')) + '\n').encode())


def label(engine, row, *, nodes=NODES):
    board = chess.Board()
    for uci in row['prefixUci']:
        board.push_uci(uci)
    if board.fen() != row['fen']:
        raise ValueError('root history mismatch')
    root_color = board.turn
    moves = []
    for child in row['children']:
        board.push_uci(child['uci'])
        if board.fen() != child['fen']:
            raise ValueError('child history mismatch')
        outcome = board.outcome()
        if outcome:
            value = 0 if outcome.winner is None else 3000 if outcome.winner == root_color else -3000
            score = {'teacher': value, 'terminal': outcome.termination.name, 'mate': 0 if value else None,
                     'depth': 0, 'nodes': 0, 'pv': []}
        else:
            # The node stop can interrupt an aspiration retry. Keep the latest
            # complete exact principal-variation score and log total search work.
            info = None
            total_nodes = 0
            with engine.analysis(board, chess.engine.Limit(nodes=nodes), game=object()) as analysis:
                for update in analysis:
                    total_nodes = max(total_nodes, update.get('nodes', 0))
                    if ('score' in update and update.get('pv') and not update.get('lowerbound')
                            and not update.get('upperbound')):
                        info = update
            if info is None:
                raise ValueError('no exact principal-variation score during node budget')
            value = info['score'].pov(root_color)
            score = {'teacher': max(-3000, min(3000, value.score(mate_score=3000))), 'mate': value.mate(),
                     'nodes': info['nodes'], 'totalNodesReported': total_nodes, 'depth': info['depth'], 'terminal': None,
                     'pv': [move.uci() for move in info['pv']]}
        moves.append({'uci': child['uci'], **score})
        board.pop()
    return {'group': row['group'], 'root': row['root'], 'children': moves}


def run_label(args, sample):
    if digest(args.engine.read_bytes()) != args.engine_sha256:
        raise ValueError('Stockfish binary hash mismatch')
    with chess.engine.SimpleEngine.popen_uci(str(args.engine.resolve())) as engine:
        if 'Stockfish 11 ' not in engine.id['name']:
            raise ValueError('expected Stockfish 11')
        engine.configure({'Hash': 16, 'Threads': 1})
        labels = [label(engine, row) for row in sample]
        engine_id = engine.id
    write_jsonl(args.labels, labels)
    return {'engineId': engine_id, 'executableSha256': args.engine_sha256, 'pythonChess': chess.__version__,
            'nodesRequested': NODES, 'threads': 1, 'hashMiB': 16}


def top_set(children):
    best = max(child['teacher'] for child in children)
    return {c['uci'] for c in children if c['teacher'] == best}


def report(sample, labels, alpha):
    corroborating = {}
    joint_tops = []
    counts = Counter()
    depths = []
    for row, label_row in zip(sample, labels, strict=True):
        if (row['group'], row['root']) != (label_row['group'], label_row['root']):
            raise ValueError('wrong label group/root')
        first = row['children']
        other = []
        for child, label_row_child in zip(first, label_row['children'], strict=True):
            if child['uci'] != label_row_child['uci']:
                raise ValueError('wrong label child move')
            other.append(dict(child, teacher=label_row_child['teacher']))
            counts['terminalLabels'] += int(label_row_child['terminal'] is not None)
            counts['mateLabelsIncludingTerminal'] += int(label_row_child['mate'] is not None)
            if not label_row_child['terminal']:
                # Check all recorded teacher replies against the actual child board.
                board = chess.Board(child['fen'])
                for uci in label_row_child['pv']:
                    board.push_uci(uci)
                counts['nodesReported'] += label_row_child['totalNodesReported']
                counts['exactInfoBeforeFinalUpdate'] += int(label_row_child['totalNodesReported'] > label_row_child['nodes'])
                depths.append(label_row_child['depth'])
        joint_tops.append(bool(top_set(first) & top_set(other)))
        corroborating[row['group']] = [dict(row, children=other)]
    primary = {r['group']: [r] for r in sample}
    out = {'counts': counts, 'nonterminalDepthMedian': median(depths),
           'teacherBestSetsIntersectRate': fmean(joint_tops)}
    for name, groups in [('stockfish11', corroborating), ('chatarungaSameRoots', primary)]:
        summaries, regret = {}, {}
        for method, model in [('hce', 'hce'), ('full', 'full'), ('noPawn', 'noPawn'), ('calibrated', alpha)]:
            summary, regret[method] = evaluate(groups, model)
            summaries[method] = summary['all']
        intervals = {m: regret_interval(regret['hce'], regret[m]) for m in ('full', 'noPawn', 'calibrated')}
        out[name] = {'heldOut': summaries, 'minusHceRegretCp': intervals}
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('collection', type=Path)
    p.add_argument('labels', type=Path)
    p.add_argument('manifest', type=Path)
    sub = p.add_subparsers(dest='action', required=True)
    lab = sub.add_parser('label')
    lab.add_argument('engine', type=Path)
    lab.add_argument('engine_sha256')
    summ = sub.add_parser('report')
    summ.add_argument('fit_report', type=Path)
    summ.add_argument('fit_exclusions', type=Path)
    summ.add_argument('output', type=Path)
    args = p.parse_args()
    raw = gzip.decompress(args.collection.read_bytes())
    sample = select(read_groups(raw))
    common = {'collectionSha256': digest(raw), 'sampleIdSha256': digest('\n'.join(r['root'] for r in sample).encode()),
              'roots': len(sample), 'children': sum(len(r['children']) for r in sample), 'protocolSha256': digest(PROTOCOL.read_bytes())}
    if args.action == 'label':
        engine = run_label(args, sample)
        with args.manifest.open('x') as f:
            json.dump({**common, **engine, 'labelsGzSha256': digest(args.labels.read_bytes())}, f, indent=2, sort_keys=True)
            f.write('\n')
    else:
        manifest = json.loads(args.manifest.read_bytes())
        if any(manifest[k] != v for k, v in common.items()) or digest(args.labels.read_bytes()) != manifest['labelsGzSha256']:
            raise ValueError('cross-teacher label provenance mismatch')
        fitted = json.loads(args.fit_report.read_bytes())
        exclusions = json.loads(args.fit_exclusions.read_bytes())
        if (fitted['collectionSha256'] != digest(args.collection.read_bytes())
                or exclusions['collectionSha256'] != fitted['collectionSha256']
                or fitted['exclusionsSha256'] != digest(args.fit_exclusions.read_bytes())):
            raise ValueError('fit, historical exclusions and collection do not match')
        alpha = fitted['fits']['calibrated']['numerator']
        labels = [json.loads(line) for line in gzip.decompress(args.labels.read_bytes()).splitlines()]
        # The historical overlap inventory was completed after labelling. Omit
        # every impacted source game before comparing model predictions.
        eligible = [(row, label_row) for row, label_row in zip(sample, labels, strict=True)
                    if row['group'] not in exclusions['excludedGroups']]
        if not eligible:
            raise ValueError('no eligible source groups remain')
        scored, scored_labels = zip(*eligible)
        results = report(scored, scored_labels, alpha)
        results['groupsLabelled'] = len(sample)
        results['groupsExcludedByFitInventory'] = len(sample) - len(eligible)
        results['groupsEvaluated'] = len(scored)
        results['childrenEvaluated'] = sum(len(r['children']) for r in scored)
        results['fitExclusionsSha256'] = fitted['exclusionsSha256']
        with args.output.open('x') as f:
            json.dump({**common, 'fitSha256': digest(args.fit_report.read_bytes()), 'scaleNumerator': alpha,
                       'scaleDenominator': 16, **results}, f, indent=2, sort_keys=True)
            f.write('\n')


if __name__ == '__main__':
    main()
