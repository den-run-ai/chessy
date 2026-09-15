#!/usr/bin/env python3
"""Authored-only independent-audit mutations; no source data or fitting."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
import numpy as np

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('independent_v3',ROOT/'tools/training/audit-h4-v3.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
RULES=json.loads((ROOT/'eval/training/natural-nnue-h4-v3.json').read_text())


def quality(ce=.4,rows=200):
    return {'byPhase':{p:{'rows':rows,'crossEntropy':ce} for p in m.old.PHASES}}


def records():
    result=[]
    for config in RULES['configurations']:
        for seed,loss in zip(RULES['training']['seeds'],[.43,.40,.37]):
            result.append({'config':config,'seed':seed,'selectedInnerCe':loss,
                'selectedEpoch':config['epochs'],'quality':{'inner-validation':quality()}})
    return result


def curve_record():
    config=RULES['configurations'][0]
    t=RULES['training']
    curves=[]
    for epoch in range(10,301,10):
        qat=epoch>200
        curves.append({'epoch':epoch,'qat':qat,'learningRate':t['minimumLearningRate']+
            .5*(t['learningRate']-t['minimumLearningRate'])*(1+math.cos(math.pi*(epoch-1)/299)),
            'trainQuantizedCe':.4,'innerValidationQuantizedCe':.41 if epoch<240 else .40,
            'objectiveComponents':{'fakeQuantization':qat,'dataCE':.4,'gradientL2':.1},
            'gradientNorm':.1,'maximumAbsGradient':.05,'projectedUpdates':0})
    return {'config':config,'epochsRun':300,'updates':600,'convergenceClaimed':False,'seconds':1.,
            'curves':curves,'selectedEpoch':240,'selectedInnerCe':.40}


class AuditTests(unittest.TestCase):
    def test_all_four_layouts_and_signed_half_rounding(self):
        m.self_test()

    def test_phase_tapers_heads_before_single_rounding(self):
        fens=['4k3/8/8/8/8/8/3Q4/4K3 w - - 0 1','4k3/8/8/8/8/8/3Q4/4K3 b - - 0 1']
        data={'features':m.old.features(fens),'materialPhase':np.array([4,4]),'baseline':np.array([3,3])}
        # MG=3cp, EG=.5cp approximately; tapered result rounds to1cp.
        for h in (4,8):
            raw=bytes(768*h*2+h*4+4*h*2)+struct.pack('<2i',503316,83886)
            np.testing.assert_array_equal(m.inference(m.decode(raw,h,True),data,True,True),[4,2])
            p=m.floating_parts(np.zeros(773*h+2),h,True)
            np.testing.assert_array_equal(m.inference(p,data,False,True),[3,3])
        with self.assertRaises(AssertionError):m.decode(raw,4,True)

    def test_nonzero_weights_match_independent_bigint_oracles(self):
        fens=m.old.AUTHORED
        base=np.arange(len(fens))*13-29
        data={'features':m.old.features(fens),'materialPhase':m.phase_values(fens),'baseline':base}
        rng=np.random.default_rng(741)
        for hidden in (4,8):
            for phase in (False,True):
                heads=2 if phase else 1
                arrays=[rng.integers(-2000,2000,768*hidden,dtype=np.int16),
                    rng.integers(-1000,17000,hidden,dtype=np.int32),
                    rng.integers(-4096,4096,heads*2*hidden,dtype=np.int16),
                    rng.integers(-6000000,6000000,heads,dtype=np.int32)]
                payload=b''.join(value.astype(dtype).tobytes() for value,dtype in zip(arrays,('<i2','<i4','<i2','<i4')))
                predicted=m.inference(m.decode(payload,hidden,phase),data,True,phase)
                with tempfile.TemporaryDirectory() as directory:
                    root=Path(directory)
                    (root/'model.bin').write_bytes(payload)
                    (root/'metadata.json').write_text(json.dumps(m.expected_metadata(hidden,phase)))
                    rows=''.join(json.dumps({'id':str(i),'fen':fen,'baselineCp':int(base[i])})+'\n' for i,fen in enumerate(fens))
                    oracle=ROOT/('test/training/h4-v3-reference.js' if phase else 'test/training/h4-v2-reference.js')
                    proc=subprocess.run(['node',str(oracle),str(root/'model.bin'),str(root/'metadata.json')],
                        input=rows,text=True,capture_output=True,check=True)
                    np.testing.assert_array_equal(predicted,[json.loads(line)['cpWhite'] for line in proc.stdout.splitlines()])

    def test_complete_curve_checks_detect_mutations(self):
        r=curve_record()
        self.assertEqual(m.check_curve(r,RULES['training'],1024)['epoch'],240)
        mutations=[lambda x:x['curves'].pop(4),lambda x:x['curves'][5].update(learningRate=.99),
            lambda x:x['curves'][20].update(qat=False),lambda x:x.update(updates=601),
            lambda x:x.update(selectedEpoch=250),lambda x:x['curves'][1].update(trainQuantizedCe=float('nan'))]
        for change in mutations:
            bad=copy.deepcopy(r);change(bad)
            with self.assertRaises(AssertionError):m.check_curve(bad,RULES['training'],1024)
        r['epochsRun']=240;r['updates']=480;r['curves']=r['curves'][:24];r['selectedInnerCe']=None
        self.assertEqual(m.check_curve(r,RULES['training'],1024,True)['epoch'],240)

    def test_selection_uses_median_ties_and_shipped_phase_guard(self):
        r=records();configs=RULES['configurations'];seeds=RULES['training']['seeds']
        selected=m.choose(list(reversed(r)),configs,seeds,quality())
        self.assertEqual(selected['config'],configs[0]);self.assertEqual(selected['seed'],seeds[1])
        r[1]['quality']['inner-validation']=quality(rows=99)
        self.assertEqual(m.choose(r,configs,seeds,quality())['config'],configs[1])
        for record in r:record['quality']['inner-validation']=quality(.405)
        self.assertIsNone(m.choose(r,configs,seeds,quality())['config'])
        for bad in (r[:-1],r+[copy.deepcopy(r[0])],r[:-1]+[copy.deepcopy(r[-2])]):
            with self.assertRaises(AssertionError):m.choose(bad,configs,seeds,quality())

    def test_ablation_does_not_call_zero_or_negative_gain_saturation(self):
        r=records();a=m.ablations(r,RULES['configurations'])
        self.assertEqual(len(a),5)
        self.assertTrue(all(v['relativeMedianCeImprovement']==0 and not v['smallPositiveGainBelowPoint1Percent'] for v in a))
        for record in r[-3:]:record['selectedInnerCe']*=.9995
        last=m.ablations(r,RULES['configurations'])[-1]
        self.assertTrue(last['smallPositiveGainBelowPoint1Percent'])
        self.assertFalse(last['convergenceClaimed'])


if __name__=='__main__':unittest.main()
