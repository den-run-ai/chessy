#!/usr/bin/env python3
"""Mutation checks for independent python-chess replay of fixed-node evidence."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fixed',ROOT/'tools/training/audit-hybrid-fixed-node-v1.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)


class IndependentReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as directory:
            fixture=Path(directory)/'fixture.json'
            env={**os.environ,'CHESSY_EXPORT_FIXED_NODE_FIXTURE':str(fixture)}
            subprocess.run([os.environ.get('CODEX_PRIMARY_RUNTIME_NODE','node'),str(ROOT/'test/training/hybrid-fixed-node-v1.test.js')],env=env,check=True,capture_output=True)
            cls.fixture=json.loads(fixture.read_text())

    def replay(self,mutate=None):
        f=copy.deepcopy(self.fixture)
        if mutate:mutate(f['rows'])
        task=f['task'];r=f['r']
        flat={'taskId':task['taskId'],'openingIndex':task['opening']['index'],'openingName':task['opening']['name'],
              'prefixUci':task['opening']['prefixUci'],'timeMs':0,'nodeLimit':16384,'candidateColor':task['candidateColor'],'maxPlies':2,'maxDepth':30}
        modules={'baseline':{'sha256':r['modules']['shipped']['sha256']},'candidate':{'sha256':r['modules']['hybrid']['sha256']}}
        return audit.audit_game(f['rows'],flat,modules)

    def test_exact_cross_language_fixture(self):
        result=self.replay();self.assertEqual(result['reason'],'ply-cap');self.assertEqual(result['searchedPlies'],2)

    def test_tampering_rejected(self):
        mutations={
            'unequal nodes':lambda r:r[1]['requested'].update(nodeLimit=16385),
            'hidden time cap':lambda r:r[1]['requested'].update(timeMs=20),
            'node overrun':lambda r:r[1]['result'].update(nodes=16385),
            'false node exhaustion':lambda r:r[1]['result'].update(nodes=16383),
            'unexpected time stop':lambda r:r[1]['result'].update(stopReason='time-limit'),
            'history loss':lambda r:r[1].update(positions={}),
            'illegal move':lambda r:r[1]['result'].update(moveUci='e1e8'),
            'invented result':lambda r:r[-1].update(candidateScore=1),
            'premature end':lambda r:r.pop(2),
            'missing footer':lambda r:r.pop(),
        }
        for name,mutation in mutations.items():
            with self.subTest(name=name),self.assertRaises(audit.old.AuditError):self.replay(mutation)


if __name__=='__main__':unittest.main()
