#!/usr/bin/env python3
"""Mutations are independently rejected by python-chess; no engine searches."""
import importlib.util,json,os,subprocess,tempfile,copy
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('time_audit',ROOT/'tools/training/audit-hybrid-equal-time-200ms-v1.py');A=importlib.util.module_from_spec(spec);spec.loader.exec_module(A)
pairs=[0,.25,.5,.75,1]*4
expected=json.loads(subprocess.check_output(['node','-e',"const s=require('./test/match-stats').clusterStats([0,.25,.5,.75,1,0,.25,.5,.75,1,0,.25,.5,.75,1,0,.25,.5,.75,1].map((pair,op)=>({op,pair})));process.stdout.write(JSON.stringify(s));"],cwd=ROOT))
mean,sd,lower=A.paired_stats(pairs)
assert abs(mean-expected['mean'])<1e-12 and abs(sd-expected['sd'])<1e-12 and abs(lower-expected['lo95'])<1e-12
assert sd>0 and lower<mean
with tempfile.TemporaryDirectory() as directory:
    fixture=Path(directory)/'fixture.json'
    env={**os.environ,'CHESSY_EXPORT_TIME200_FIXTURE':str(fixture)}
    subprocess.run(['node','test/training/hybrid-equal-time-200ms-v1.test.js'],cwd=ROOT,env=env,check=True,stdout=subprocess.PIPE)
    f=json.loads(fixture.read_text());t=f['task'];p=f['r']['protocol']
    task={'taskId':t['taskId'],'openingIndex':t['opening']['index'],'openingName':t['opening']['name'],'prefixUci':t['opening']['prefixUci'],'timeMs':200,'candidateColor':t['candidateColor'],'maxPlies':p['maxSearchedPlies'],'maxDepth':30,'nodeLimit':0}
    modules={'baseline':{'sha256':f['r']['modules']['shipped']['sha256']},'candidate':{'sha256':f['r']['modules']['hybrid']['sha256']}}
    assert A.audit_game(f['rows'],task,modules)['candidateScore']==.5
    mutations=[
        lambda rows:rows[1]['requested'].update(timeMs=20),
        lambda rows:rows[1]['requested'].update(nodeLimit=16384),
        lambda rows:rows[1]['result'].update(stopReason='node-limit'),
        lambda rows:rows[1].update(elapsedMs=199.5),
        lambda rows:rows[1].update(positions={}),
        lambda rows:rows[-1].update(candidateScore=1),
        lambda rows:rows[1]['result']['move'].update(capture=None),
    ]
    for mutate in mutations:
        rows=copy.deepcopy(f['rows']);mutate(rows)
        try:A.audit_game(rows,task,modules)
        except A.old.AuditError:pass
        else:raise AssertionError('mutation unexpectedly accepted')
print('1 valid replay and7independent200ms mutations passed; zero engine searches')
