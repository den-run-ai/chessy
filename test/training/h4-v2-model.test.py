#!/usr/bin/env python3
"""Synthetic mathematical/semantic regressions for the separately registered v2."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from scipy.special import expit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/training"))
import h4_v2_model as m

FENS = [
    "1n2k3/8/8/3p4/4P3/8/8/4K1N1 w - - 0 1",
    "4k1n1/8/8/4p3/3P4/8/8/1N2K3 b - - 0 1",
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",
    "4k3/8/8/8/8/8/3Q4/4K3 b - - 0 1",
]


class V2Tests(unittest.TestCase):
    def test_float_gradient_finite_differences_both_widths_modes_and_clips(self):
        x = m.features_from_fens(FENS)
        target = np.array([.68, .32, .47, .01])
        for h in (4, 8):
            params = m.initialize(814, hidden=h)
            center = m.anchor(params, h)
            params[768*h] = -1.9
            params[768*h+1] = 1.9
            base = np.array([57, -57, -40, 913])
            _, grad, _ = m.loss_and_grad(params, *x, target, hidden=h, baseline_cp=base,
                                         l2=.002, anchor_params=center)
            active = sorted(set(x[0].indices) | set(x[1].indices))
            indices = [v*h+u for v in active for u in range(h)] + list(range(768*h, len(params))) + [700*h]
            for i in indices:
                plus, minus = params.copy(), params.copy()
                plus[i] += 1e-6
                minus[i] -= 1e-6
                a = m.loss_and_grad(plus, *x, target, hidden=h, baseline_cp=base, l2=.002, anchor_params=center)[0]
                b = m.loss_and_grad(minus, *x, target, hidden=h, baseline_cp=base, l2=.002, anchor_params=center)[0]
                self.assertAlmostEqual(grad[i], (a-b)/2e-6, delta=4e-9)

    def test_regularizer_is_sum_without_parameter_count_dilution(self):
        x = m.features_from_fens(FENS)
        for h in (4, 8):
            params = m.initialize(32, hidden=h)
            center = m.anchor(params, h)
            loss0, grad0, d0 = m.loss_and_grad(params, *x, [.5]*4, hidden=h)
            loss1, grad1, d1 = m.loss_and_grad(params, *x, [.5]*4, hidden=h, l2=.1, anchor_params=center)
            expected = .05 * sum(float(v)**2 for v in params-center)
            self.assertAlmostEqual(loss1-loss0, expected)
            self.assertAlmostEqual(d1['regularizer'], expected)
            np.testing.assert_allclose(grad1-grad0, .1*(params-center), atol=1e-15)
            self.assertEqual(d0['regularizer'], 0)
        with self.assertRaisesRegex(ValueError, 'explicit initialization anchor'):
            m.loss_and_grad(params, *x, [.5]*4, hidden=8, l2=.1)

    def test_fake_quantization_ste_uses_quantized_forward_and_interior_gradient(self):
        fen = "P7/8/8/8/8/8/8/8 w - - 0 1"
        x = m.features_from_fens([fen])
        p = np.zeros(m.parameter_count())
        p[0] = .125013
        p[440*4] = .200019
        p[3072] = .100017
        p[3073] = -1.9
        p[3076], p[3080], p[-1] = .700033, -.300087, .005
        # Independent two-scalar reconstruction; no model forward helper.
        aw = (round(p[0]*16384)+round(p[3072]*16384))/16384
        ab = (round(p[440*4]*16384)+round(p[3072]*16384))/16384
        ow, ob = round(p[3076]*4096)/4096, round(p[3080]*4096)/4096
        bias = round(p[-1]*67108864)/67108864
        z = 4*(aw*ow+ab*ob+bias)
        derivative = 4*(expit(z)-.6)
        loss, grad, diag = m.loss_and_grad(p, *x, [.6], fake_quant=True)
        self.assertAlmostEqual(loss, np.logaddexp(0,z)-.6*z)
        for i, expected in {0:derivative*ow, 440*4:derivative*ob,
                            3072:derivative*(ow+ob), 3076:derivative*aw,
                            3080:derivative*ab, 3084:derivative, 1:0, 3073:0}.items():
            self.assertAlmostEqual(grad[i], expected)
        self.assertTrue(diag['fakeQuantization'])
        self.assertGreater(abs(grad[0]), .001)  # Rounding derivative is STE, not zero.

    def test_zero_residual_reproduces_integer_baseline_and_no_material_double_count(self):
        x = m.features_from_fens(FENS)
        base = np.array([7, -94, -12, 950])
        for h in (4, 8):
            params = m.initialize(50, hidden=h, residual=True)
            np.testing.assert_array_equal(m.predict_cp(params, *x, hidden=h, baseline_cp=base), base)
            q = m.quantize(params, h, 'shipped-hce')
            np.testing.assert_array_equal(q.predict_cp(*x, baseline_cp=base), base)
            with self.assertRaisesRegex(ValueError, 'baseline presence'):
                q.predict_cp(*x)
            with self.assertRaisesRegex(ValueError, 'baseline presence'):
                m.quantize(params, h).predict_cp(*x, baseline_cp=base)
            with self.assertRaisesRegex(ValueError, 'baseline must'):
                q.predict_cp(*x, baseline_cp=base+.5)

    def test_color_rank_mirror_negates_both_float_and_integer_white_score(self):
        x = m.features_from_fens(FENS[:2])
        for h in (4,8):
            p = m.initialize(314,hidden=h)
            for cp in (m.predict_cp(p,*x,hidden=h),m.quantize(p,h).predict_cp(*x)):
                self.assertEqual(cp[0],-cp[1])

    def test_projection_quantizer_fixed_scales_size_roundtrip_and_strict_metadata(self):
        for h in (4,8):
            p = np.full(m.parameter_count(h), 100.)
            projected = m.project(p,h)
            self.assertEqual(projected[0],1.9)
            self.assertEqual(projected[-2],4)
            self.assertEqual(projected[-1],2)
            with self.assertRaisesRegex(ValueError, 'projection bounds'):
                m.quantize(p,h)
            q = m.quantize(projected,h)
            self.assertEqual(q.input_weights[0,0],31130)
            self.assertEqual(q.output_weights[0],16384)
            self.assertEqual(q.output_bias,134217728)
            self.assertEqual(len(q.to_bytes()),6180 if h==4 else 12356)
            self.assertEqual((q.metadata()['q1'],q.metadata()['q2']),(16384,4096))
            restored = m.QuantizedModel.from_bytes(q.to_bytes(),hidden=h,metadata=q.metadata())
            self.assertEqual(restored.to_bytes(),q.to_bytes())
            metadata = q.metadata() | {'q1':1024}
            with self.assertRaisesRegex(ValueError, 'metadata'):
                m.QuantizedModel.from_bytes(q.to_bytes(),hidden=h,metadata=metadata)
            with self.assertRaisesRegex(ValueError, 'metadata'):
                m.QuantizedModel.from_bytes(q.to_bytes(),hidden=h,metadata=q.metadata() | {'hidden':float(h)})
            with self.assertRaisesRegex(ValueError, 'binary length'):
                m.QuantizedModel.from_bytes(q.to_bytes()[:-1],hidden=h)
            # The largest positive/negative parameter combination remains exact int64.
            x = m.features_from_fens(FENS)
            self.assertEqual(q.predict_cp(*x).dtype,np.dtype('int64'))
        with self.assertRaisesRegex(ValueError,'hidden width'):
            m.initialize(1,hidden=16)
        q = m.quantize(m.initialize(1))
        w = q.input_weights.astype(int); w[0,0]=31131
        with self.assertRaisesRegex(ValueError,'input_weights'):
            m.QuantizedModel(w,q.input_bias,q.output_weights,q.output_bias)

    def test_activation_diagnostics_partition_both_perspectives(self):
        params = m.initialize(1)
        params[3072],params[3073] = -1.9,1.9
        d = m.activation_diagnostics(params,*m.features_from_fens(FENS))
        self.assertEqual(d['rows'],4)
        self.assertEqual(d['zeroActivationFraction'][0],1)
        self.assertEqual(d['upperSaturationFraction'][1],1)
        np.testing.assert_array_equal(np.asarray(d['zeroActivationFraction'])+d['upperSaturationFraction']+d['interiorFraction'],np.ones(4))

    def test_ties_even_weights_and_negative_half_stm_rounding_before_white_sign(self):
        p = np.zeros(m.parameter_count())
        p[:4] = np.array([.5,1.5,-.5,-1.5])/16384
        q = m.quantize(p)
        self.assertEqual(q.input_weights[0].tolist(),[0,2,0,-2])
        # -0.125 net stm *400 = -50 exactly; -12.5 requires -Q1Q2/32.
        q = m.QuantizedModel(np.zeros((768,4)),np.zeros(4),np.zeros(8),-2097152)
        fens = ['8/8/8/8/8/8/8/8 w - - 0 1','8/8/8/8/8/8/8/8 b - - 0 1']
        self.assertEqual(q.predict_cp(*m.features_from_fens(fens)).tolist(),[-12,12])

    def test_independent_js_bigint_reference_both_widths_and_modes(self):
        reference = ROOT/'test/training/h4-v2-reference.js'
        if not reference.exists():
            self.skipTest('independent reference implementation not yet present')
        for h in (4,8):
            for baseline_id in ('none','shipped-hce'):
                q = m.quantize(m.initialize(427,hidden=h),h,baseline_id)
                base = np.array([94,-94,-5,951]) if baseline_id!='none' else None
                with tempfile.TemporaryDirectory() as name:
                    binary, metadata = Path(name)/'model.bin',Path(name)/'model.json'
                    binary.write_bytes(q.to_bytes()); metadata.write_text(json.dumps(q.metadata()))
                    rows = [{'id':str(i),'fen':fen,**({'baselineCp':int(base[i])} if base is not None else {})}
                            for i,fen in enumerate(FENS)]
                    r = subprocess.run(['node',str(reference),str(binary),str(metadata)],
                                       input=''.join(json.dumps(row)+'\n' for row in rows),text=True,capture_output=True,check=True)
                    actual = [json.loads(line)['cpWhite'] for line in r.stdout.splitlines()]
                self.assertEqual(actual,q.predict_cp(*m.features_from_fens(FENS),baseline_cp=base).tolist())


if __name__ == '__main__':
    unittest.main()
