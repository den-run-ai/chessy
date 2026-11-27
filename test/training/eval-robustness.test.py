"""Guard the training split, correction arithmetic and diagnosis from retained raw visits."""
import copy
import gzip
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.eval_robustness import fit, standpat

DATA = ROOT / "eval/eval-robustness-v1"


class RobustnessContracts(unittest.TestCase):
    def test_signed_scaling_uses_the_rounded_residual(self):
        for base in (-37, 0, 48):
            for delta, expected in ((-5, -3), (-1, 0), (1, 0), (5, 3)):
                child = {"hce": base, "noPawn": base + delta}
                self.assertEqual(fit.integer_score(child, 12), base + expected)

    def test_held_out_labels_do_not_move_the_fit(self):
        original = (DATA / "collection.jsonl.gz").read_bytes()
        rows = [json.loads(line) for line in gzip.decompress(original).splitlines()]
        altered = copy.deepcopy(rows)
        for row in altered:
            if fit.held_out(row["group"]):
                for child in row["children"]:
                    child["teacher"] = -child["teacher"]
        protocol = (DATA / "fit-protocol.json").read_bytes()
        exclusions = json.loads((DATA / "fit-exclusions.json").read_bytes())
        changed = b"\n".join(json.dumps(row).encode() for row in altered)
        exclusions["collectionSha256"] = fit.digest(changed)
        recomputed = fit.analyze(changed, protocol, json.dumps(exclusions).encode())
        saved = json.loads((DATA / "fit-results.json").read_bytes())
        for recipe, original_fit in saved["fits"].items():
            self.assertEqual(recomputed["fits"][recipe]["numerator"], original_fit["numerator"])
            self.assertAlmostEqual(recomputed["fits"][recipe]["alpha"], original_fit["alpha"], places=10)
        self.assertNotEqual(recomputed["heldOut"]["hce"]["all"]["regretCp"],
                            saved["heldOut"]["hce"]["all"]["regretCp"])

    def test_standpat_reports_reproduce_from_both_traced_trees(self):
        for tree in ("hce", "nopawn"):
            ledger = gzip.decompress((DATA / f"standpat-{tree}-events.json.gz").read_bytes())
            report = json.loads((DATA / f"standpat-{tree}-results.json").read_bytes())
            self.assertEqual(report["ledgerSha256"], fit.digest(ledger))
            stored = json.loads(ledger)
            self.assertEqual(len(stored["roots"]), report["wasmRootSignaturesChecked"])
            for teacher, strata in report["results"].items():
                for index, label in enumerate(("uniformVisits", "within50CpOfTracedCutoff")):
                    self.assertEqual(standpat.summarize(stored["events"], teacher, index), strata[label])

    def test_cutoff_direction_and_one_sided_teacher_bounds(self):
        events = []
        for index, (turn, score, target, bounded) in enumerate((
                ("w", 51, 49, False), ("b", 51, 49, False), ("w", 51, 999, True))):
            events.append(dict(root=index, fen="fixture " + turn, stratum=0, bound=50,
                               scores={model: score for model in standpat.MODELS},
                               labels={"t": dict(cp=target, mate=None, bounded=bounded)}))
        result = standpat.summarize(events, "t", 0)
        self.assertEqual(result["bounded"], 1)
        hce = result["byModel"]["hce"]
        self.assertEqual(hce["adverseStop"], 0.5)
        self.assertEqual(hce["missedStop"], 0.5)
        self.assertEqual(hce["maeCp"], 2)


if __name__ == "__main__":
    unittest.main()
