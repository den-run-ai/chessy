"""Independent deeper searches on four previously exposed move disagreements."""
import argparse
import gzip
import json
from pathlib import Path

import chess
import chess.engine

from .fit import digest
from .search_decisions import EVIDENCE, inputs


PROTOCOL = EVIDENCE / 'search-decisions-deep-protocol.json'
PROTOCOL_SHA = 'bef868d6a64592a7a02e85e2eb615a9b4432603388fc1e02f3c1361fbafff06d'


def investigate(executable, row, move, limit):
    board = chess.Board()
    for token in row['prefixUci']:
        board.push_uci(token)
    if board.fen() != row['fen']:
        raise ValueError('source history mismatch')
    root_color = board.turn
    board.push_uci(move)
    reports = []
    reported_nodes = 0
    with chess.engine.SimpleEngine.popen_uci(str(executable.resolve())) as engine:
        engine.configure({'Hash': 16, 'Threads': 1})
        with engine.analysis(board, limit, game=object()) as analysis:
            for info in analysis:
                reported_nodes = max(reported_nodes, info.get('nodes', 0))
                if 'score' not in info or not info.get('pv'):
                    continue
                replay = board.copy(stack=False)
                pv = []
                for reply in info['pv']:
                    if reply not in replay.legal_moves:
                        raise ValueError('illegal teacher PV')
                    replay.push(reply)
                    pv.append(reply.uci())
                score = info['score'].pov(root_color)
                # UCI bounds are in the child's side-to-move perspective.
                bound = 'upper' if info.get('lowerbound') else 'lower' if info.get('upperbound') else 'unbounded'
                reports.append({'scoreCp': score.score(), 'mateIn': score.mate(), 'bound': bound,
                                'depth': info['depth'], 'seldepth': info.get('seldepth'),
                                'nodes': info['nodes'], 'pv': pv})
            best = analysis.wait().move
        engine_id = engine.id
    final = reports[-1] if reports else None
    exact = next((r for r in reversed(reports) if r['bound'] == 'unbounded'), None)
    bestmove = best.uci() if best else None
    usable = bool(final and final['bound'] == 'unbounded' and bestmove == final['pv'][0])
    if limit.depth is not None and usable:
        usable = final['depth'] >= limit.depth or final['mateIn'] is not None
    return {'root': row['root'], 'group': row['group'], 'fen': row['fen'], 'move': move,
            'fullHistoryUci': [*row['prefixUci'], move], 'rootMover': 'white' if root_color else 'black',
            'engineId': engine_id, 'requested': {'nodes': limit.nodes, 'depth': limit.depth},
            'reportedNodes': reported_nodes, 'bestmove': bestmove, 'comparableFinal': usable,
            'final': final, 'lastUnbounded': exact, 'reports': reports}


def score_summary(report):
    return {k: report[k] for k in ('scoreCp', 'mateIn', 'bound', 'depth', 'nodes', 'pv')}


def compare(searches):
    if not all(s['comparableFinal'] for s in searches):
        return {'choice': 'unresolved', 'finalReports': [s['final'] for s in searches]}
    hce, fitted = (s['final'] for s in searches)
    def comparable(report):
        if report['mateIn'] is None:
            return chess.engine.Cp(report['scoreCp'])
        return chess.engine.Mate(report['mateIn'])
    a, b = comparable(hce), comparable(fitted)
    return {'choice': 'fitted' if b > a else 'hce' if a > b else 'tie',
            'fittedMinusHceCp': None if a.is_mate() or b.is_mate() else b.score() - a.score(),
            'hceMoveScore': score_summary(hce), 'fittedMoveScore': score_summary(fitted)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('stockfish', type=Path)
    p.add_argument('chatarunga', type=Path)
    p.add_argument('transcripts', type=Path)
    p.add_argument('output', type=Path)
    args = p.parse_args()
    protocol = PROTOCOL.read_bytes()
    if digest(protocol) != PROTOCOL_SHA:
        raise ValueError('registered protocol changed')
    protocol = json.loads(protocol)
    engines = {'stockfish11': args.stockfish, 'chatarunga': args.chatarunga}
    actual = {key: digest(path.read_bytes()) for key, path in engines.items()}
    if list(actual.values()) != protocol['teachers']:
        raise ValueError('teacher identity mismatch')
    pool, _, hashes = inputs()
    raw, results = [], {}
    for prefix, hce, fitted in protocol['rootPrefixAndHceFittedMoves']:
        row, = [r for r in pool if r['root'].startswith(prefix)]
        if not {hce, fitted} <= {c['uci'] for c in row['children']}:
            raise ValueError('unknown alternative')
        results[prefix] = {'fen': row['fen'], 'hceMove': hce, 'fittedMove': fitted, 'teachers': {}}
        for name, exe in engines.items():
            def evaluate_pair(limit):
                records = [investigate(exe, row, move, limit) for move in (hce, fitted)]
                raw.extend(dict(record, teacher=name) for record in records)
                return records
            primary = evaluate_pair(chess.engine.Limit(nodes=1_000_000))
            pair = primary
            kind = 'oneMillionNodes'
            if not all(s['comparableFinal'] for s in primary):
                kind = 'fixedDepth17'
                pair = evaluate_pair(chess.engine.Limit(depth=17))
            results[prefix]['teachers'][name] = {'used': kind, 'primaryUsable': [s['comparableFinal'] for s in primary],
                                                **compare(pair)}
    content = ''.join(json.dumps(r, sort_keys=True, separators=(',', ':')) + '\n' for r in raw).encode()
    with args.transcripts.open('xb') as f, gzip.GzipFile(filename='', fileobj=f, mode='wb', mtime=0) as out:
        out.write(content)
    report = {'schema': 'chessy.robustness.exposed-disagreement-adjudication.v1', 'protocolSha256': PROTOCOL_SHA,
              'scriptSha256': digest(Path(__file__).read_bytes()), 'teacherSha256': actual,
              'collectionSha256': hashes['collection'], 'recordSha256': digest(args.transcripts.read_bytes()),
              'independentTeacherSearches': len(raw), 'totalReportedNodes': sum(s['reportedNodes'] for s in raw),
              'results': results}
    with args.output.open('x') as out:
        out.write(json.dumps(report, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
