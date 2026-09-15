#!/usr/bin/env python3
"""Opening preconditions fail before any sealed-role loader call."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
P=Path(__file__).parent
spec=importlib.util.spec_from_file_location('hybrid_test_v1',P/'hybrid-test-v1.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TestOpening(unittest.TestCase):
    def setUp(self):
        self.rules=json.loads((P.parent.parent/'eval/training/hybrid-test-v1.json').read_text())
        # A synthetic outer report with all required guard fields, no source rows.
        q={'rows':2374,'crossEntropy':.39,'teacherCpMae':10.,'teacherCpRmse':12.,'p99AbsoluteCpError':20.}
        q['byPhase']={p:{'rows':700,'crossEntropy':.39} for p in m.util.PHASES}
        base=copy.deepcopy(q);base['crossEntropy']=.4
        self.decision={'config':self.rules['config'],'finalBinarySha256':self.rules['modelBinarySha256'],'selectionUsesOuter':False}
        self.summary={'schema':'chessy.hybrid-screen.v1b','testEligible':True,'stopReasons':[],'testOpened':False,'contractSha256':self.rules['screenContractSha256'],
                      'decision':self.decision,'inherited':{'final':{'binary':self.rules['modelBinarySha256']}},'outer':{'numericalStopReasons':[],
                      'comparators':{'shipped-hce':base,'frozen-expanded-hce':base},'models':{self.rules['config']['id']:{'config':self.rules['config'],'quality':q,
                      'checks':{'rows':2374,'integerMismatches':0,'maximumAbsFloatDifferenceCp':.8,'meanAbsFloatDifferenceCp':.2,'maximumAbsoluteScoreCp':2000}}}}}
    def test_valid_synthetic_frozen_receipt(self):m.validate_frozen(self.summary,self.decision,self.rules)
    def test_mutated_guard_config_and_model_rejected(self):
        for mutation in ('pass','quality','config','model','nonfinite','checks'):
            s=copy.deepcopy(self.summary);d=s['decision'];candidate=s['outer']['models'][self.rules['config']['id']]
            if mutation=='pass':s['testEligible']=False
            if mutation=='quality':candidate['quality']['crossEntropy']=.41
            if mutation=='config':d['config']['lo']=5
            if mutation=='model':d['finalBinarySha256']='0'*64
            if mutation=='nonfinite':candidate['quality']['crossEntropy']=float('nan')
            if mutation=='checks':candidate['checks']['integerMismatches']=1
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):m.validate_frozen(s,d,self.rules)
    def test_legacy_nested_marker_prevents_loader(self):
        with tempfile.TemporaryDirectory() as n:
            root=Path(n);state=root/'.research-state';legacy=root/'prior';state.mkdir();(legacy/'old-contract').mkdir(parents=True)
            (legacy/'old-contract'/'test-opened.json').write_text('{}')
            rules={**self.rules,'priorStateRoots':[str(legacy)]}
            with patch.object(m,'ROOT',root),patch.object(m,'implementation',return_value=(rules,{},'head')),patch.object(m.data_io,'load_role') as loader:
                with self.assertRaises(FileExistsError):m.run(root,root,root)
                loader.assert_not_called()
    def test_mutated_summary_bytes_prevent_loader(self):
        with tempfile.TemporaryDirectory() as n:
            root=Path(n);(root/'.research-state').mkdir();(root/'selection.json').write_text('tampered')
            rules={**self.rules,'priorStateRoots':[]}
            def pinned(*args):m.util.read_exact(root/'selection.json',self.rules['screenArtifacts']['selection.json'])
            with patch.object(m,'ROOT',root),patch.object(m,'implementation',return_value=(rules,{},'head')),patch.object(m,'authenticate_frozen',side_effect=pinned),patch.object(m.data_io,'load_role') as loader:
                with self.assertRaises(ValueError):m.run(root,root,root)
                loader.assert_not_called()
    def test_completed_receipt_schema_not_opening_marker_schema(self):
        self.assertEqual(m.receipt_header({'schema':'chessy.hybrid-test-opening.v1','role':'nnue-test'}),
                         {'schema':'chessy.hybrid-test.v1','role':'nnue-test'})
    def test_missing_prior_state_rejected(self):
        with tempfile.TemporaryDirectory() as n:
            with self.assertRaises(ValueError):m.check_markers([Path(n)/'missing'])
if __name__=='__main__':unittest.main()
