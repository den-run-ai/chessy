"""Independently verify the complete Medium replication and recompute its family interval."""
import argparse
from collections import Counter, defaultdict
import chess.pgn
import json
from pathlib import Path
from statistics import mean

from tools.eval_pipeline import games, frontier
from . import medium, medium_audit, medium_replication


def timed_scores(audit, pgn):
    base = audit['models']['base']
    candidate = audit['models']['candidate']
    if (base['sha256'],candidate['sha256']) != (medium.BASE,medium.CANDIDATE):
        raise ValueError('timed-game modules differ from Medium modules')
    games_by_source = defaultdict(dict)
    totals = Counter()
    with pgn.open() as f:
        while (h := chess.pgn.read_headers(f)) is not None:
            if sorted([h['White'],h['Black']]) != sorted([base['id'],candidate['id']]) or h['SearchLimit'] != '25ms/move':
                raise ValueError('unexpected 25ms game')
            is_white = h['White'] == candidate['id']
            outcome = h['Result']
            if outcome not in ('1-0','0-1','1/2-1/2') or is_white in games_by_source[h['SourceGameId']]:
                raise ValueError('missing result or duplicate 25ms color')
            score = .5 if outcome == '1/2-1/2' else int(is_white == (outcome == '1-0'))
            games_by_source[h['SourceGameId']][is_white] = score
            totals[score] += 1
    if any(len(pair)!=2 for pair in games_by_source.values()) or totals != {1:audit['wins'],.5:audit['draws'],0:audit['losses']}:
        raise ValueError('25ms standings do not reproduce the primary audit')
    return {g:mean(v.values()) for g,v in games_by_source.items()}


def paired_difference(medium_points, timed, families):
    if set(timed) != set(medium_points):
        raise ValueError('paired score comparison requires identical source openings')
    # The existing score bootstrap maps degenerate intervals to [0,1]. Use
    # the same scale by mapping [-1,1] differences to [0,1] and back.
    shifted = {g:(mean(medium_points[g]) - timed[g] + 1)/2 for g in medium_points}
    interval = band(shifted, families)[0]
    return {'difference':mean(mean(v) - timed[g] for g,v in medium_points.items()),
            'percentile95':[2*v - 1 for v in interval], 'timeMs':25,
            'scope':'Descriptive paired opening-family comparison. Both search budget and post-opening seed policy differ.'}


def band(scores, families):
    boot = {'timeControlsMs':[5000],'openingIds':list(scores),'clusterByOpening':families,
            'bootstrap':{'confidence':.95,'samples':10000,'seed':20261127}}
    bands, detail = frontier._bootstrap(boot,{5000:scores})
    return bands[5000], detail


def combine(path, timed_audit):
    medium_replication.verify_banks()
    joint = json.loads((path/'joint-registration.json').read_bytes())
    bank_path = medium.BANK.with_name('match-replication-openings.jsonl')
    rows = medium_replication.read_rows(bank_path)
    if joint['sourceBank'] != medium.digest_file(bank_path) or len(joint['registrations'])!=2:
        raise ValueError('incorrect joint registration')
    points, measurements = defaultdict(list), defaultdict(list)
    terminations, outcomes = Counter(), Counter()
    pgn = b''
    shards = []
    for s in range(2):
        root = path/f'shard-{s}'
        config = json.loads((root/'registration.json').read_bytes())
        if (medium.digest_file(root/'registration.json') != joint['registrations'][s] or config['replicationShard'] != s
                or config['selectedCpu'] != 3+s or config['replicationBankSha256'] != joint['sourceBank']
                or medium_replication.read_rows(root/'bank.jsonl') != rows[s::2]):
            raise ValueError('shard not bound to the correct schedule, CPU or bank')
        r = medium_audit.audit(root, measurements=measurements)
        shards.append({k:r[k] for k in ('registrationSha256','rawGzSha256','pgnSha256','games','searchedPlies','openingPliesReplayed')})
        pgn += (root/'games.pgn').read_bytes()
        for game in r['gameRows']:
            points[game['openingId']].append(game['candidatePoints'])
        terminations.update(r['termination'])
        outcomes.update(r['outcomes'])
    if len(points)!=128 or any(len(p)!=2 for p in points.values()):
        raise ValueError('missing paired outcomes')
    families = {row['sourceGameId']:row['ply4Family'] for row in rows}
    scores = {g:mean(points[g]) for g in families}
    interval, detail = band(scores, families)
    stats = {}
    d = medium_audit.distribution
    for side, obs in measurements.items():
        search, walls = zip(*obs)
        stats[side] = {'searches':len(search),'fullRequestMs':d(walls),'engineCallMs':d([r['engineCallMs'] for r in search]),
                       'completedDepth':d([r['depth'] for r in search]), 'completedDepthCounts':Counter(r['depth'] for r in search),
                       'depthZeroFallbacks':sum(r['depth']==0 for r in search),'stopReason':Counter(r['stopReason'] for r in search),
                       'totalNodes':sum(r['nodes'] for r in search),'quiescenceNodes':sum(r['qnodes'] for r in search)}
    # Keep raw shard PGNs intact; publish the joined PGN with a single final newline.
    pgn = pgn.rstrip(b'\n') + b'\n'
    timed_pgn = timed_audit.with_name('match-replication.pgn')
    timed = timed_scores(json.loads(timed_audit.read_bytes()), timed_pgn)
    return {'schema':'chessy.medium-product-replication.v1','games':256,'openings':128,'jointRegistrationSha256':medium.digest_file(path/'joint-registration.json'),
            'pgnSha256':games.sha(pgn),'targetScore':.55,'candidateScore':mean(scores.values()),'outcomes':outcomes,
            'clusterInterval95':interval,'uncertainty':detail,'termination':terminations,'shards':shards,'telemetry':stats,
            'searchedPlies':sum(x['searchedPlies'] for x in shards),'openingPliesReplayed':sum(x['openingPliesReplayed'] for x in shards),
            'pairedScores':scores, 'sameBank25msPgnSha256':medium.digest_file(timed_pgn),
            'mediumMinus25ms':paired_difference(points,timed,families),'productionEnabled':False}, pgn


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ['campaign','timed_audit','results','pgn']:
        parser.add_argument(key,type=Path)
    args = parser.parse_args()
    out, pgn = combine(args.campaign.resolve(), args.timed_audit)
    games.write(args.results,(json.dumps(out,indent=2,sort_keys=True)+'\n').encode())
    games.write(args.pgn,pgn)
