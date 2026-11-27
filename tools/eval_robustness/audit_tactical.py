"""Re-score the frozen model on previously excluded, exactly scored tactical roots.

Run as python -m tools.eval_robustness.audit_tactical EXTRACTED_EVIDENCE_DIRECTORY.
The argument is the extracted chessy-sparse-pesto-data-and-evidence archive.
"""
import argparse
from collections import Counter
import gzip
import json
from pathlib import Path
import subprocess
import tempfile

import chess
import numpy as np

from tools.sparse_eval.label_ood import RULES, admit_label
from tools.sparse_eval.pipeline import authenticated_bytes, sha


ROOT = Path(__file__).resolve().parents[2]
OLD = ROOT / 'eval/sparse-pesto-v1'
REPLICATES = 4000
SEED = 20261127
METRICS = ('maeCp', 'rmseCp', 'p95AbsCp', 'p99AbsCp', 'signAccuracyPercent')


def recover_rows(archive, manifest):
    files = {item['path']: item for item in manifest['files']}
    directory = archive / 'data/ood-labels-v1'
    labels = authenticated_bytes(directory, files['labels.jsonl']).splitlines()
    trace_data = authenticated_bytes(directory, files['traces.jsonl.gz'])
    traces = gzip.decompress(trace_data).splitlines(keepends=True)
    rules = dict(RULES, requireQuietTeacherFirstMove=False)
    if manifest['rules'] != RULES or len(labels) != RULES['selectedRows']:
        raise ValueError('unexpected OOD registration')
    games, families, exclusions, admitted = set(), set(), Counter(), []
    for i, (label_bytes, trace_bytes) in enumerate(zip(labels, traces, strict=True)):
        row, trace = json.loads(label_bytes), json.loads(trace_bytes)
        if (row['oodIndex'] != i or trace['oodIndex'] != i or
                sha(trace_bytes) != row['traceSha256'] or
                row['sourceGameId'] in games or row['family'] in families):
            raise ValueError(f'OOD trace join or independence mismatch at row {i}')
        games.add(row['sourceGameId'])
        families.add(row['family'])
        lines = [event['line'] for event in trace['events'] if event['direction'] == 'out']
        label, reason = admit_label(row, lines, rules)
        if reason:
            if reason != row['exclusion'] or row['teacher'] is not None:
                raise ValueError(f'non-tactical exclusion changed at row {i}')
            exclusions[reason] += 1
            continue
        board = chess.Board(row['fen'])
        move = chess.Move.from_uci(label['bestmove'])
        tactical = bool(board.is_capture(move) or board.gives_check(move) or move.promotion)
        expected_exclusion = 'tactical-teacher-first-move' if tactical else None
        expected_teacher = None if tactical else label
        if row['exclusion'] != expected_exclusion or row['teacher'] != expected_teacher:
            raise ValueError(f'original teacher or exclusion mismatch at row {i}')
        admitted.append((row, label['cpWhite'], 'tactical' if tactical else 'quiet'))
    return admitted, exclusions


def metrics(teacher, scores):
    errors = scores - teacher
    absolute = np.abs(errors)
    return np.stack([absolute.mean(axis=-1), np.sqrt(np.square(errors).mean(axis=-1)),
                     np.quantile(absolute, .95, axis=-1), np.quantile(absolute, .99, axis=-1),
                     (np.sign(scores) == np.sign(teacher)).mean(axis=-1) * 100], axis=-1)


def summarize(rows, scores, cohort):
    indices = [i for i, (_, _, group) in enumerate(rows) if group == cohort]
    teacher = np.array([rows[i][1] for i in indices], dtype=np.float64)
    hce, full = scores[indices, :2].T
    phases = np.array([rows[i][0]['phaseBucket'] for i in indices])
    groups = [np.flatnonzero(phases == phase) for phase in sorted(set(phases))]
    hce_metrics, full_metrics = metrics(teacher, hce), metrics(teacher, full)
    rng = np.random.default_rng(SEED)
    differentials, relative = [], []
    for start in range(0, REPLICATES, 32):
        count = min(32, REPLICATES - start)
        sampled = np.concatenate([rng.choice(g, (count, len(g))) for g in groups], axis=1)
        base = metrics(teacher[sampled], hce[sampled])
        candidate = metrics(teacher[sampled], full[sampled])
        differentials.extend(candidate - base)
        relative.extend(100 * (1 - candidate[:, 0] / base[:, 0]))
    bands = np.quantile(differentials, [.025, .975], axis=0).T
    return {
        'rows': len(indices),
        'byPhase': dict(Counter(phases)),
        'hce': dict(zip(METRICS, hce_metrics)),
        'full': dict(zip(METRICS, full_metrics)),
        'fullMinusHce': dict(zip(METRICS, full_metrics - hce_metrics)),
        'fullMinusHce95Interval': dict(zip(METRICS, bands.tolist())),
        'relativeMaeReductionPercent': 100 * (1 - full_metrics[0] / hce_metrics[0]),
        'relativeMaeReductionPercent95Interval': np.quantile(relative, [.025, .975]).tolist(),
    }


def audit(archive):
    old = json.loads((OLD / 'OOD-EVAL-RESULTS.json').read_bytes())
    source = (archive / 'data/ood-labels-v1/manifest.json').read_bytes()
    if sha(source) != old['labelsManifestSha256']:
        raise ValueError('unexpected archived manifest')
    manifest = json.loads(source)
    rows, exclusions = recover_rows(archive, manifest)
    model = (OLD / 'fit/full.i16le').read_bytes()
    if sha(model) != old['weightsSha256'] or old['selected'] != 'full':
        raise ValueError('the old frozen model changed')
    binary = authenticated_bytes(archive / 'ood-evaluation-v1', old['native'])
    with tempfile.TemporaryDirectory() as temp:
        executable, weights = Path(temp) / 'runtime', Path(temp) / 'full.i16le'
        executable.write_bytes(binary)
        executable.chmod(0o500)
        weights.write_bytes(model)
        fens = ''.join(row['fen'] + '\n' for row, _, _ in rows)
        output = subprocess.run([executable, 'eval', weights], input=fens.encode(),
                                capture_output=True, check=True).stdout
    lines = output.splitlines(keepends=True)
    controls = b''.join(line for line, row in zip(lines, rows, strict=True) if row[2] == 'quiet')
    if sha(controls) != old['nativeScores']['sha256']:
        raise ValueError('quiet reference scores differ from original audit')
    scores = np.array([list(map(int, line.split())) for line in lines], dtype=np.int64)
    if scores.shape != (len(rows), 3) or not np.array_equal(scores[:, 1] - scores[:, 0], scores[:, 2]):
        raise ValueError('invalid baseline / candidate / residual output')
    return {
        'schema': 'chessy.eval-robustness.frozen-tactical-audit.v1',
        'sourceManifestSha256': sha(source), 'labelsAndTraces': manifest['files'][:2],
        'teacherSha256': manifest['engineSha256'], 'weightsSha256': sha(model),
        'nativeSha256': sha(binary), 'allScoredNativeOutputSha256': sha(output),
        'quietNativeOutputSha256': sha(controls), 'originalSelectedRows': RULES['selectedRows'],
        'remainingExclusions': dict(exclusions), 'scoredRows': len(rows),
        'selection': 'All rows satisfying the original SF18 exact-centipawn admission after relaxing only the quiet best-move rule.',
        'effects': 'Full minus HCE. Errors use centipawns and sign accuracy uses percentage points. Relative MAE reduction is positive when the full model lowers error.',
        'uncertainty': f'Paired row bootstrap within each phase, {REPLICATES} replicates, seed {SEED}. Nominal pointwise percentile intervals. Each row is a distinct game and structural family. Opening and player dependence is unmodeled.',
        'quiet': summarize(rows, scores, 'quiet'), 'tactical': summarize(rows, scores, 'tactical'),
        'scope': 'Historical, retrospective static scores. All roots were outside check and the move played in the source game was quiet. No fitting, new model selection, or playing-strength measurement.',
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    args = parser.parse_args()
    print(json.dumps(audit(args.archive), sort_keys=True, indent=2, allow_nan=False))
