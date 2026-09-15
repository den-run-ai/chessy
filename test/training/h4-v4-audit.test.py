#!/usr/bin/env python3
"""Authored-only objective checks; no model/trainer imports or source data."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('independent_v4',ROOT/'tools/training/audit-h4-v4.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def case(hidden,phase):
    fens=['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2','rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1',
          '4k3/8/8/8/8/8/3Q4/4K3 w - - 0 1']
    seed=411;heads=2 if phase else 1
    p=np.concatenate((np.random.default_rng(seed).normal(0,.04,768*hidden),np.full(hidden,.25),
                      np.random.default_rng(151).normal(0,.12,heads*(2*hidden+1))))
    fp=m.floating_parts(p,hidden,phase)
    ip=tuple(np.rint(value*scale).astype(np.int64) for value,scale in zip(fp,(m.Q1,m.Q1,m.Q2,m.Q1*m.Q2)))
    data={'features':m.old.features(fens),'materialPhase':m.phase_values(fens),'phase':np.array(['endgame','opening','endgame']),
          'target':np.array([.8,.6,.9]),'baseline':np.array([21,-15,850])}
    config={'hidden':hidden,'mode':'phase-residual-shipped-hce' if phase else 'residual-shipped-hce','endgameWeight':4,'l2':.01}
    return p,fp,ip,config,seed,data


class ObjectiveTests(unittest.TestCase):
    def test_continuous_weighted_gradient_matches_finite_differences(self):
        for hidden in (4,8):
            for phase in (False,True):
                p,fp,ip,c,seed,data=case(hidden,phase)
                _,_,gradient=m.objective_audit(fp,ip,c,seed,data,False)
                active=sorted((set(data['features'][0].ravel())|set(data['features'][1].ravel()))-{768})
                indexes=[i*hidden for i in active]+list(range(768*hidden,len(p)))
                for i in indexes:
                    values=[]
                    for sign in (1,-1):
                        q=p.copy();q[i]+=sign*1e-6
                        comp,_,_=m.objective_audit(m.floating_parts(q,hidden,phase),ip,c,seed,data,False)
                        values.append(comp['dataCE']+comp['regularizer'])
                    self.assertAlmostEqual(gradient[i],(values[0]-values[1])/2e-6,delta=5e-9)

    def test_qat_ste_uses_quantized_forward_and_raw_matched_regularizer(self):
        for hidden in (4,8):
            for phase in (False,True):
                p,fp,ip,c,seed,data=case(hidden,phase)
                comp,_,grad=m.objective_audit(fp,ip,c,seed,data,True)
                effective=tuple(x/s for x,s in zip(ip,(m.Q1,m.Q1,m.Q2,m.Q1*m.Q2)))
                q=np.concatenate([x.ravel() for x in effective])
                plain,_,plain_grad=m.objective_audit(effective,ip,c,seed,data,False)
                coef=np.full(len(p),.01);coef[768*hidden+hidden:]*=.5 if phase else 1
                np.testing.assert_allclose(grad,plain_grad+coef*(p-q),atol=1e-13)
                self.assertAlmostEqual(comp['dataCE'],plain['dataCE'])
                self.assertEqual(comp['outputL2'],.005 if phase else .01)


if __name__=='__main__':unittest.main()
