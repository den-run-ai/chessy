#!/usr/bin/env python3
"""Synthetic arithmetic tests, independent of model labels/checkpoints."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
import numpy as np
P=Path(__file__).parent
s=importlib.util.spec_from_file_location('hybrid',P/'hybrid-model-v1.py'); m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class TestHybrid(unittest.TestCase):
    def test_endpoints_and_negative_ties(self):
        c={'kind':'smooth','lo':4,'hi':10}
        actual=m.blend(np.array([-1,-1,-1]),np.array([0,0,0]),np.array([4,7,10]),c)
        self.assertEqual(actual.tolist(),[0,0,-1])
        self.assertEqual(m.blend(np.array([9,9]),np.array([-2,-2]),np.array([6,7]),{'kind':'hard','threshold':6}).tolist(),[-2,9])
    def test_exhaustive_signed_blend_parity(self):
        configs=json.loads((P.parent.parent/'eval/training/hybrid-v1.json').read_text())['configurations']
        rows=[]
        for c in configs:
            for p in range(25):
                for n,f in [(-10000,10000),(10000,-10000),(-1,0),(0,-1),(1,0),(0,1),(7,-13),(0,0)]:
                    rows.append([c,p,n,f,int(m.blend(np.array([n]),np.array([f]),np.array([p]),c)[0])])
        script="const h=require('./tools/training/hybrid-reference-v1.js'); let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{for(const [c,p,n,f,e] of JSON.parse(s)){if(h.blend(n,f,p,c)!==e)throw Error('mismatch')}});"
        subprocess.run(['node','-e',script],cwd=P.parent.parent,input=json.dumps(rows),text=True,check=True)
    def test_reject_invalid(self):
        for c in [{'kind':'smooth','lo':8,'hi':4},{'kind':'hard','threshold':25},{'kind':'other'}]:
            with self.assertRaises(ValueError):m.gate(np.array([6]),c)
        with self.assertRaises(ValueError):m.gate(np.array([6.0]),{'kind':'hard','threshold':6})
        with self.assertRaises(ValueError):m.blend(np.array([10001]),np.array([0]),np.array([6]),{'kind':'hard','threshold':6})
    def test_bound_and_smooth_monotonicity(self):
        for n,f in [(10000,-10000),(-10000,10000),(-31,20)]:
            p=np.arange(25);out=m.blend(np.full(25,n),np.full(25,f),p,{'kind':'smooth','lo':6,'hi':12})
            self.assertTrue(np.all((out>=min(n,f))&(out<=max(n,f))))
            self.assertTrue(np.all(np.diff(out)*np.sign(n-f)>=0))
            self.assertLessEqual(np.max(np.abs(np.diff(out))),int(np.ceil(abs(n-f)/6)))
if __name__=='__main__':unittest.main()
