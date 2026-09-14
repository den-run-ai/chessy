#!/usr/bin/env python3
"""Frozen research-only natural-game HCE screen; select before opening test.

Produces local research weights and compact reports, never runtime artifacts.
The separate test command consumes a durable exposure marker before reading
any test labels. A baseline/no-go selection cannot open the test at all.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from collections import Counter
from typing import Any

for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_name] = "1"
import numpy as np
import scipy
from scipy import optimize, sparse

ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = ROOT / "eval/training/natural-fit-v1.json"
CONTRACT_SHA = "0b258e14c66562394df4f5cea9e14bc812c85c15a19f72993f7543f206e4ddb9"
PARAMETERS = 965
PHASES = ("opening", "middlegame", "endgame")
ROLES = ("shared-train", "hce-validation", "hce-test")

# Share already audited arithmetic, not the contaminated pilot's data loader,
# selection procedure, or bounds.
_spec = importlib.util.spec_from_file_location("_natural_arithmetic", ROOT / "tools/training/analyze-hce-synthetic-pilot.py")
assert _spec is not None and _spec.loader is not None
arith = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = arith
_spec.loader.exec_module(arith)


@dataclass
class Data:
    matrix: sparse.csr_matrix
    fixed_cp: np.ndarray
    target: np.ndarray
    teacher_cp: np.ndarray
    phase: np.ndarray
    family: np.ndarray
    source: np.ndarray
    row_id: np.ndarray
    cluster: np.ndarray
    baseline_cp: np.ndarray
    fens: list[str]
    role: str

    @property
    def rows(self) -> int:
        return len(self.target)


def sha(path: Path) -> str:
    return arith.sha256_file(path)


def read_json(path: Path) -> Any:
    return arith.strict_json(path.read_bytes(), str(path))


def contract() -> dict:
    if sha(CONTRACT_PATH) != CONTRACT_SHA:
        raise ValueError("frozen fit preregistration changed")
    return read_json(CONTRACT_PATH)


def publish(path: Path, payload: Any, expected: dict[Path, str]) -> None:
    encoded = (json.dumps(payload, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        for filename, wanted in expected.items():
            if sha(filename) != wanted:
                raise ValueError(f"authenticated input changed: {filename}")
        os.link(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


FEATURE_JS = r"""
const fs=require('fs');
const B=require('./test/training/hce-r3-baseline');
const L=require('./test/training/hce-r3-linear');
const C=require('./test/training/corpus');
const W=require('./test/wasm-test-engine');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
if(input.metadata){process.stdout.write(JSON.stringify({center:B.baselineCenter(),scales:B.regularizationScales()}));}
else for(const row of input.rows){
  const c=L.compile(row.fen);
  process.stdout.write(JSON.stringify({id:row.id,cluster:C.clusterKey(row.fen),
    family:C.positionFamilyKey(row.fen),phase:C.phaseBucket(row.fen),
    fixedCp:c.fixedCp,indices:c.sparse.map(x=>x[0]),data:c.sparse.map(x=>x[1]),
    baselineCp:W.engine.evaluate(row.fen),
    candidateCp:input.weights?L.runtimeRoundedScore(c,input.weights):null})+'\n');
}
"""


def node_features(payload: dict) -> bytes:
    result = subprocess.run(["node", "-e", FEATURE_JS], cwd=ROOT,
                            input=json.dumps(payload).encode(), capture_output=True, check=True)
    return result.stdout


def metadata() -> tuple[np.ndarray, np.ndarray]:
    result = arith.strict_json(node_features({"metadata": True}), "baseline metadata")
    center, scales = np.asarray(result["center"], float), np.asarray(result["scales"], float)
    if center.shape != (PARAMETERS,) or scales.shape != (PARAMETERS,) or not np.all(scales > 0):
        raise ValueError("baseline metadata dimensions or scales differ")
    if not np.all(center == np.rint(center)) or np.any(center[753:] != 0):
        raise ValueError("baseline is not the integer center plus zero expanded terms")
    return center, scales


def closure() -> dict[Path, str]:
    paths = [Path(__file__), CONTRACT_PATH,
             ROOT / "tools/training/analyze-hce-synthetic-pilot.py",
             ROOT / "eval/training/natural-pilot-v1.json",
             ROOT / "eval/training/natural-teacher-v1.json",
             ROOT / "test/training/hce-r3-baseline.js",
             ROOT / "test/training/hce-r3-linear.js",
             ROOT / "test/training/hce-r3-features.js",
             ROOT / "test/training/corpus.js", ROOT / "test/wasm-test-engine.js",
             ROOT / "assets/engine.js", ROOT / "assets/wasm-engine.js",
             ROOT / "assets/chessy-ai-fast.wasm", ROOT / "experiments/wasm/src/eval.rs"]
    return {path: sha(path) for path in paths}


def require_dependencies() -> None:
    if np.__version__ != "2.3.5" or scipy.__version__ != "1.17.0":
        raise ValueError("natural fit requires NumPy 2.3.5 and SciPy 1.17.0 before data access")


def child(directory: Path, name: str) -> Path:
    if not isinstance(name, str) or Path(name).name != name or name in ("", ".", ".."):
        raise ValueError("audit artifact must be a direct child")
    return directory.resolve() / name


def authenticate_audits(summary_path: Path, selection_path: Path,
                        selection_audit_path: Path, selection_audit_sha: str,
                        label_audit_path: Path, label_audit_sha: str) -> tuple[dict[Path, str], dict]:
    """Require externally hash-bound PASS reports and the exact audited closure.

    Rehashing teacher/test bytes here is mechanical artifact authentication;
    no rows, scores, moves, losses, or model predictions are decoded by it.
    """
    expected: dict[Path, str] = {}
    reports, merged = {}, {}
    for kind, path, wanted, schema, field in (
            ("selection", selection_audit_path, selection_audit_sha,
             "chessy.natural-selection-independent-audit.v1", "inputs"),
            ("label", label_audit_path, label_audit_sha,
             "chessy.natural-label-artifact-independent-audit.v1", "files")):
        path = path.resolve()
        arith.require_hash(wanted, kind + " audit external SHA-256")
        if path.is_symlink() or sha(path) != wanted:
            raise ValueError(kind + " audit external identity differs")
        report = read_json(path)
        if (report.get("schema") != schema or report.get("status") != "PASS"
                or report.get("researchOnly") is not True or report.get("productionFitAllowed") is not False
                or report.get("counts", {}).get("mismatches") != 0):
            raise ValueError(kind + " independent audit must PASS without mismatches")
        bindings = report.get(field)
        if not isinstance(bindings, dict) or not bindings:
            raise ValueError(kind + " audit has no authenticated evidence closure")
        normalized = {}
        for filename, identity in bindings.items():
            filename = Path(filename)
            if not filename.is_absolute() or str(filename.resolve()) != str(filename) or filename.is_symlink():
                raise ValueError("audit evidence path must be absolute, canonical, and nonsymlink")
            if not isinstance(identity, dict) or type(identity.get("bytes")) is not int or identity["bytes"] < 0:
                raise ValueError("audit evidence bytes malformed")
            arith.require_hash(identity.get("sha256"), "audit evidence SHA-256")
            value = {"sha256": identity["sha256"], "bytes": identity["bytes"]}
            if filename in merged and merged[filename] != value:
                raise ValueError("independent audits disagree on shared evidence")
            normalized[filename] = value
            merged[filename] = value
        reports[kind] = (report, normalized)
        expected[path] = wanted

    summary, selection = read_json(summary_path), read_json(selection_path)
    source_count, selected_count = selection["source"]["games"], selection["selection"]["rows"]
    selection_report, selected_files = reports["selection"]
    label_report, label_files = reports["label"]
    counts = selection_report["counts"]
    if (selection_report.get("teacherLabelsRead") != 0
            or counts.get("sourceInventoryRowsAuthenticated") != source_count
            or any(counts.get(key) != selected_count for key in (
                "selectedRows", "sourceGames", "clusters", "fullLegalPrefixReplays", "javascriptCorpusKeyComparisons"))
            or any(counts.get(key) != 0 for key in ("quarantineIntersections", "crossRoleSourceOrFamilyOverlap"))
            or selection_report.get("coverage") != selection["coverage"]):
        raise ValueError("selection audit completeness or isolation differs")
    counts, output = label_report["counts"], summary["output"]
    if (label_report.get("modelEvaluationPerformed") is not False
            or label_report.get("fitExclusionGateSatisfied") is not True
            or any(counts.get(key) != selected_count for key in (
                "selectedRows", "fullSourceHistoryReplays", "rawAdmissionReconstructions", "terminalBestmovesChecked"))
            or counts.get("acceptedRows") != output["acceptedRows"]
            or counts.get("excludedRows") != output["excludedRows"]
            or counts.get("acceptedFullPvLegalityChecks") != output["acceptedRows"]
            or counts.get("workersCompleted") != 8):
        raise ValueError("label audit completeness or fit admission differs")

    def need(files: dict, filename: Path, identity: dict | None = None) -> None:
        filename = filename.resolve()
        if filename not in files:
            raise ValueError("audit omitted mandatory raw/source evidence: " + str(filename))
        if identity is not None and any(files[filename][key] != identity[key] for key in ("sha256", "bytes")):
            raise ValueError("audit evidence does not bind the exact artifact identity")

    need(selected_files, selection_path)
    need(label_files, selection_path)
    need(label_files, summary_path)
    need(selected_files, ROOT / "tools/training/audit-natural-selection.py")
    need(label_files, ROOT / "tools/training/audit-natural-labels.py")
    for entry in (selection["preregistration"], selection["fitPreregistration"], selection["teacherContract"]):
        need(selected_files, ROOT / entry["path"], entry)
        need(label_files, ROOT / entry["path"], entry)
    for entry in selection["implementation"]:
        need(selected_files, ROOT / entry["path"], entry)
    for entry in selection["quarantine"]["sourceFiles"]:
        if not any(value["sha256"] == entry["sha256"] and value["bytes"] == entry["bytes"] for value in selected_files.values()):
            raise ValueError("selection audit omitted mandatory quarantine evidence")
    for entry in selection["selection"]["files"]:
        filename = child(selection_path.parent, entry["path"])
        need(selected_files, filename, entry)
        need(label_files, filename, entry)
    entry = selection["selection"]["sourceInventory"]
    need(selected_files, child(selection_path.parent, entry["path"]), entry)
    if not any(value["sha256"] == selection["source"]["sha256"] and value["bytes"] == selection["source"]["bytes"] for value in selected_files.values()):
        raise ValueError("selection audit omitted full compressed source archive")
    teacher_hash = summary["teacher"]["engine"]["executable"]["sha256"]
    if not any(value["sha256"] == teacher_hash for value in label_files.values()):
        raise ValueError("label audit omitted the pinned teacher executable")
    for relative, wanted in summary["provenance"]["implementation"].items():
        filename = (ROOT / relative).resolve()
        need(label_files, filename)
        if label_files[filename]["sha256"] != wanted:
            raise ValueError("label audit implementation closure differs")
    raw = [*output["files"], output["exclusions"]]
    workers = summary.get("workers", [])
    if len(workers) != 8 or [worker["slot"] for worker in workers] != list(range(8)):
        raise ValueError("audit worker inventory differs")
    for worker in workers:
        raw.extend((worker["transcript"], worker["partition"]))
    for entry in raw:
        need(label_files, child(summary_path.parent, entry["path"]), entry)
    wanted_names = {summary_path.name, *(entry["path"] for entry in raw)}
    if {path.name for path in summary_path.parent.iterdir()} != wanted_names:
        raise ValueError("closed label directory contains missing or unaccounted raw artifacts")
    for filename, identity in merged.items():
        if filename.stat().st_size != identity["bytes"] or sha(filename) != identity["sha256"]:
            raise ValueError("independently audited evidence changed: " + str(filename))
        expected[filename] = identity["sha256"]
    encoded = json.dumps({str(path): value for path, value in sorted(merged.items())}, sort_keys=True, separators=(",", ":")).encode()
    evidence = {"selectionAuditPath": str(selection_audit_path.resolve()), "selectionAuditSha256": selection_audit_sha,
                "labelAuditPath": str(label_audit_path.resolve()), "labelAuditSha256": label_audit_sha,
                "auditedClosureSha256": hashlib.sha256(encoded).hexdigest(), "auditedFiles": len(merged)}
    return expected, evidence


def exposure_marker(summary_path: Path, selection_manifest_sha: str, teacher_sha: str) -> Path:
    # State lives beside the immutable experiment inputs, outside the audited label
    # directory. Every copied/renamed frozen selection resolves to this key.
    identity = "\0".join(("chessy.natural-fit-test-exposure.v1", selection_manifest_sha, CONTRACT_SHA, teacher_sha))
    key = hashlib.sha256(identity.encode()).hexdigest()
    return summary_path.resolve().parent.parent / ".natural-fit-state" / (key + ".hce-test-opened.json")


def load_summary(path: Path, selection_path: Path) -> tuple[dict, dict[Path, str]]:
    summary = read_json(path)
    if summary.get("schema") != "chessy.natural-pilot-label-summary.v1" or summary.get("status") != "completed":
        raise ValueError("all labels must be completed before any fit")
    provenance = summary.get("provenance", {})
    if provenance.get("fitPreregistrationSha256") != CONTRACT_SHA:
        raise ValueError("labels do not bind the frozen fit preregistration")
    if provenance.get("selectionManifestSha256") != sha(selection_path):
        raise ValueError("labels do not bind the selection manifest")
    for name in ("preregistrationSha256", "teacherManifestSha256", "sourceSha256", "sourceUncompressedSha256"):
        arith.require_hash(provenance.get(name), name)
    output = summary.get("output", {})
    if (type(output.get("selectedRows")) is not int or type(output.get("acceptedRows")) is not int
            or type(output.get("excludedRows")) is not int
            or output["selectedRows"] != output["acceptedRows"] + output["excludedRows"]):
        raise ValueError("label partition accounting differs")
    files = output.get("files", [])
    if len({item["role"] for item in files}) != len(files) or not set(ROLES).issubset({item["role"] for item in files}):
        raise ValueError("label summary role files are incomplete/duplicated")
    if sum(item["rows"] for item in files) != output["acceptedRows"]:
        raise ValueError("accepted role totals differ")
    selection = read_json(selection_path)
    if (selection.get("schema") != "chessy.natural-pilot-selection.v1"
            or selection.get("status") != "complete-research-only-selection"
            or selection.get("productionFitAllowed") is not False
            or selection.get("coverage", {}).get("fullPilotReady") is not True
            or selection.get("coverage", {}).get("failedGates") != []):
        raise ValueError("selection is incomplete or failed preregistered coverage; no v1 fit")
    rules_path = ROOT / "eval/training/natural-pilot-v1.json"
    teacher_path = ROOT / "eval/training/natural-teacher-v1.json"
    rules, teacher = read_json(rules_path), read_json(teacher_path)
    for provenance_key, selection_key, local_path in (
            ("preregistrationSha256", "preregistration", rules_path),
            ("fitPreregistrationSha256", "fitPreregistration", CONTRACT_PATH),
            ("teacherManifestSha256", "teacherContract", teacher_path)):
        if provenance[provenance_key] != selection.get(selection_key, {}).get("sha256") or sha(local_path) != provenance[provenance_key]:
            raise ValueError("preregistration/teacher identity differs between labels, selection, or local frozen file")
    if summary.get("teacher") != teacher:
        raise ValueError("summary teacher differs from the frozen teacher")
    source = selection.get("source", {})
    if (source.get("sha256") != rules["source"]["sha256"]
            or source.get("games") != rules["source"]["games"]
            or source.get("license") != "CC0-1.0"
            or provenance["sourceSha256"] != source.get("sha256")
            or provenance["sourceUncompressedSha256"] != source.get("uncompressedSha256")):
        raise ValueError("authenticated source identity differs")
    selected = selection.get("selection", {})
    if (output["selectedRows"] != selected.get("rows") or output["selectedRows"] <= 0
            or selected.get("uniqueSourceGames") != selected["rows"]
            or selected.get("uniqueClusters") != selected["rows"]
            or sum(selected.get("sourceDispositions", {}).values()) != source["games"]):
        raise ValueError("complete source/selection partition accounting differs")
    fraction = output["excludedRows"] / output["selectedRows"]
    if fraction > rules["teacher"]["maximumExclusionFractionForFitting"]:
        raise ValueError("teacher exclusion fraction exceeds frozen 10% limit")
    if output.get("exclusionFraction") != fraction:
        raise ValueError("teacher exclusion fraction differs from counts")
    if any(summary.get("failures", [])):
        raise ValueError("teacher run reports failures")
    summary["_selectionManifest"], summary["_selectionDirectory"], summary["_rules"] = selection, selection_path.parent, rules
    expected = {p: sha(p) for p in (path, selection_path, rules_path, teacher_path)}
    return summary, expected


def role_file(summary: dict, root: Path, role: str) -> tuple[Path, dict]:
    matches = [item for item in summary["output"]["files"] if item["role"] == role]
    if len(matches) != 1:
        raise ValueError("missing or duplicate role file")
    info = matches[0]
    path = root / info["path"]
    if path.resolve().parent != root.resolve() or path.is_symlink():
        raise ValueError("role file must be a direct nonsymlink child of label directory")
    arith.require_hash(info["sha256"], "role stream sha256")
    return path, info


def check_teacher(t: dict, rules: dict) -> None:
    if type(t.get("scoreCp")) is not int or abs(t["scoreCp"]) > rules["maxAbsCp"]:
        raise ValueError("teacher CP violates frozen admission rule")
    wdl = t.get("wdl")
    if not isinstance(wdl, list) or len(wdl) != 3 or any(type(v) is not int or v < 0 for v in wdl) or sum(wdl) != 1000:
        raise ValueError("teacher WDL is malformed")
    if t.get("targetWhite") != (wdl[0] + 0.5 * wdl[1]) / 1000:
        raise ValueError("teacher target does not match white WDL")
    if (any(type(t.get(k)) is not int for k in ("depth", "seldepth", "nodes", "scoreNodes"))
            or t["depth"] < rules["minimumDepth"] or t["seldepth"] < t["depth"]
            or t["nodes"] < rules["minimumReportedNodes"] or not 0 < t["scoreNodes"] <= t["nodes"]):
        raise ValueError("teacher depth/nodes violate admission")
    pv = t.get("pv")
    if not isinstance(pv, list) or not pv or pv[0] != t.get("bestmove") or any(not isinstance(v, str) or not v for v in pv):
        raise ValueError("teacher bestmove/PV disagree")


def load_role(summary: dict, directory: Path, role: str, center: np.ndarray, rules: dict,
              expected: dict[Path, str]) -> Data:
    path, info = role_file(summary, directory, role)
    if sha(path) != info["sha256"] or path.stat().st_size != info["bytes"]:
        raise ValueError(f"{role}: stream bytes/hash changed")
    expected[path] = info["sha256"]
    rows = [arith.strict_json(line, f"{role}:{n}") for n, line in enumerate(path.read_bytes().splitlines(), 1)]
    if len(rows) != info["rows"] or len(rows) < rules["minimumRows"][role]:
        raise ValueError(f"{role}: insufficient or mismatched admitted rows")
    source_entry = next(item for item in summary["_selectionManifest"]["selection"]["files"] if item["role"] == role)
    source_path = summary["_selectionDirectory"] / source_entry["path"]
    if (source_path.resolve().parent != summary["_selectionDirectory"].resolve()
            or source_path.is_symlink() or sha(source_path) != source_entry["sha256"]
            or source_path.stat().st_size != source_entry["bytes"]):
        raise ValueError("selected role file changed")
    expected[source_path] = source_entry["sha256"]
    source_rows = [arith.strict_json(line, "selected role row") for line in source_path.read_bytes().splitlines()]
    source_index = {row["id"]: row for row in source_rows}
    if len(source_rows) != source_entry["rows"] or len(source_index) != len(source_rows):
        raise ValueError("selected role row accounting differs")
    role_low, role_high = summary["_rules"]["selection"]["roles"][role]
    for row in rows:
        selected_row = {key: value for key, value in row.items() if key != "teacher"}
        if source_index.get(row["id"]) != selected_row:
            raise ValueError("accepted row does not preserve the selected source row")
        cell = int(row["positionFamily"][:12], 16) % 100
        if not role_low <= cell < role_high:
            raise ValueError("family hashes to a different role")
        if row.get("schema") != "chessy.natural-pilot-row.v1" or row.get("role") != role:
            raise ValueError("unexpected row schema or split")
        for name in ("id", "cluster", "positionFamily"):
            arith.require_hash(row.get(name), name)
        if not isinstance(row.get("sourceId"), str) or not row["sourceId"]:
            raise ValueError("source game identity missing")
        source = row.get("sourceGame", {})
        if source.get("id") != row["sourceId"]:
            raise ValueError("source game lineage differs")
        arith.require_hash(source.get("rawSha256"), "source game hash")
        check_teacher(row.get("teacher", {}), rules["teacherAdmission"])
    features = [arith.strict_json(line, "Node feature row") for line in
                node_features({"rows": [{"id": r["id"], "fen": r["fen"]} for r in rows]}).splitlines()]
    if len(features) != len(rows):
        raise ValueError("feature streamer row count differs")
    indptr, indices, values = [0], [], []
    for row, feature in zip(rows, features):
        if any(feature[k] != row[r] for k, r in (("id", "id"), ("cluster", "cluster"), ("family", "positionFamily"), ("phase", "phaseBucket"))):
            raise ValueError("computed FEN identity/phase differs from selected row")
        indices.extend(feature["indices"])
        values.extend(feature["data"])
        indptr.append(len(indices))
    data = Data(sparse.csr_matrix((values, indices, indptr), shape=(len(rows), PARAMETERS)),
                np.asarray([f["fixedCp"] for f in features]),
                np.asarray([r["teacher"]["targetWhite"] for r in rows]),
                np.asarray([r["teacher"]["scoreCp"] for r in rows]),
                np.asarray([r["phaseBucket"] for r in rows]),
                np.asarray([r["positionFamily"] for r in rows]),
                np.asarray([r["sourceId"] for r in rows]),
                np.asarray([r["id"] for r in rows]),
                np.asarray([r["cluster"] for r in rows]),
                np.asarray([f["baselineCp"] for f in features]), [r["fen"] for r in rows], role)
    if len(set(data.row_id)) != data.rows or len(set(data.cluster)) != data.rows or len(set(data.source)) != data.rows:
        raise ValueError("duplicate row, model-equivalence cluster, or source game")
    if max(Counter(data.family).values()) > summary["_rules"]["selection"]["maximumRowsPerFamily"]:
        raise ValueError("position-family cap exceeded")
    if not np.array_equal(arith.runtime_predictions(data, center), data.baseline_cp):
        raise ValueError("baseline integer reconstruction differs from shipped WASM")
    return data


def identities(data: Data) -> dict[str, list[str]]:
    return {key: sorted(set(getattr(data, key).tolist())) for key in ("row_id", "cluster", "family", "source")}


def assert_disjoint(left: dict[str, list[str]], right: dict[str, list[str]]) -> None:
    for key in left:
        if set(left[key]) & set(right[key]):
            raise ValueError(f"cross-role {key} contamination")


def bounds(center: np.ndarray, train: Data) -> tuple[np.ndarray, np.ndarray]:
    low, high = center.copy(), center.copy()
    low[:17], high[:17] = np.ceil(center[:17] * .75), np.floor(center[:17] * 1.25)
    low[17:753], high[17:753] = center[17:753] - 10, center[17:753] + 10
    low[753:759], high[753:759] = 0, 20
    supported = np.asarray(train.matrix.getnnz(axis=0)) > 0
    low[~supported], high[~supported] = center[~supported], center[~supported]
    if np.any(low > center) or np.any(high < center) or np.any(low > high) or np.any(low[:4] <= 0):
        raise ValueError("baseline/mobility not feasible")
    return low, high


def fit(train: Data, center: np.ndarray, scales: np.ndarray, k: float,
        end: int, lam: float, limits: tuple[np.ndarray, np.ndarray], rules: dict) -> tuple[np.ndarray, dict]:
    low, high = limits
    active = np.flatnonzero((np.arange(PARAMETERS) < end) & (low < high))
    matrix = train.matrix[:, active]
    base = train.fixed_cp + train.matrix @ center
    factor = k / 400

    def objective(x):
        delta = x - center[active]
        logits = factor * (base + matrix @ delta)
        residual = arith.sigmoid(logits) - train.target
        penalty = .5 * lam * np.sum((delta / scales[active]) ** 2) / PARAMETERS
        loss = np.mean(np.logaddexp(0, logits) - train.target * logits) + penalty
        gradient = factor * np.asarray(matrix.T @ residual).reshape(-1) / train.rows
        gradient += lam * delta / (PARAMETERS * scales[active] ** 2)
        return float(loss), gradient

    options = rules["solver"]
    if len(active):
        result = optimize.minimize(objective, center[active], jac=True, method="L-BFGS-B",
            bounds=list(zip(low[active], high[active])), options={"maxiter": options["maxIterations"],
            "gtol": options["gradientTolerance"], "ftol": options["functionTolerance"], "maxls": options["maxLineSearchSteps"]})
        weights = center.copy()
        weights[active] = np.clip(np.rint(result.x), low[active], high[active])
        info = {"success": bool(result.success), "message": str(result.message), "iterations": int(result.nit), "objective": float(result.fun)}
    else:
        weights, info = center.copy(), {"success": True, "message": "no supported free columns", "iterations": 0}
    info.update(activeParameters=len(active), parametersAtBounds=int(np.sum((weights[active] == low[active]) | (weights[active] == high[active]))))
    return weights, info


def metrics(data: Data, weights: np.ndarray, k: float) -> dict:
    cp = arith.runtime_predictions(data, weights)
    loss, error = arith.row_losses(cp, data.target, k), cp - data.teacher_cp
    def subset(mask):
        return {"rows": int(np.sum(mask)), "crossEntropy": float(np.mean(loss[mask])),
                "teacherCpMae": float(np.mean(np.abs(error[mask]))), "teacherCpRmse": float(np.sqrt(np.mean(error[mask] ** 2)))}
    result = subset(np.ones(data.rows, bool))
    result["byPhase"] = {phase: subset(data.phase == phase) if np.any(data.phase == phase) else {"rows": 0} for phase in PHASES}
    return result


def guard(base: dict, candidate: dict, rules: dict) -> list[str]:
    policy = rules["selection"]
    reasons = []
    gain = (base["crossEntropy"] - candidate["crossEntropy"]) / base["crossEntropy"]
    if gain < policy["minimumRelativeCeGain"]:
        reasons.append("relative-cross-entropy-gain-below-0.5-percent")
    for metric, bound in (("teacherCpMae", "maximumRelativeCpMaeDeterioration"), ("teacherCpRmse", "maximumRelativeCpRmseDeterioration")):
        if candidate[metric] > base[metric] * (1 + policy[bound]):
            reasons.append(metric + "-deterioration-over-2-percent")
    for phase in PHASES:
        b, c = base["byPhase"][phase], candidate["byPhase"][phase]
        if b["rows"] >= policy["minimumRowsForPhaseGuard"] and c["crossEntropy"] > b["crossEntropy"] * (1 + policy["maximumPhaseRelativeCeDeterioration"]):
            reasons.append(phase + "-cross-entropy-deterioration-over-1-percent")
    return reasons


def coverage(data: Data) -> dict:
    return {"rows": data.rows, "uniqueSourceGames": len(set(data.source)), "positionFamilies": len(set(data.family)),
            "phases": {phase: int(np.sum(data.phase == phase)) for phase in PHASES},
            "baselineWasmParityRows": data.rows, "baselineWasmParityMismatches": 0,
            "features": arith.feature_coverage(data)}


def candidate_parity(data: Data, weights: np.ndarray) -> None:
    features = [arith.strict_json(line, "candidate parity") for line in node_features({"rows": [
        {"id": i, "fen": fen} for i, fen in zip(data.row_id.tolist(), data.fens)], "weights": weights.astype(int).tolist()}).splitlines()]
    if not np.array_equal(arith.runtime_predictions(data, weights), [f["candidateCp"] for f in features]):
        raise ValueError("integer candidate prediction differs from Node affine implementation")


def select(summary_path: Path, selection_path: Path, output_path: Path, report_path: Path | None = None,
           *, selection_audit_path: Path, selection_audit_sha: str,
           label_audit_path: Path, label_audit_sha: str) -> dict:
    require_dependencies()
    rules = contract()
    if output_path.exists() or (report_path is not None and report_path.exists()):
        raise FileExistsError("refusing to overwrite frozen selection/report")
    expected = closure()
    summary, inputs = load_summary(summary_path, selection_path)
    expected.update(inputs)
    audited, audit_evidence = authenticate_audits(summary_path, selection_path, selection_audit_path,
                                                selection_audit_sha, label_audit_path, label_audit_sha)
    expected.update(audited)
    center, scales = metadata()
    train = load_role(summary, summary_path.parent, "shared-train", center, rules, expected)
    validation = load_role(summary, summary_path.parent, "hce-validation", center, rules, expected)
    assert_disjoint(identities(train), identities(validation))
    calibration = arith.calibration_k(train, center)
    calibration["baselineScoreForCalibration"] = "smooth affine surrogate; train only"
    k, limits = calibration["value"], bounds(center, train)
    baseline = {"train": metrics(train, center, k), "validation": metrics(validation, center, k)}
    candidates, eligible = [], []
    for surface in rules["surfaces"][1:]:
        for lam in rules["regularization"]["lambdaGrid"]:
            weights, info = fit(train, center, scales, k, surface["activeEnd"], lam, limits, rules)
            val = metrics(validation, weights, k)
            reasons = guard(baseline["validation"], val, rules)
            if not info["success"]:
                reasons.append("optimizer-failed")
            record = {"surface": surface["id"], "lambda": lam, "optimizer": info,
                      "train": metrics(train, weights, k), "validation": val, "stopReasons": reasons,
                      "weights": arith.weight_summary(weights, center, [str(i) for i in range(PARAMETERS)])}
            candidates.append(record)
            if not reasons:
                eligible.append((val["crossEntropy"], surface["activeEnd"], -lam, record, weights))
    selected_weights, chosen = center, {"surface": "baseline", "lambda": None}
    if eligible:
        minimum = min(item[0] for item in eligible)
        tied = [item for item in eligible if item[0] <= minimum + rules["selection"]["tieTolerance"]]
        _, _, _, chosen, selected_weights = min(tied, key=lambda item: (item[1], item[2]))
    candidate_parity(train, selected_weights)
    candidate_parity(validation, selected_weights)
    test_eligible = chosen["surface"] != "baseline"
    report = {"schema": "chessy.natural-pilot-fit-report.v1", "status": "validation-frozen-test-unopened",
              "researchOnly": True, "shippingCandidateEmitted": False, "eloOrTimeClaimAllowed": False,
              "fitPreregistrationSha256": CONTRACT_SHA, "labelSummarySha256": sha(summary_path),
              "selectionManifestSha256": sha(selection_path), "auditEvidence": audit_evidence, "calibration": calibration,
              "environment": {"python": sys.version.split()[0], "numpy": np.__version__, "scipy": scipy.__version__},
              "coverage": {"train": coverage(train), "validation": coverage(validation)},
              "baseline": baseline, "candidates": candidates,
              "selected": {"surface": chosen["surface"], "lambda": chosen["lambda"], "weightsSha256": arith.sha256_json_ints(selected_weights)},
              "testEligible": test_eligible, "testOpened": False, "scaleRecommended": False,
              "stopReasons": [] if test_eligible else ["no-candidate-passed-frozen-validation-guards"],
              "limitations": ["Research natural-game sample is not authenticated production training data.",
                "Teacher loss is not Elo/time evidence; no runtime integration or level recalibration authorized by this report.",
                "Baseline parity is against shipped WASM; candidate parity is between Python and Node affine arithmetic.",
                "PST and mobility restrictions intentionally prevent large evaluator drift."]}
    frozen = {"schema": "chessy.natural-pilot-frozen-selection.v1", "report": report,
              "researchWeights": selected_weights.astype(int).tolist(), "labelSummaryPath": str(summary_path),
              "selectionManifestPath": str(selection_path), "inputSha256": {str(p): h for p, h in expected.items()},
              "usedIdentities": {key: sorted(set(identities(train)[key]) | set(identities(validation)[key])) for key in identities(train)}}
    publish(output_path, frozen, expected)
    if report_path is not None:
        publish(report_path, report, expected | {output_path: sha(output_path)})
    return report


def bootstrap_families(data: Data, base: np.ndarray, candidate: np.ndarray, k: float, rules: dict) -> dict:
    delta = arith.row_losses(candidate, data.target, k) - arith.row_losses(base, data.target, k)
    sources, inverse = np.unique(data.family, return_inverse=True)
    sums, counts = np.bincount(inverse, weights=delta), np.bincount(inverse)
    policy = rules["transfer"]
    rng = np.random.default_rng(policy["bootstrapSeed"])
    draws = np.empty(policy["bootstrapIterations"])
    for i in range(len(draws)):
        picked = rng.integers(0, len(sums), len(sums))
        draws[i] = np.sum(sums[picked]) / np.sum(counts[picked])
    return {"unit": "position-family cluster; row-weighted mean", "families": len(sources), "maxRowsPerFamily": int(np.max(counts)), "iterations": len(draws),
            "seed": policy["bootstrapSeed"], "candidateMinusBaselineMean": float(np.mean(delta)),
            "ci95": np.quantile(draws, [.025, .975]).tolist()}


def evaluate_test(selection_path: Path, output_path: Path) -> dict:
    require_dependencies()
    rules, frozen = contract(), read_json(selection_path)
    if frozen.get("schema") != "chessy.natural-pilot-frozen-selection.v1":
        raise ValueError("invalid frozen selection")
    report = frozen["report"]
    if not report.get("testEligible") or report["selected"]["surface"] == "baseline":
        raise ValueError("baseline/no-go selection cannot open test")
    expected = {Path(path): value for path, value in frozen["inputSha256"].items()}
    expected[selection_path] = sha(selection_path)
    summary_path, source_manifest_path = Path(frozen["labelSummaryPath"]), Path(frozen["selectionManifestPath"])
    audit = report.get("auditEvidence", {})
    required = ("selectionAuditPath", "selectionAuditSha256", "labelAuditPath", "labelAuditSha256", "auditedClosureSha256")
    if any(key not in audit for key in required):
        raise ValueError("frozen selection lacks mandatory independent audit identities")
    audited, evidence = authenticate_audits(summary_path, source_manifest_path,
        Path(audit["selectionAuditPath"]), audit["selectionAuditSha256"], Path(audit["labelAuditPath"]), audit["labelAuditSha256"])
    if evidence != audit:
        raise ValueError("frozen independent audit evidence changed")
    if any(expected.get(path) != wanted for path, wanted in audited.items()):
        raise ValueError("frozen selection omitted independently audited evidence")
    expected.update(audited)
    for path, wanted in expected.items():
        if sha(path) != wanted:
            raise ValueError("frozen selection input changed")
    center, _ = metadata()
    weights = np.asarray(frozen["researchWeights"], float)
    if weights.shape != (PARAMETERS,) or not np.all(np.isfinite(weights)) or not np.all(weights == np.rint(weights)):
        raise ValueError("selected weights must be an integer vector")
    if arith.sha256_json_ints(weights) != report["selected"]["weightsSha256"]:
        raise ValueError("selected weights hash differs")
    if output_path.exists():
        raise FileExistsError("refusing to overwrite test report")
    # Keep the marker on every failure: once test bytes may be visible, retrying
    # is a new exposure and requires a new preregistered independent experiment.
    summary = read_json(summary_path)
    marker = exposure_marker(summary_path, report["selectionManifestSha256"],
                             summary["provenance"]["teacherManifestSha256"])
    publish(marker, {"selectionSha256": sha(selection_path), "state": "test-exposure-consumed"}, expected)
    summary_path = Path(frozen["labelSummaryPath"])
    summary, inputs = load_summary(summary_path, Path(frozen["selectionManifestPath"]))
    expected.update(inputs)
    test = load_role(summary, summary_path.parent, "hce-test", center, rules, expected)
    assert_disjoint(frozen["usedIdentities"], identities(test))
    candidate_parity(test, weights)
    k = report["calibration"]["value"]
    base, candidate = metrics(test, center, k), metrics(test, weights, k)
    reasons = guard(base, candidate, rules)
    bootstrap = bootstrap_families(test, arith.runtime_predictions(test, center), arith.runtime_predictions(test, weights), k, rules)
    if bootstrap["ci95"][1] >= rules["transfer"]["maximumCi95UpperCeDifference"]:
        reasons.append("position-family-bootstrap-upper95-not-negative")
    for phase in PHASES:
        if base["byPhase"][phase]["rows"] < rules["transfer"]["minimumRowsPerPhaseForScaling"]:
            reasons.append(phase + "-insufficient-test-coverage-for-scaling")
    result = report | {"status": "test-completed-research-only", "testOpened": True,
                       "test": {"baseline": base, "selected": candidate, "coverage": coverage(test), "pairedBootstrap": bootstrap},
                       "scaleRecommended": not reasons, "stopReasons": reasons,
                       "frozenSelectionSha256": sha(selection_path)}
    publish(output_path, result, expected | {marker: sha(marker)})
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("select")
    p.add_argument("--label-summary", type=Path, required=True)
    p.add_argument("--selection-manifest", type=Path, required=True)
    p.add_argument("--selection-audit", type=Path, required=True)
    p.add_argument("--selection-audit-sha256", required=True)
    p.add_argument("--label-audit", type=Path, required=True)
    p.add_argument("--label-audit-sha256", required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--report", type=Path)
    p = sub.add_parser("test")
    p.add_argument("--selection", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "select":
        result = select(args.label_summary.resolve(), args.selection_manifest.resolve(), args.output.resolve(), args.report.resolve() if args.report else None,
            selection_audit_path=args.selection_audit.resolve(), selection_audit_sha=args.selection_audit_sha256,
            label_audit_path=args.label_audit.resolve(), label_audit_sha=args.label_audit_sha256)
    else:
        result = evaluate_test(args.selection.resolve(), args.output.resolve())
    print(json.dumps({key: result[key] for key in ("status", "selected", "testEligible", "testOpened", "scaleRecommended", "stopReasons")}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"natural-pilot-fit: {error}", file=sys.stderr)
        raise SystemExit(1)
