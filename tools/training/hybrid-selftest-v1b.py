#!/usr/bin/env python3
"""Regression: comparator runtime uses integral float64, blend requires int64."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np
p=Path(__file__).parent
spec=importlib.util.spec_from_file_location('hybrid_screen_v1b',p/'hybrid-screen-v1b.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TestComparatorAdapter(unittest.TestCase):
    def test_runtime_integral_float_representation(self):
        # natural_pilot_arithmetic.runtime_predictions intentionally returns float64;
        # the pipeline must validate its integral values before exact integer blending.
        bases={'shipped-hce':np.array([2,-3,7],dtype=np.int64),'frozen-expanded-hce':np.array([4.,-5.,8.],dtype=np.float64)}
        actual=m.integer_comparators(bases,3)
        self.assertEqual(actual['frozen-expanded-hce'].dtype,np.dtype('int64'))
        out=m.hybrid.blend(actual['shipped-hce'],actual['frozen-expanded-hce'],np.array([4,7,10]),{'kind':'smooth','lo':4,'hi':10})
        self.assertEqual(out.tolist(),[4,-4,7])
    def test_reject_fractional_nonfinite_wrong_shape_and_bound(self):
        for x in [np.array([1.5]),np.array([float('nan')]),np.array([float('inf')]),np.array([10001.]),np.array([[1.]])]:
            with self.assertRaises(ValueError):m.integer_comparators({'x':x},1)
if __name__=='__main__':unittest.main()
