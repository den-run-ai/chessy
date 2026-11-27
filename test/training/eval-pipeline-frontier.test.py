#!/usr/bin/env python3
"""Artificial outcomes only: no engine searches or locked opening data."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.eval_pipeline import frontier as f


def config(count=16):
    return {"schema": f.SCHEMA, "experimentId": "synthetic-frontier-contract",
            "researchOnly": True, "productionAdmission": False,
            "base": {"id": "hce", "sha256": "a" * 64},
            "candidate": {"id": "residual", "sha256": "b" * 64, "modelSha256": "c" * 64},
            "timeControlsMs": [10, 25, 100, 400],
            "openingIds": ["authored-" + str(index) for index in range(count)],
            "nodeLimit": 0, "maxDepth": 30, "postOpeningPlyCap": 180,
            "bootstrap": {"seed": 20261127, "samples": 2000, "confidence": .95}}


def records(cfg, scores):
    """Encode known paired points independently as two legal-result tokens."""
    points = {0: (0, 0), .25: (0, .5), .5: (1, 0), .75: (1, .5), 1: (1, 1)}
    rows = []
    for slot in f.schedule(cfg):
        index = cfg["openingIds"].index(slot["openingId"])
        white, black = points[scores[slot["timeMs"]][index]]
        candidate_score = white if slot["candidateColor"] == "white" else black
        if candidate_score == .5:
            result, reason, plies = "1/2-1/2", "ply-cap", 180
        else:
            white_wins = (candidate_score == 1) == (slot["candidateColor"] == "white")
            result, reason, plies = ("1-0" if white_wins else "0-1"), "checkmate", 60
        rows.append(dict(slot, result=result, termination=reason, postOpeningPlies=plies,
                         baseSha256=cfg["base"]["sha256"], candidateSha256=cfg["candidate"]["sha256"],
                         telemetry={"syntheticFixtureOnly": True}))
    return rows


class ScheduleContracts(unittest.TestCase):
    def setUp(self):
        self.cfg = config()
        self.rows = records(self.cfg, {time: [.25, .5, .75, 1] * 4 for time in self.cfg["timeControlsMs"]})

    def test_complete_schedule_has_one_color_pair_at_every_time(self):
        scheduled = f.schedule(self.cfg)
        self.assertEqual(len(scheduled), 128)
        self.assertEqual(len({row["scheduleId"] for row in scheduled}), 128)
        self.assertEqual([row["candidateColor"] for row in scheduled[:4]],
                         ["white", "black", "white", "black"])
        self.assertEqual([row["timeMs"] for row in scheduled[:8:2]], [10, 25, 100, 400])
        self.assertEqual([row["timeMs"] for row in scheduled[8:16:2]], [25, 100, 400, 10])
        self.assertEqual([row["candidateColor"] for row in scheduled[8:10]], ["black", "white"])
        self.assertEqual(f.validate_records(self.cfg, reversed(self.rows)), self.rows)

    def test_config_rejects_posthoc_or_non_time_schedules(self):
        mutations = [lambda c: c.update(productionAdmission=True),
                     lambda c: c.update(researchOnly=False),
                     lambda c: c.update(nodeLimit=10000),
                     lambda c: c.update(nodeLimit=False),
                     lambda c: c.update(timeControlsMs=[25, 10]),
                     lambda c: c.update(timeControlsMs=[10, 10]),
                     lambda c: c.update(timeControlsMs=[True, 25]),
                     lambda c: c.update(timeControlsMs=[25]),
                     lambda c: c.update(openingIds=["same", "same"]),
                     lambda c: c["candidate"].update(sha256="not-a-hash"),
                     lambda c: c["bootstrap"].update(samples=1999),
                     lambda c: c["bootstrap"].update(confidence=float("nan")),
                     lambda c: c.update(clusterByOpening={"one": "group"})]
        for mutate in mutations:
            value = copy.deepcopy(self.cfg)
            mutate(value)
            with self.subTest(config=value), self.assertRaises(ValueError):
                f.validate_config(value)

    def test_missing_duplicate_extra_or_changed_identity_fail(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            f.validate_records(self.cfg, self.rows[:-1])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            f.validate_records(self.cfg, self.rows + [self.rows[0]])
        extra = copy.deepcopy(self.rows)
        extra[0]["scheduleId"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "extra or unbound"):
            f.validate_records(self.cfg, extra)
        for field, value in (("timeMs", 11), ("candidateColor", "black"),
                             ("candidateId", "another-model"), ("baseSha256", "e" * 64)):
            changed = copy.deepcopy(self.rows)
            changed[0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                f.validate_records(self.cfg, changed)
        changed = copy.deepcopy(self.cfg)
        changed["candidate"]["sha256"] = "d" * 64
        with self.assertRaisesRegex(ValueError, "unbound"):
            f.validate_records(changed, self.rows)
        changed = copy.deepcopy(self.cfg)
        changed["runtime"] = {"engineTier": "different"}
        with self.assertRaisesRegex(ValueError, "unbound"):
            f.validate_records(changed, self.rows)

    def test_results_caps_and_failures_are_not_silently_dropped(self):
        for field, value in (("result", "*"), ("completed", False), ("status", "failed"),
                             ("nodeLimit", 10000), ("termination", "resignation")):
            changed = copy.deepcopy(self.rows)
            changed[0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                f.validate_records(self.cfg, changed)
        changed = copy.deepcopy(self.rows)
        draw = next(row for row in changed if row["termination"] == "ply-cap")
        draw["postOpeningPlies"] = 179
        with self.assertRaisesRegex(ValueError, "before registered cap"):
            f.validate_records(self.cfg, changed)
        changed = copy.deepcopy(self.rows)
        changed[0].update(result="1-0", termination="stalemate")
        with self.assertRaisesRegex(ValueError, "contradicts"):
            f.validate_records(self.cfg, changed)

    def test_json_duplicate_keys_and_nonfinite_values_rejected(self):
        for raw in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}'):
            with self.assertRaises(ValueError):
                f.decoded(raw)


class StatisticalContracts(unittest.TestCase):
    def test_candidate_color_and_draw_scoring(self):
        self.assertEqual([f.candidate_points(r, c) for c in f.COLORS for r in f.RESULTS],
                         [1, 0, .5, 0, 1, .5])

    def test_point_crossing_is_inconclusive_and_never_activates(self):
        cfg = config()
        low = [0, .25, .5, 1] * 4  # 43.75%, with substantial paired variation.
        high = [0, .5, .75, 1] * 4  # 56.25%, same openings and opposite colors.
        report = f.analyze(cfg, records(cfg, {10: low, 25: low, 100: high, 400: high}))
        self.assertEqual([r["candidateScore"] for r in report["profiles"]], [.4375, .4375, .5625, .5625])
        self.assertTrue(all(r["simultaneousInterval"][0] <= .5 <= r["simultaneousInterval"][1]
                            for r in report["profiles"]))
        self.assertEqual(report["policy"]["crossingStatus"], "not-established")
        self.assertEqual(report["policy"]["pointEstimateTransitions"],
                         [{"lowerTimeMs": 25, "upperTimeMs": 100, "direction": "candidate-improves"}])
        self.assertFalse(report["policy"]["productionEnable"])
        self.assertFalse(report["productionAdmission"])
        self.assertFalse(report["formalPass"])
        self.assertTrue(report["policy"]["requiresFreshConfirmation"])
        self.assertFalse(report["rulesReplayPerformedByAnalyzer"])

    def test_same_draws_are_reused_across_grid_and_multiplicity_is_declared(self):
        cfg = config()
        score = [.25, .5, .75, 1] * 4
        rows = records(cfg, {time: score for time in cfg["timeControlsMs"]})
        report = f.analyze(cfg, rows)
        intervals = [r["simultaneousInterval"] for r in report["profiles"]]
        self.assertTrue(all(interval == intervals[0] for interval in intervals))
        self.assertAlmostEqual(report["bootstrap"]["marginalTailProbability"], .00625)
        self.assertTrue(report["bootstrap"]["sameClusterDrawAcrossTimeGrid"])
        self.assertEqual(f.analyze(cfg, reversed(rows)), report)

    def test_coarser_clusters_preserve_endpoint_weight_not_mean_of_means(self):
        cfg = config(4)
        cfg["clusterByOpening"] = {"authored-0": "one", "authored-1": "two",
                                    "authored-2": "two", "authored-3": "two"}
        scores = {time: [0, 1, 1, 1] for time in cfg["timeControlsMs"]}
        report = f.analyze(cfg, records(cfg, scores))
        self.assertEqual(report["bootstrap"]["clusterCount"], 2)
        self.assertEqual(report["bootstrap"]["largestCluster"], 3)
        for profile in report["profiles"]:
            self.assertEqual(profile["candidateScore"], .75)  # Not (.0 + 1.) / 2.
            self.assertEqual(profile["simultaneousInterval"], [0, 1])

    def test_degenerate_bootstrap_never_claims_perfect_certainty(self):
        cfg = config(4)
        scores = {time: [1] * 4 for time in cfg["timeControlsMs"]}
        report = f.analyze(cfg, records(cfg, scores))
        self.assertEqual(report["bootstrap"]["degenerateTimesMs"], [10, 25, 100, 400])
        for profile in report["profiles"]:
            self.assertEqual(profile["simultaneousInterval"], [0, 1])
            self.assertEqual(profile["relativeElo"]["interval"], [None, None])
            self.assertIsNone(profile["relativeElo"]["point"])
            self.assertTrue(profile["relativeElo"]["lowerUnbounded"])
            self.assertTrue(profile["relativeElo"]["upperUnbounded"])
        self.assertEqual(report["policy"]["candidateConfirmationTimesMs"], [])

    def test_logistic_transform_has_no_human_rating_offset(self):
        self.assertAlmostEqual(f.relative_elo(.5), 0)
        self.assertAlmostEqual(f.relative_elo(.75), 190.84850188786498)
        self.assertAlmostEqual(f.relative_elo(.25), -190.84850188786498)
        self.assertIsNone(f.relative_elo(0))
        self.assertIsNone(f.relative_elo(1))

    def test_supported_bracket_still_requires_fresh_confirmation(self):
        profiles = [{"timeMs": 10, "candidateScore": .4, "simultaneousInterval": [.3, .49]},
                    {"timeMs": 25, "candidateScore": .7, "simultaneousInterval": [.55, .8]},
                    {"timeMs": 100, "candidateScore": .4, "simultaneousInterval": [.3, .49]}]
        policy = f.provisional_policy(profiles, .52)
        self.assertEqual(policy["crossingStatus"], "descriptive-bracket-only")
        self.assertEqual(len(policy["supportedGridBrackets"]), 2)
        self.assertEqual(policy["candidateConfirmationTimesMs"], [25])
        self.assertTrue(policy["noMonotoneCurveFit"])
        self.assertTrue(policy["noInterpolationOrExtrapolation"])
        self.assertFalse(policy["productionEnable"])

    def test_cli_binds_input_bytes_and_refuses_overwriting_report(self):
        cfg = config(4)
        rows = records(cfg, {time: [0, .25, .75, 1] for time in cfg["timeControlsMs"]})
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "config.json").write_bytes(f.encoded(cfg))
            raw = b"".join(f.encoded(row) + b"\n" for row in rows)
            (root / "games.jsonl").write_bytes(raw)
            command = [sys.executable, str(ROOT / "tools/eval_pipeline/frontier.py"),
                       "--config", str(root / "config.json"), "--records", str(root / "games.jsonl"),
                       "--out", str(root / "report.json")]
            first = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            report_raw = (root / "report.json").read_bytes()
            report = json.loads(report_raw)
            self.assertEqual(report["inputFiles"]["records"]["sha256"], f.sha(raw))
            second = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual((root / "report.json").read_bytes(), report_raw)


if __name__ == "__main__":
    unittest.main()
