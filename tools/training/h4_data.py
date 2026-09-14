"""Exact-byte recovery of the audited natural pilot for the separate H4 screen.

Authentication hashes every audit-bound artifact mechanically. Only load_role
decodes position/teacher rows, and only for its explicitly requested NNUE role.
The orchestrator owns the once-only validation/test exposure state.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = ROOT / "eval/training/natural-nnue-h4-v1.json"
CONTRACT_SHA = "9496075fddda26a02ac9a0e79a6271d914eede48eaf7e1a3a9de2de85dff1180"
ROLES = ("shared-train", "nnue-validation", "nnue-test")
_spec = importlib.util.spec_from_file_location("_h4_natural_fit", ROOT / "tools/training/natural-pilot-fit.py")
assert _spec and _spec.loader
fit = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = fit
_spec.loader.exec_module(fit)
np, sparse = fit.np, fit.sparse


def require(ok: bool, message: str) -> None:
    if not ok:
        raise ValueError(message)


def _fingerprint(info: os.stat_result) -> tuple:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def snapshot(path: Path, *, retain: bool = True) -> tuple[bytes | None, str, int]:
    """Read and hash the same descriptor; reject path replacement or mutation."""
    path = Path(path).absolute()
    require(path.resolve() == path and not path.is_symlink(), "artifact path must be nonsymlink")
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode), "artifact must be a regular file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    chunks, digest, length = [], hashlib.sha256(), 0
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        require(_fingerprint(before) == _fingerprint(opened), "artifact replaced while opening")
        while True:
            chunk = stream.read(1 << 20)
            if not chunk:
                break
            digest.update(chunk)
            length += len(chunk)
            if retain:
                chunks.append(chunk)
        require(_fingerprint(opened) == _fingerprint(os.fstat(stream.fileno())), "artifact changed during read")
        require(path.resolve() == path and _fingerprint(opened) == _fingerprint(path.lstat()),
                "artifact path replaced during read")
        require(length == opened.st_size, "artifact read size differs")
    return b"".join(chunks) if retain else None, digest.hexdigest(), length


@dataclass(frozen=True)
class Artifact:
    path: Path
    sha256: str
    size: int

    def read(self) -> bytes:
        raw, digest, size = snapshot(self.path)
        require(digest == self.sha256 and size == self.size, "authenticated artifact changed: " + str(self.path))
        assert raw is not None
        return raw


class Inventory:
    """Content-address lookup; discovery never decodes JSONL teacher rows."""
    def __init__(self, directories: list[Path]):
        self.by_sha: dict[str, list[Artifact]] = {}
        seen = set()
        for directory in directories:
            directory = Path(directory).absolute()
            require(directory.is_dir() and directory.resolve() == directory, "bundle must be an existing nonsymlink directory")
            for parent, dirs, files in os.walk(directory, followlinks=False):
                dirs[:] = sorted(d for d in dirs if d not in {".git", "node_modules", "target", "__pycache__", ".venv"}
                                 and not (Path(parent) / d).is_symlink())
                for name in sorted(files):
                    path = Path(parent) / name
                    if path in seen or path.is_symlink() or not path.is_file():
                        continue
                    seen.add(path)
                    _, digest, size = snapshot(path, retain=False)
                    self.by_sha.setdefault(digest, []).append(Artifact(path, digest, size))

    def locate(self, wanted: str, size: int | None = None) -> Artifact:
        fit.arith.require_hash(wanted, "pinned artifact SHA-256")
        matches = [a for a in self.by_sha.get(wanted, []) if size is None or a.size == size]
        require(bool(matches), "missing exact audited artifact SHA-256 " + wanted)
        artifact = matches[0]
        _, digest, length = snapshot(artifact.path, retain=False)
        require(digest == wanted and length == artifact.size, "artifact changed after discovery")
        return artifact


def _json(artifact: Artifact) -> Any:
    return fit.arith.strict_json(artifact.read(), str(artifact.path))


def _original(name: str) -> str:
    require(isinstance(name, str) and name.startswith("/") and str(PurePosixPath(name)) == name
            and ".." not in PurePosixPath(name).parts, "original audit path must be absolute and canonical")
    return name


def _child(directory: str, name: str) -> str:
    require(isinstance(name, str) and name not in {"", ".", ".."} and PurePosixPath(name).name == name,
            "audit artifact must be a direct child")
    return str(PurePosixPath(directory) / name)


def _bindings(report: dict, field_name: str) -> dict[str, dict]:
    bindings = report.get(field_name)
    require(isinstance(bindings, dict) and bool(bindings), "audit has no evidence closure")
    result = {}
    for name, value in bindings.items():
        _original(name)
        require(isinstance(value, dict) and type(value.get("bytes")) is int and value["bytes"] >= 0,
                "audit evidence bytes malformed")
        fit.arith.require_hash(value.get("sha256"), "audit evidence SHA-256")
        result[name] = {"sha256": value["sha256"], "bytes": value["bytes"]}
    return result


def _merge_closure(selection_report: dict, label_report: dict, pins: dict) -> tuple[dict, dict, dict]:
    left, right = _bindings(selection_report, "inputs"), _bindings(label_report, "files")
    merged = dict(left)
    for name, value in right.items():
        require(name not in merged or merged[name] == value, "independent audits disagree on shared evidence")
        merged[name] = value
    raw = json.dumps(merged, sort_keys=True, separators=(",", ":")).encode()
    require(len(merged) == pins["auditedFiles"] and hashlib.sha256(raw).hexdigest() == pins["auditedClosureSha256"],
            "original audited closure identity differs")
    return left, right, merged


def _need(bindings: dict, name: str, value: dict | None = None) -> None:
    require(name in bindings, "audit omitted mandatory evidence: " + name)
    if value is not None:
        require(all(bindings[name][key] == value[key] for key in ("sha256", "bytes")), "audit artifact identity differs")


def _audit_counts(selection_report: dict, label_report: dict, selection: dict, summary: dict) -> None:
    for report, schema in ((selection_report, "chessy.natural-selection-independent-audit.v1"),
                           (label_report, "chessy.natural-label-artifact-independent-audit.v1")):
        require(report.get("schema") == schema and report.get("status") == "PASS"
                and report.get("researchOnly") is True and report.get("productionFitAllowed") is False
                and report.get("counts", {}).get("mismatches") == 0, "independent audit must PASS without mismatches")
    total, source_count = selection["selection"]["rows"], selection["source"]["games"]
    counts = selection_report["counts"]
    require(selection_report.get("teacherLabelsRead") == 0 and counts.get("sourceInventoryRowsAuthenticated") == source_count
            and all(counts.get(k) == total for k in ("selectedRows", "sourceGames", "clusters", "fullLegalPrefixReplays", "javascriptCorpusKeyComparisons"))
            and all(counts.get(k) == 0 for k in ("quarantineIntersections", "crossRoleSourceOrFamilyOverlap"))
            and selection_report.get("coverage") == selection["coverage"], "selection audit completeness or isolation differs")
    counts, output = label_report["counts"], summary["output"]
    require(label_report.get("modelEvaluationPerformed") is False and label_report.get("fitExclusionGateSatisfied") is True
            and all(counts.get(k) == total for k in ("selectedRows", "fullSourceHistoryReplays", "rawAdmissionReconstructions", "terminalBestmovesChecked"))
            and counts.get("acceptedRows") == output["acceptedRows"] and counts.get("excludedRows") == output["excludedRows"]
            and counts.get("acceptedFullPvLegalityChecks") == output["acceptedRows"] and counts.get("workersCompleted") == 8,
            "label audit completeness or admission differs")


@dataclass
class AuthenticatedData:
    summary: dict
    selection: dict
    hce_weights: np.ndarray
    evidence: dict
    expected: dict[Path, str]
    artifacts: dict[str, Artifact]
    summary_original: str
    selection_original: str
    rules: dict
    fit_rules: dict
    contract: dict
    loaded_identities: dict[str, dict] = field(default_factory=dict)


def authenticate(bundle: Path) -> AuthenticatedData:
    """Require the complete original pinned evidence; never substitute new data."""
    raw, digest, _ = snapshot(CONTRACT_PATH)
    require(digest == CONTRACT_SHA, "H4 preregistration changed")
    contract = fit.arith.strict_json(raw, "H4 contract")
    pins, comparators = contract["data"], contract["comparators"]
    inventory = Inventory([bundle, ROOT])
    expected = {CONTRACT_PATH: CONTRACT_SHA}
    def locate(wanted: str, size: int | None = None) -> Artifact:
        artifact = inventory.locate(wanted, size)
        expected[artifact.path] = artifact.sha256
        return artifact
    summary_art = locate(pins["labelSummarySha256"])
    summary = _json(summary_art)
    selection_art = locate(summary["provenance"]["selectionManifestSha256"])
    selection = _json(selection_art)
    selection_audit_art, label_audit_art = locate(pins["selectionAuditSha256"]), locate(pins["labelAuditSha256"])
    selection_audit, label_audit = _json(selection_audit_art), _json(label_audit_art)
    _audit_counts(selection_audit, label_audit, selection, summary)
    left, right, merged = _merge_closure(selection_audit, label_audit, pins)
    artifacts = {name: locate(value["sha256"], value["bytes"]) for name, value in merged.items()}
    frozen = _json(locate(comparators["selectionFileSha256"]))
    require(frozen.get("schema") == "chessy.natural-pilot-frozen-selection.v1", "frozen HCE selection schema differs")
    weights = frozen.get("researchWeights")
    require(isinstance(weights, list) and len(weights) == 965 and all(type(v) is int for v in weights), "expected 965 integer HCE weights")
    weights_hash = hashlib.sha256(json.dumps(weights, separators=(",", ":")).encode()).hexdigest()
    require(weights_hash == comparators["weightsSha256"] == frozen["report"]["selected"]["weightsSha256"], "frozen HCE weights differ")
    summary_original, selection_original = _original(frozen["labelSummaryPath"]), _original(frozen["selectionManifestPath"])
    _need(left, selection_original, {"sha256": selection_art.sha256, "bytes": selection_art.size})
    _need(right, selection_original, {"sha256": selection_art.sha256, "bytes": selection_art.size})
    _need(right, summary_original, {"sha256": summary_art.sha256, "bytes": summary_art.size})
    code_roots = [name.removesuffix("/tools/training/audit-natural-selection.py") for name in left
                  if name.endswith("/tools/training/audit-natural-selection.py")]
    require(len(code_roots) == 1, "original audit code root is ambiguous")
    code_root = code_roots[0]
    _need(right, code_root + "/tools/training/audit-natural-labels.py")
    for entry in (selection["preregistration"], selection["fitPreregistration"], selection["teacherContract"]):
        _need(left, code_root + "/" + entry["path"], entry)
        _need(right, code_root + "/" + entry["path"], entry)
    for entry in selection["implementation"]:
        _need(left, code_root + "/" + entry["path"], entry)
    for entry in selection["quarantine"]["sourceFiles"]:
        require(any(all(value[k] == entry[k] for k in ("sha256", "bytes")) for value in left.values()), "audit omitted quarantine evidence")
    selected_dir, label_dir = str(PurePosixPath(selection_original).parent), str(PurePosixPath(summary_original).parent)
    for entry in selection["selection"]["files"]:
        _need(left, _child(selected_dir, entry["path"]), entry)
        _need(right, _child(selected_dir, entry["path"]), entry)
    entry = selection["selection"]["sourceInventory"]
    _need(left, _child(selected_dir, entry["path"]), entry)
    require(any(value == {"sha256": selection["source"]["sha256"], "bytes": selection["source"]["bytes"]} for value in left.values()), "audit omitted compressed source")
    require(any(value["sha256"] == summary["teacher"]["engine"]["executable"]["sha256"] for value in right.values()), "audit omitted teacher executable")
    for relative, wanted in summary["provenance"]["implementation"].items():
        name = code_root + "/" + relative
        _need(right, name)
        require(right[name]["sha256"] == wanted, "label implementation closure differs")
    workers = summary.get("workers", [])
    require(len(workers) == 8 and [w["slot"] for w in workers] == list(range(8)), "worker partition inventory differs")
    raw_entries = [*summary["output"]["files"], summary["output"]["exclusions"]]
    for worker in workers:
        raw_entries.extend((worker["transcript"], worker["partition"]))
    raw_names = [summary_original, *[_child(label_dir, entry["path"]) for entry in raw_entries]]
    require(len(raw_names) == len(set(raw_names)), "duplicate original label artifact name")
    require({name for name in right if str(PurePosixPath(name).parent) == label_dir} == set(raw_names), "closed label inventory differs")
    for entry in raw_entries:
        _need(right, _child(label_dir, entry["path"]), entry)
    rules = _json(artifacts[code_root + "/" + selection["preregistration"]["path"]])
    fit_rules = _json(artifacts[code_root + "/" + selection["fitPreregistration"]["path"]])
    teacher = _json(artifacts[code_root + "/" + selection["teacherContract"]["path"]])
    _validate_summary(summary, selection, rules, teacher, pins)
    # The implementation we execute must match the frozen HCE selection inputs,
    # even when archival audit implementations were recovered elsewhere.
    for path in fit.closure():
        relative = str(path.relative_to(ROOT))
        matches = [wanted for name, wanted in frozen["inputSha256"].items() if name.endswith("/" + relative)]
        require(len(set(matches)) == 1, "frozen HCE selection omitted current feature dependency " + relative)
        _, actual, _ = snapshot(path, retain=False)
        require(actual == matches[0], "current HCE feature dependency changed: " + relative)
        expected[path] = actual
    require(expected[ROOT / "assets/chessy-ai-fast.wasm"] == comparators["shipped"].rsplit(" ", 1)[-1], "shipped WASM comparator identity differs")
    evidence = {"selectionAuditPath": str(selection_audit_art.path), "selectionAuditSha256": selection_audit_art.sha256,
                "labelAuditPath": str(label_audit_art.path), "labelAuditSha256": label_audit_art.sha256,
                "auditedClosureSha256": pins["auditedClosureSha256"], "auditedFiles": len(merged),
                "originalClosure": merged, "relocations": {name: str(a.path) for name, a in artifacts.items()},
                "modelPerformanceOpened": False, "researchOnly": True, "productionFitAllowed": False}
    return AuthenticatedData(summary, selection, np.asarray(weights, dtype=np.int64), evidence, expected,
                             artifacts, summary_original, selection_original, rules, fit_rules, contract)


def _validate_summary(summary: dict, selection: dict, rules: dict, teacher: dict, pins: dict) -> None:
    require(summary.get("schema") == "chessy.natural-pilot-label-summary.v1" and summary.get("status") == "completed"
            and not any(summary.get("failures", [])), "label run incomplete or failed")
    require(selection.get("schema") == "chessy.natural-pilot-selection.v1" and selection.get("status") == "complete-research-only-selection"
            and selection.get("productionFitAllowed") is False and selection.get("coverage", {}).get("fullPilotReady") is True
            and selection["coverage"].get("failedGates") == [], "selection admission failed")
    provenance, output, source = summary["provenance"], summary["output"], selection["source"]
    for key, field_name in (("preregistrationSha256", "preregistration"), ("fitPreregistrationSha256", "fitPreregistration"),
                            ("teacherManifestSha256", "teacherContract")):
        require(provenance[key] == selection[field_name]["sha256"], "label/selection contract differs")
    require(provenance["fitPreregistrationSha256"] == fit.CONTRACT_SHA and summary["teacher"] == teacher, "frozen teacher or fit contract differs")
    require(source["sha256"] == pins["sourceSha256"] == rules["source"]["sha256"] == provenance["sourceSha256"]
            and source["uncompressedSha256"] == provenance["sourceUncompressedSha256"]
            and source["games"] == rules["source"]["games"] == 121332 and source["license"] == "CC0-1.0", "source identity differs")
    require((output["selectedRows"], output["acceptedRows"], output["excludedRows"]) == (50000, 47203, 2797)
            and output["selectedRows"] == output["acceptedRows"] + output["excludedRows"], "label partition count differs")
    selected = selection["selection"]
    require(selected["rows"] == selected["uniqueSourceGames"] == selected["uniqueClusters"] == output["selectedRows"]
            and sum(selected["sourceDispositions"].values()) == source["games"], "selection partition count differs")
    fraction = output["excludedRows"] / output["selectedRows"]
    require(output["exclusionFraction"] == fraction <= rules["teacher"]["maximumExclusionFractionForFitting"], "exclusion fraction differs")
    files = output["files"]
    require(len(files) == 5 and len({item["role"] for item in files}) == 5
            and {item["role"] for item in files} == set(ROLES) | {"hce-validation", "hce-test"}
            and sum(item["rows"] for item in files) == output["acceptedRows"], "accepted role partition differs")
    for role, wanted in pins["rows"].items():
        require(next(item["rows"] for item in files if item["role"] == role) == wanted, "frozen role count differs")


def _role_rows(auth: AuthenticatedData, role: str) -> list[dict]:
    require(role in ROLES, "only shared-train and reserved NNUE roles may be decoded")
    def read_entry(entries: list[dict], original: str) -> tuple[list[dict], dict]:
        found = [item for item in entries if item["role"] == role]
        require(len(found) == 1, "missing or duplicate role entry")
        entry = found[0]
        artifact = auth.artifacts[_child(str(PurePosixPath(original).parent), entry["path"])]
        require(artifact.sha256 == entry["sha256"] and artifact.size == entry["bytes"], "role artifact identity differs")
        rows = [fit.arith.strict_json(line, role + " role row") for line in artifact.read().splitlines()]
        require(len(rows) == entry["rows"], "role partition count differs")
        return rows, entry
    rows, _ = read_entry(auth.summary["output"]["files"], auth.summary_original)
    require(len(rows) == auth.contract["data"]["rows"][role], "frozen admitted role count differs")
    source_rows, _ = read_entry(auth.selection["selection"]["files"], auth.selection_original)
    source_index = {row["id"]: row for row in source_rows}
    require(len(source_index) == len(source_rows), "duplicate selected row ID")
    for row in rows:
        require(source_index.get(row["id"]) == {k: v for k, v in row.items() if k != "teacher"}, "accepted row changed selected source")
        require(row.get("schema") == "chessy.natural-pilot-row.v1" and row.get("role") == role, "row schema or role differs")
        for name in ("id", "cluster", "positionFamily"):
            fit.arith.require_hash(row.get(name), name)
        low, high = auth.rules["selection"]["roles"][role]
        require(low <= int(row["positionFamily"][:12], 16) % 100 < high, "family hashes to another role")
        require(isinstance(row.get("sourceId"), str) and bool(row["sourceId"])
                and row.get("sourceGame", {}).get("id") == row["sourceId"], "source game lineage differs")
        fit.arith.require_hash(row["sourceGame"].get("rawSha256"), "source game hash")
        fit.check_teacher(row.get("teacher", {}), auth.fit_rules["teacherAdmission"])
    for key in ("id", "cluster", "sourceId"):
        require(len({row[key] for row in rows}) == len(rows), "duplicate admitted " + key)
    require(max(Counter(row["positionFamily"] for row in rows).values(), default=0)
            <= auth.rules["selection"]["maximumRowsPerFamily"], "position-family cap exceeded")
    return rows


def load_role(auth: AuthenticatedData, role: str) -> fit.Data:
    """Decode exactly one requested role, with parity against frozen shipped HCE."""
    rows = _role_rows(auth, role)
    features = [fit.arith.strict_json(line, "Node feature row") for line in
                fit.node_features({"rows": [{"id": row["id"], "fen": row["fen"]} for row in rows]}).splitlines()]
    require(len(features) == len(rows), "feature row count differs")
    indptr, indices, values = [0], [], []
    for row, feature in zip(rows, features):
        require(all(feature[k] == row[r] for k, r in (("id", "id"), ("cluster", "cluster"),
                    ("family", "positionFamily"), ("phase", "phaseBucket"))), "computed FEN identity or phase differs")
        indices.extend(feature["indices"])
        values.extend(feature["data"])
        indptr.append(len(indices))
    data = fit.Data(sparse.csr_matrix((values, indices, indptr), shape=(len(rows), 965)),
                    np.asarray([f["fixedCp"] for f in features]), np.asarray([r["teacher"]["targetWhite"] for r in rows]),
                    np.asarray([r["teacher"]["scoreCp"] for r in rows]), np.asarray([r["phaseBucket"] for r in rows]),
                    np.asarray([r["positionFamily"] for r in rows]), np.asarray([r["sourceId"] for r in rows]),
                    np.asarray([r["id"] for r in rows]), np.asarray([r["cluster"] for r in rows]),
                    np.asarray([f["baselineCp"] for f in features]), [r["fen"] for r in rows], role)
    center, _ = fit.metadata()
    require(np.array_equal(fit.arith.runtime_predictions(data, center), data.baseline_cp), "baseline reconstruction differs from shipped WASM")
    identities = fit.identities(data)
    for other_role, other in auth.loaded_identities.items():
        if other_role != role:
            fit.assert_disjoint(identities, other)
    auth.loaded_identities[role] = identities
    return data
