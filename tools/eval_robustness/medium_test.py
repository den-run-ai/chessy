"""Regression checks for the r85 product-budget and late-game seed path."""
import unittest

import chess

from .medium import make_request


class ProductBudget(unittest.TestCase):
    def test_post_opening_medium_options_and_side(self):
        b = chess.Board()
        h = [b.fen()]
        # Play a real 12-ply prefix to hit the product's first unseeded root.
        for move in 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 d2d3 d7d6 b1c3 g8f6 c1g5 c8g4'.split():
            b.push_uci(move)
            h.append(b.fen())
        slot = {'scheduleId':'check','candidateColor':'black'}
        preset = {'maxDepth':30,'nodeLimit':10_000,'timeMs':5_000,'quiesce':True}
        req = make_request(slot,0,h,b,preset)
        self.assertEqual({k:req[k] for k in preset},preset)
        self.assertIsNone(req['rootSeed'])
        self.assertIs(req['historyFens'],h)
        self.assertEqual(req['engine'],'base')
        b.push_uci('h2h3')
        h.append(b.fen())
        self.assertEqual(make_request(slot,1,h,b,preset)['engine'],'candidate')
        with self.assertRaisesRegex(ValueError,'opening variety window'):
            make_request(slot,0,h[:12],b,preset)


if __name__ == '__main__':
    unittest.main()
