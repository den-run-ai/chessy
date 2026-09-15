#!/usr/bin/env python3
"""Adversarial audit regressions: selection leakage, role scope and signed ties."""
import copy
import importlib.util
import math
from pathlib import Path
import unittest
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('hybrid_audit',ROOT/'tools/training/audit-hybrid-v1.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)


def fixture():
    configs=[{'id':'a','kind':'hard','threshold':4},{'id':'b','kind':'hard','threshold':6}]
    def quality(ce):return {'crossEntropy':ce,'byPhase':{p:{'rows':100,'crossEntropy':.5} for p in audit.old.PHASES}}
    records={c['id']:{'config':c,'quality':quality(.45),'floatQuality':quality(.4 if c['id']=='b' else .5),'innerPhaseStopReasons':[]} for c in configs}
    return {'models':records,'comparators':{'shipped-hce':quality(.5)},'numericalStopReasons':[]},configs


class TestHybridIndependentAudit(unittest.TestCase):
    def test_signed_half_ties_white_not_stm_or_bankers(self):
        config={'kind':'smooth','lo':4,'hi':10}
        actual=audit.blend(np.array([-3,-1,1,3]),np.zeros(4,dtype=int),np.full(4,7),config)
        self.assertEqual(actual.tolist(),[-1,0,1,2])

    def test_numerically_equal_tie_uses_registered_order_not_float_loss(self):
        development,configs=fixture()
        winner,stops=audit.select(development,configs)
        self.assertEqual(winner,configs[0]);self.assertEqual(stops,[])
        development['models']['b']['quality']['crossEntropy']=math.nextafter(.45,0)
        self.assertEqual(audit.select(development,configs)[0],configs[1])

    def test_bad_unselected_model_rejects_whole_screen(self):
        development,configs=fixture()
        development['models']['a']['quality']['crossEntropy']=.43
        development['numericalStopReasons']=['b:numerical-guard']
        winner,stops=audit.select(development,configs)
        self.assertIsNone(winner);self.assertEqual(stops,['b:numerical-guard'])

    def test_phase_coverage_and_exact_one_percent_boundary(self):
        development,configs=fixture();base=development['comparators']['shipped-hce']
        candidate=copy.deepcopy(base);candidate['byPhase']['endgame']['crossEntropy']=.505
        self.assertEqual(audit.phase_guard(base,candidate),[])
        candidate['byPhase']['endgame']['crossEntropy']=math.nextafter(.505,1)
        self.assertEqual(audit.phase_guard(base,candidate),['endgame-CE-guard'])
        candidate['byPhase']['endgame']['rows']=99
        self.assertEqual(audit.phase_guard(base,candidate),['endgame-coverage'])

    def test_missing_extra_or_nonfinite_candidate_rejected(self):
        for mutate in (lambda d:d['models'].pop('b'),lambda d:d['models'].update(c=copy.deepcopy(d['models']['b'])),
                       lambda d:d['models']['a']['quality'].update(crossEntropy=float('nan'))):
            development,configs=fixture();mutate(development)
            with self.assertRaises(AssertionError):audit.select(development,configs)

    def test_recorded_guard_cannot_suppress_low_loss_phase_failure(self):
        development,configs=fixture()
        development['models']['a']['quality']['byPhase']['endgame']['rows']=99
        with self.assertRaisesRegex(AssertionError,'inner phase guard'):audit.select(development,configs)
        development['models']['a']['innerPhaseStopReasons']=['endgame-coverage']
        self.assertEqual(audit.select(development,configs)[0],configs[1])

    def test_only_frozen_candidate_on_outer(self):
        _,configs=fixture();winner=configs[0]
        for models in ({'b':{'config':configs[1]}},{'a':{'config':winner},'b':{'config':configs[1]}},{'a':{'config':configs[1]}}):
            with self.assertRaises(AssertionError):audit.require_single_outer({'outer':{'models':models}},winner)
        with self.assertRaises(AssertionError):audit.require_single_outer({'outer':{'models':{}}},None)
        audit.require_single_outer({'outer':{'models':{'a':{'config':winner}}}},winner)

    def test_sealed_role_rejected_before_entry_access(self):
        class ForbiddenDictionary(dict):
            def __getitem__(self,key):raise RuntimeError('label metadata was accessed')
        for role in ('nnue-test','hce-validation','hce-test'):
            with self.assertRaisesRegex(AssertionError,'sealed or foreign role'):audit.role_entry(ForbiddenDictionary(),role)

    def test_material_phase_differs_from_piece_count(self):
        # Twelve pawns plus two kings remains phase0; two rooks plus two kings is phase4.
        fens=['4k3/pppppp2/8/8/8/8/PPPPPP2/4K3 w - - 0 1','r3k3/8/8/8/8/8/8/R3K3 b - - 0 1']
        self.assertEqual(audit.calc.phase_values(fens).tolist(),[0,4])

if __name__=='__main__':unittest.main()
