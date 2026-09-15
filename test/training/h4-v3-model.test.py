#!/usr/bin/env python3
"""Authored-only numerical regressions for the phase residual contract."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/training"))
import h4_v3_model as m

FENS = [
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",
    "4k3/8/8/8/8/8/3Q4/4K3 b - - 0 1",
    "1n2k3/8/8/3p4/4P3/8/8/4K1N1 w - - 0 1",
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
    "qqqqkqqq/8/8/8/8/8/8/QQQQKQQQ w - - 0 1",
]


class V3Tests(unittest.TestCase):
    def test_material_phase_endpoints_and_promotions(self):
        np.testing.assert_array_equal(m.phase_from_fens(FENS), [0, 4, 2, 24, 24])
        with self.assertRaises(ValueError):
            m.phase_from_fens(["invalid"])

    def test_weighted_phase_gradient_matches_finite_differences(self):
        features = m.features_from_fens(FENS)
        phase = m.phase_from_fens(FENS)
        targets, base, weights = np.array([.6,.1,.8,.5,.9]), np.array([21,717,-13,4,15]), np.array([2,2,1,1,1])
        for hidden in (4,8):
            params = m.initialize(711, hidden)
            center = m.anchor(params, hidden)
            params[768*hidden+hidden:] = np.random.default_rng(124).normal(0,.13,4*hidden+2)
            params[768*hidden] = -1.8  # clipped activation lower boundary
            params[768*hidden+1] = 1.8  # clipped activation upper boundary
            kwargs = dict(phase_units=phase, hidden=hidden, baseline_cp=base,
                          sample_weight=weights, l2=.01, anchor_params=center)
            loss, grad, _ = m.loss_and_grad(params,*features,targets,**kwargs)
            active = sorted(set(features[0].indices)|set(features[1].indices))
            indices = [i*hidden+j for i in active for j in range(hidden)]
            indices += list(range(768*hidden,len(params)))+[700*hidden]
            for i in indices:
                plus,minus=params.copy(),params.copy()
                plus[i]+=1e-6
                minus[i]-=1e-6
                a=m.loss_and_grad(plus,*features,targets,**kwargs)[0]
                b=m.loss_and_grad(minus,*features,targets,**kwargs)[0]
                self.assertAlmostEqual(grad[i],(a-b)/2e-6,delta=6e-9)
            scaled=dict(kwargs,sample_weight=weights*17)
            l2,g2,_=m.loss_and_grad(params,*features,targets,**scaled)
            self.assertAlmostEqual(loss,l2)
            np.testing.assert_allclose(grad,g2,atol=2e-16)

    def test_normalized_weighting_is_independent_scalar_weighted_ce(self):
        features=m.features_from_fens(FENS[:2]); phase=m.phase_from_fens(FENS[:2])
        p=m.initialize(42); p[-2:]=[.03,-.17]
        cp=m.predict_cp(p,*features,phase_units=phase,baseline_cp=[21,713])
        losses=[np.logaddexp(0,float(c)/100)-t*float(c)/100 for c,t in zip(cp,[.65,.1])]
        value,_,_=m.loss_and_grad(p,*features,[.65,.1],phase_units=phase,baseline_cp=[21,713],sample_weight=[2,1])
        self.assertAlmostEqual(value,(2*losses[0]+losses[1])/3)
        for invalid in ([0,1],[-1,2],[1,np.nan],[1],[] ):
            with self.assertRaises(ValueError):
                m.loss_and_grad(p,*features,[.65,.1],phase_units=phase,baseline_cp=[21,713],sample_weight=invalid)

    def test_zero_residual_exact_baseline_and_unused_head_gradient(self):
        f=m.features_from_fens(FENS); phase=m.phase_from_fens(FENS)
        base=np.array([7,-94,-12,950,9])
        for h in (4,8):
            p=m.initialize(50,h)
            np.testing.assert_array_equal(m.predict_cp(p,*f,phase_units=phase,hidden=h,baseline_cp=base),base)
            q=m.quantize(p,h)
            np.testing.assert_array_equal(q.predict_cp(*f,phase_units=phase,baseline_cp=base),base)
            self.assertEqual(len(q.to_bytes()), 6200 if h==4 else 12392)
            for row,unused in [(0,0),(3,1)]:
                x=m.features_from_fens([FENS[row]])
                _,g,_=m.loss_and_grad(p,*x,[.8],phase_units=[phase[row]],hidden=h,baseline_cp=[2])
                out_start=768*h+h+unused*2*h
                np.testing.assert_array_equal(g[out_start:out_start+2*h],np.zeros(2*h))
                self.assertEqual(g[-2+unused],0)

    def test_quantization_roundtrip_metadata_and_independent_javascript(self):
        base=np.array([7,-94,-12,950,9])
        x=m.features_from_fens(FENS); phase=m.phase_from_fens(FENS)
        for h in (4,8):
            p=m.initialize(125,h)
            p[768*h+h:]=np.random.default_rng(88).normal(0,.4,4*h+2)
            q=m.quantize(p,h)
            rebuilt=m.QuantizedModel.from_bytes(q.to_bytes(),hidden=h,metadata=q.metadata())
            self.assertEqual(rebuilt.to_bytes(),q.to_bytes())
            integer=q.predict_cp(*x,phase_units=phase,baseline_cp=base)
            with tempfile.TemporaryDirectory() as td:
                path=Path(td); (path/'model.bin').write_bytes(q.to_bytes()); (path/'metadata.json').write_text(json.dumps(q.metadata()))
                rows=''.join(json.dumps(dict(id=str(i),fen=fen,baselineCp=int(base[i])))+'\n' for i,fen in enumerate(FENS))
                proc=subprocess.run(['node',str(ROOT/'test/training/h4-v3-reference.js'),str(path/'model.bin'),str(path/'metadata.json')],input=rows,text=True,capture_output=True,check=True)
                np.testing.assert_array_equal([json.loads(v)['cpWhite'] for v in proc.stdout.splitlines()],integer)
                for key,value in [('phaseRule','wrong'),('hidden',True),('extra',1)]:
                    bad=dict(q.metadata());bad[key]=value
                    with self.assertRaises(ValueError):
                        m.QuantizedModel.from_bytes(q.to_bytes(),hidden=h,metadata=bad)
                    (path/'metadata.json').write_text(json.dumps(bad))
                    invalid=subprocess.run(['node',str(ROOT/'test/training/h4-v3-reference.js'),str(path/'model.bin'),str(path/'metadata.json')],input=rows,text=True,capture_output=True)
                    self.assertNotEqual(invalid.returncode,0)

    def test_taper_precedes_rounding_with_signed_near_half_cases(self):
        # MG~.49cp and EG~.60cp with phase20 mix to~.508cp. Rounding
        # heads first would instead produce .167cp and the wrong final result.
        fen="qqq1k3/8/8/8/8/8/QQ6/4K3 b - - 0 1"
        x=m.features_from_fens([fen,fen.replace(' b ',' w ')])
        for sign in (-1,1):
            q=m.QuantizedModel(np.zeros((768,4)),np.zeros(4),np.zeros((2,8)),[sign*82208,sign*100663])
            p=m.phase_from_fens([fen,fen])
            np.testing.assert_array_equal(p,[20,20])
            expected=[]
            for turn in (-1,1):
                numerator=20*sign*82208+4*sign*100663
                expected.append(((numerator*400+24*16384*4096//2)//(24*16384*4096))*turn)
            self.assertEqual(expected,[-sign,sign])
            np.testing.assert_array_equal(q.predict_cp(*x,phase_units=p,baseline_cp=[0,0]),expected)

    def test_fake_quantization_preserves_gradient_and_bounds_reject_bad_inputs(self):
        x=m.features_from_fens(FENS); phase=m.phase_from_fens(FENS)
        p=m.initialize(412);p[-2:]=[.030011,-.018201]
        loss,grad,diagnostics=m.loss_and_grad(p,*x,[.8]*5,phase_units=phase,baseline_cp=[0]*5,fake_quant=True)
        self.assertTrue(diagnostics['fakeQuantization'])
        self.assertGreater(np.linalg.norm(grad),.01)
        for bad in ([0,4,2,24,25], [0,4,2,24,1.5], None):
            with self.assertRaises(ValueError):
                m.predict_cp(p,*x,phase_units=bad,baseline_cp=[0]*5)
        p[0]=2
        with self.assertRaises(ValueError):
            m.quantize(p)
        self.assertEqual(m.project(p)[0],1.9)


if __name__=='__main__':
    unittest.main()
