"""Freeze both Medium replication schedules before either shard searches."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from . import medium
from tools.eval_pipeline import games


def read_rows(path):
    return [json.loads(line) for line in path.read_bytes().splitlines()]


def verify_banks():
    initial = read_rows(medium.BANK)
    replication = read_rows(medium.BANK.with_name('match-replication-openings.jsonl'))
    if len(initial) != 32 or len(replication) != 128:
        raise ValueError('incorrect source bank sizes')
    for key in ('sourceGameId','ply8Family','rootCluster','rootFamily'):
        values = {r[key] for r in replication}
        if len(values) != 128 or values & {r[key] for r in initial}:
            raise ValueError(f'replication overlaps initial bank by {key}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ('base','candidate','out'):
        parser.add_argument(arg,type=Path)
    parser.add_argument('--stage', choices=['all','freeze','play'],default='all')
    parser.add_argument('--shard', type=int,choices=[0,1])
    args = parser.parse_args()
    out = args.out.resolve()
    if args.stage == 'all':
        verify_banks()
        out.mkdir(parents=True,exist_ok=False)
        commands = [[sys.executable,'-m','tools.eval_robustness.medium_replication',str(args.base),str(args.candidate),
                     str(out),'--shard',str(s)] for s in range(2)]
        registrations = []
        for s, command in enumerate(commands):
            subprocess.run(command + ['--stage','freeze'], check=True)
            registrations.append(medium.digest_file(out/f'shard-{s}/registration.json'))
        root = {'protocol':'Second Medium study. All 128 games from the time-budget replication bank, both candidate colors = 256 played games. Independent of initial Medium bank, paired across budgets. Same r85 models and no-clock option/seed policy. Identical cap and family bootstrap. Two distinct CPU-affined processes. Retain every game and evaluate jointly once all 256 finish.',
                'registrations': registrations, 'targetScore':.55, 'cpus':[3,4], 'sourceBank':medium.digest_file(medium.BANK.with_name('match-replication-openings.jsonl'))}
        games.write(out/'joint-registration.json',games.encoded(root))
        print('Medium joint registration',medium.digest_file(out/'joint-registration.json'),flush=True)
        workers = [subprocess.Popen(command + ['--stage','play']) for command in commands]
        codes = [w.wait() for w in workers]
        if any(codes):
            raise RuntimeError('failed Medium replication shard')
    else:
        if args.shard is None:
            parser.error('shard required')
        s = args.shard
        os.sched_setaffinity(0,{3+s})
        shard = out/f'shard-{s}'
        if args.stage == 'freeze':
            medium.register(shard,args.base,args.candidate,replication_shard=s)
            return
        joint = json.loads((out/'joint-registration.json').read_bytes())
        if medium.digest_file(shard/'registration.json') != joint['registrations'][s]:
            raise ValueError('registration changed after joint freeze')
        config = json.loads((shard/'registration.json').read_bytes())
        for binding in config['files'].values():
            games.bound(shard,binding)
        if medium.digest_file(Path(medium.__file__)) != config['files']['medium.py']['sha256']:
            raise ValueError('active runner changed after registration')
        bank = {r['sourceGameId']:r for r in read_rows(shard/'bank.jsonl')}
        medium.play(shard, config, bank)


if __name__ == '__main__':
    main()
