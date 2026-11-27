#!/usr/bin/env python3
"""Export the frozen sparse model into current-production ABI-v2 candidates.

The output is an isolated, retained source snapshot. No production file is
changed. The unchanged control must reproduce the exact base-commit WASM.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys


if __name__ == "__main__" and "_EXECUTED_BYTES" not in globals():
    _source = Path(__file__).read_bytes()
    exec(compile(_source, __file__, "exec"), {
        "__name__": "__main__", "__file__": __file__, "_EXECUTED_BYTES": _source,
    })
    raise SystemExit(0)


ROOT = Path(__file__).resolve().parents[2]
MEMORY_BYTES = 26542080
BASE = 8640
TOTAL = 17280
MODEL_BYTES = 16712
RUST_RELEASE = "1.97.1"
RUST_COMMIT = "8bab26f4f68e0e26f0bb7960be334d5b520ea452"
PRODUCTION = (
    "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "build.sh",
    "src/engine.rs", "src/eval.rs", "src/lib.rs", "src/search.rs",
)
IMPLEMENTATION = ("prepare.py", "refit_import.py", "core.rs", "simd.rs", "hce_constants.rs")
VARIANTS = ("baseline", "baseline-memory", "hce-scalar", "hce-simd", "sparse-scalar", "sparse-simd")
DEFAULT_MODEL = "eval/sparse-pesto-v1/fit/full.i16le"
DEFAULT_SELECTION = "eval/sparse-pesto-v1/fit/selection.json"
SCHEMA = "chessy.eval-pipeline-prepared.v1"


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(value) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def identity(raw: bytes) -> dict:
    return {"bytes": len(raw), "sha256": sha(raw)}


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(
        ["git", "--no-replace-objects", *args], cwd=root, stderr=subprocess.PIPE,
    )


def write_once(path: Path, raw: bytes, *, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(raw)
    path.chmod(0o555 if executable else 0o444)


def narrow(value: int, label: str) -> int:
    if not -128 <= value <= 127:
        raise ValueError(f"{label} does not fit lossless signed eight-bit storage")
    return value


def tables(raw: bytes) -> dict[str, list[list[int]]]:
    """Export exactly the v2 integer lookup representation, without rounding."""
    if len(raw) != TOTAL * 2:
        raise ValueError("expected exactly 17,280 dense little-endian i16 coefficients")
    weights = struct.unpack("<" + "h" * TOTAL, raw)
    for value in weights:
        narrow(value, "coefficient")
    fused = [[narrow(weights[stage * BASE + index % 384] +
                     weights[stage * BASE + 384 + index], "PST/own-king sum")
              for stage in range(2)] for index in range(3072)]
    enemy = [[weights[stage * BASE + 3456 + index] for stage in range(2)]
             for index in range(3072)]
    pawn = [[weights[stage * BASE + 6528 + index] for stage in range(2)]
            for index in range(1536)]
    pairs = [[0, 0] for _ in range(676)]
    black = (4, 3, 2, 1, 0, 7, 6, 5)
    for source in range(1, 13):
        source_color, source_kind = divmod(source - 1, 6)
        source_sign = 1 if source_color == 0 else -1
        for target in range(1, 13):
            target_color, target_kind = divmod(target - 1, 6)
            target_sign = 1 if target_color == 0 else -1
            opposing = int(source_color != target_color)
            for axis, direction in enumerate((2, 0, 1, 7)):
                reverse = (direction + 4) % 8
                source_direction = direction if source_color == 0 else black[direction]
                target_direction = reverse if target_color == 0 else black[reverse]
                a = 8064 + (((source_kind * 6 + target_kind) * 2 + opposing) * 8 + source_direction)
                b = 8064 + (((target_kind * 6 + source_kind) * 2 + opposing) * 8 + target_direction)
                index = (source * 13 + target) * 4 + axis
                for stage in range(2):
                    pairs[index][stage] = narrow(
                        source_sign * weights[a + stage * BASE] +
                        target_sign * weights[b + stage * BASE], "paired-ray sum")
    return {"fused": fused, "enemy": enemy, "pawn": pawn, "pairs": pairs}


def render_model(raw: bytes) -> bytes:
    exported = tables(raw)
    rows = ["// Generated losslessly by tools/eval_pipeline/prepare.py.",
            f"// Dense model SHA-256: {sha(raw)}",
            "// All derived values are range checked before source publication.",
            "pub(super) static MODEL: crate::pipeline_core::Model =",
            "    crate::pipeline_core::Model::from_tables("]
    for name, values in exported.items():
        rows.append(f"    [ // {name}")
        for start in range(0, len(values), 8):
            rows.append("        " + ", ".join(f"[{a}, {b}]" for a, b in values[start:start + 8]) + ",")
        rows.append("    ],")
    rows.extend(["    );", ""])
    return "\n".join(rows).encode()


def constants_of(eval_bytes: bytes) -> str:
    source = eval_bytes.decode()
    constants = source[source.index("const PHASE_MAX"):source.index("#[derive(Clone, Copy)]")]
    return re.sub(r"^const ", "pub const ", constants, flags=re.MULTILINE).rstrip() + "\n"


def validate_constants(eval_bytes: bytes, generated: bytes):
    source = generated.decode()
    if source[source.index("pub const PHASE_MAX"):] != constants_of(eval_bytes):
        raise ValueError("HCE constants do not match the exact production evaluation source")


def replace_once(raw: bytes, old: bytes, new: bytes, name: str) -> bytes:
    if raw.count(old) != 1:
        raise ValueError(f"expected one authenticated {name} anchor")
    return raw.replace(old, new, 1)


def variant_sources(base: dict[str, bytes], implementation: dict[str, bytes],
                    model: bytes, variant: str, *, memory_bytes=MEMORY_BYTES,
                    family_cfg=None) -> dict[str, bytes]:
    if variant not in VARIANTS:
        raise ValueError("unknown build variant")
    if family_cfg not in (None, "eval_pipeline_no_pawn", "eval_pipeline_no_ray"):
        raise ValueError("unregistered family specialization")
    result = dict(base)
    if variant == "baseline":
        return result
    if memory_bytes not in (MEMORY_BYTES, MEMORY_BYTES + 65536):
        raise ValueError("only the baseline capacity or one explicit extra memory page is supported")
    if memory_bytes != MEMORY_BYTES:
        result["build.sh"] = replace_once(
            result["build.sh"], f"MEMORY_BYTES={MEMORY_BYTES}\n".encode(),
            f"MEMORY_BYTES={memory_bytes}\n".encode(), "explicit fixed memory")
    if variant == "baseline-memory":
        return result
    result["src/lib.rs"] = replace_once(
        base["src/lib.rs"], b"mod engine;\nmod eval;\nmod search;\n",
        b'mod engine;\nmod eval;\nmod search;\n'
        b'#[path = "eval_pipeline/core.rs"]\nmod pipeline_core;\n'
        b'#[path = "eval_pipeline/simd.rs"]\nmod simd;\n', "production module")
    for name in ("core.rs", "simd.rs", "hce_constants.rs"):
        result["src/eval_pipeline/" + name] = implementation[name]
    if variant.startswith("sparse-"):
        result["src/eval_pipeline/model.rs"] = model
        result["src/eval.rs"] = (
            '// Generated ABI-v2 sparse evaluator; immutable embedded tables.\n'
            '#[path = "eval_pipeline/model.rs"]\nmod weights;\n'
            '#[inline]\npub fn evaluate(position: &crate::engine::Position) -> i32 {\n'
            '    weights::MODEL.evaluate(position)\n}\n').encode()
    else:
        result["src/eval.rs"] = (
            '// Generated ABI-v2 exact fused HCE evaluator.\n'
            '#[inline]\npub fn evaluate(position: &crate::engine::Position) -> i32 {\n'
            '    crate::pipeline_core::evaluate_hce(position)\n}\n').encode()
    # Preserve every production linker/memory/optimization option. The SIMD
    # feature and implementation cfg are the only ISA changes. Path remapping
    # makes panic/source provenance independent of the retained output path.
    extra = ' --remap-path-prefix=$SCRIPT_DIR=chessy-eval-candidate'
    if variant.endswith("-simd"):
        extra += ' -C target-feature=+simd128 --cfg eval_pipeline_simd'
    else:
        extra += ' -C target-feature=-simd128'
    if variant.startswith("sparse-") and family_cfg is not None:
        extra += ' --cfg ' + family_cfg
    result["build.sh"] = replace_once(
        result["build.sh"], b'--max-memory=$MEMORY_BYTES"',
        ('--max-memory=$MEMORY_BYTES' + extra + '"').encode(), "pinned link flags")
    if variant.endswith("-simd"):
        result["build.sh"] = replace_once(
            result["build.sh"], b'    --enable-bulk-memory \\\n',
            b'    --enable-bulk-memory \\\n    --enable-simd \\\n    --disable-relaxed-simd \\\n', "Binaryen feature")
    return result


def prepare(root: Path, base_commit: str, output: Path, *, extra_memory_page=False,
            refit_manifest=None, recipe=None) -> dict:
    if (refit_manifest is None) != (recipe is None):
        raise ValueError("--refit-manifest and --recipe must be provided together")
    root = root.resolve()
    output = output.absolute()
    output = output.parent.resolve() / output.name
    if not re.fullmatch(r"[0-9a-f]{40}", base_commit):
        raise ValueError("base-commit must be an exact full commit SHA")
    if git(root, "cat-file", "-t", base_commit).strip() != b"commit":
        raise ValueError("base is not a Git commit")
    if output == root or root in output.parents:
        raise ValueError("candidate output must be outside the repository")
    if any(c.isspace() for c in str(output)):
        raise ValueError("candidate output path cannot contain whitespace")
    if output.exists() or output.is_symlink():
        raise FileExistsError("output already exists; no replacement or resume is implicit")
    tracked = git(root, "ls-tree", "-r", "--name-only", base_commit,
                  "--", "experiments/wasm/src/").decode().splitlines()
    expected = ["experiments/wasm/" + name for name in PRODUCTION if name.startswith("src/")]
    if sorted(tracked) != sorted(expected):
        raise ValueError("production Rust source inventory changed; review the capture list")
    base = {name: git(root, "show", base_commit + ":experiments/wasm/" + name)
            for name in PRODUCTION}
    if f"MEMORY_BYTES={MEMORY_BYTES}\n".encode() not in base["build.sh"]:
        raise ValueError("production fixed memory changed; explicit review is required")
    implementation = {name: (root / "tools/eval_pipeline" / name).read_bytes()
                      for name in IMPLEMENTATION}
    if root == ROOT and "_EXECUTED_BYTES" in globals():
        if implementation["prepare.py"] != globals()["_EXECUTED_BYTES"]:
            raise ValueError("executed preparation source changed before capture")
        implementation["prepare.py"] = globals()["_EXECUTED_BYTES"]
    validate_constants(base["src/eval.rs"], implementation["hce_constants.rs"])
    model = (root / DEFAULT_MODEL).read_bytes()
    selection_bytes = (root / DEFAULT_SELECTION).read_bytes()
    selection = json.loads(selection_bytes)
    selected = [row for row in selection["candidates"] if row["id"] == selection.get("selected")]
    if len(selected) != 1 or selected[0]["id"] != "full" or not selected[0].get("eligible"):
        raise ValueError("expected the previously selected full model")
    declared = selected[0]["weights"]
    if declared.get("path") != "full.i16le" or identity(model) != {
            "bytes": declared.get("bytes"), "sha256": declared.get("sha256")}:
        raise ValueError("model does not match the retained prior selection")
    imported = None
    model_id, coefficient_bytes, model_path, family_cfg = "sparse-pesto-v1/full", MODEL_BYTES, "model/full.i16le", None
    if refit_manifest is not None:
        # This is our own verifier, compiled from the same captured bytes that
        # enter PREPARED. Imported refit source is authenticated but never run.
        verifier = {"__name__": "eval_pipeline_refit_import", "__file__": "retained/refit_import.py"}
        exec(compile(implementation["refit_import.py"], verifier["__file__"], "exec"), verifier)
        imported = verifier["capture"](Path(refit_manifest), recipe, validate_tables=tables)
        model, selection_bytes = imported["model"], imported["selection"]
        model_id, model_path = "eval-pipeline/" + recipe, "model/candidate.i16le"
        coefficient_bytes = imported["specialization"]["coefficientBytes"]
        family_cfg = imported["specialization"]["cfg"]
    generated_model = render_model(model)
    candidate_memory = MEMORY_BYTES + (65536 if extra_memory_page else 0)
    shipped = git(root, "show", base_commit + ":assets/chessy-ai-fast.wasm")
    licenses = {name: git(root, "show", base_commit + ":" + name)
                for name in ("LICENSE", "THIRD_PARTY_NOTICES.md")}
    captured = {"base/" + name: raw for name, raw in base.items()}
    captured.update({"implementation/" + name: raw for name, raw in implementation.items()})
    captured.update({model_path: model, "model/selection.json": selection_bytes,
                     "model/model.rs": generated_model, "control/shipped.wasm": shipped})
    if imported is not None:
        captured.update({"refit/" + name: raw for name, raw in imported["retained"].items()})
    for name in ("engine.js", "wasm-engine.js"):
        captured["runtime/" + name] = git(root, "show", base_commit + ":assets/" + name)
    captured.update(licenses)
    for variant in VARIANTS:
        captured.update({"variants/" + variant + "/" + name: raw for name, raw in
                         variant_sources(base, implementation, generated_model, variant,
                                         memory_bytes=candidate_memory, family_cfg=family_cfg).items()})
    # mkdir is the exclusive publication reservation; never clean someone
    # else's output on failure. The complete manifest is written last.
    output.mkdir(parents=True, exist_ok=False)
    for path, raw in captured.items():
        write_once(output / path, raw, executable=path.endswith("build.sh"))
    receipt = {
        "schema": SCHEMA, "researchOnly": True, "productionChanged": False,
        "baseCommit": base_commit, "abiVersion": 2,
        "fixedMemoryBytes": candidate_memory, "stackBytes": 1048576,
        "baselineMemoryBytes": MEMORY_BYTES, "baselineMemoryPages": MEMORY_BYTES // 65536,
        "candidateMemoryBytes": candidate_memory, "candidateMemoryPages": candidate_memory // 65536,
        "explicitExtraMemoryPage": bool(extra_memory_page),
        "model": {**identity(model), "id": model_id, "coefficientBytes": coefficient_bytes},
        "controlModule": identity(shipped), "variants": list(VARIANTS),
        "runtimeModelLoading": False, "runtimeVariantDispatch": False,
        "evaluationCacheBytes": 0, "batchBuffers": False,
        "playingStrengthAdmission": "not established; equal-time evidence required",
        "files": {path: identity(raw) for path, raw in sorted(captured.items())},
    }
    if imported is not None:
        receipt["refit"] = {"manifest": imported["receipt"]["manifest"], "recipe": recipe,
                            "importReceipt": identity(captured["refit/IMPORT.json"]),
                            "familyCfg": family_cfg, "qualityEligible": True,
                            "runtimeExportEligible": True, "playingStrengthAdmission": False}
    write_once(output / "PREPARED.json", canonical(receipt))
    verify_prepared(output)
    return receipt


def verify_prepared(output: Path) -> dict:
    output = output.resolve()
    receipt = json.loads((output / "PREPARED.json").read_bytes())
    if receipt.get("schema") != SCHEMA or receipt.get("variants") != list(VARIANTS):
        raise ValueError("invalid preparation schema or variant inventory")
    for name, declared in receipt["files"].items():
        if (not isinstance(name, str) or Path(name).is_absolute()
                or any(part in ("", ".", "..") for part in name.split("/"))):
            raise ValueError("unsafe retained input path")
        path = output / name
        if path.is_symlink() or not path.is_file() or identity(path.read_bytes()) != declared:
            raise ValueError("retained input changed: " + name)
    for variant in VARIANTS:
        crate = output / "variants" / variant
        expected = {path[len("variants/" + variant + "/"):]
                    for path in receipt["files"] if path.startswith("variants/" + variant + "/")}
        actual = {str(path.relative_to(crate)) for path in crate.rglob("*")
                  if path.is_file() and "dist" not in path.relative_to(crate).parts}
        if actual != expected:
            raise ValueError("retained crate source inventory changed: " + variant)
        # Cargo discovers ancestor configuration. Never compile through an
        # unrecorded parent .cargo/config[.toml]. CARGO_HOME is isolated below.
        for parent in (crate, *crate.parents):
            for name in ("config", "config.toml"):
                if (parent / ".cargo" / name).exists():
                    raise ValueError("ambient Cargo configuration: " + str(parent / ".cargo" / name))
    return receipt


def tool_fd(stack: ExitStack, path: Path, name: str) -> tuple[int, dict]:
    handle = stack.enter_context(path.resolve().open("rb"))
    raw = handle.read()
    descriptor = handle.fileno()
    return descriptor, {"name": name, "path": str(path.resolve()), **identity(raw)}


def clean_environment(output: Path) -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("CARGO_", "RUST", "CHESSY_"))}
    environment["CARGO_HOME"] = str(output / "cargo-home")
    environment["CARGO_NET_OFFLINE"] = "true"
    return environment


def build_prepared(output: Path, *, rustc: Path, cargo: Path, wasm_opt: Path) -> dict:
    output = output.resolve()
    receipt = verify_prepared(output)
    if (output / "BUILT.json").exists():
        raise FileExistsError("build already completed; do not replace recorded observations")
    # Exclusive lock remains as a failed-attempt record if compilation fails.
    with (output / ".build-lock").open("xb") as lock:
        lock.write(canonical({"pid": os.getpid(), "preparedSha256": sha((output / "PREPARED.json").read_bytes())}))
    environment = clean_environment(output)
    (output / "cargo-home").mkdir(exist_ok=False)
    with ExitStack() as stack:
        handles = {name: tool_fd(stack, path, name) for name, path in
                   (("rustc", rustc), ("cargo", cargo), ("wasm-opt", wasm_opt))}
        fds = tuple(value[0] for value in handles.values())
        executable = {name: f"/proc/self/fd/{fd}" for name, (fd, _) in handles.items()}
        versions = {}
        for name in handles:
            command = [executable[name], "--version"] + (["--verbose"] if name == "rustc" else [])
            versions[name] = subprocess.check_output(command, pass_fds=fds, text=True,
                                                      env=environment).strip()
        if f"release: {RUST_RELEASE}" not in versions["rustc"] or f"commit-hash: {RUST_COMMIT}" not in versions["rustc"]:
            raise ValueError("pinned Rust compiler required")
        if not versions["cargo"].startswith("cargo " + RUST_RELEASE + " "):
            raise ValueError("pinned Cargo required")
        if not re.search(r"\bversion 131\b", versions["wasm-opt"]):
            raise ValueError("pinned Binaryen 131 required")
        environment.update({
            "CHESSY_RUSTC_BIN": executable["rustc"],
            "CHESSY_CARGO_BIN": executable["cargo"],
            "CHESSY_WASM_OPT_BIN": executable["wasm-opt"],
        })
        artifacts = {}
        for variant in VARIANTS:
            verify_prepared(output)
            crate = output / "variants" / variant
            build_env = {**environment, "CHESSY_CARGO_TARGET_DIR": str(output / "targets" / variant)}
            process = subprocess.run(["/bin/sh", str(crate / "build.sh")], cwd=crate,
                                     env=build_env, pass_fds=fds, capture_output=True)
            write_once(output / "logs" / (variant + ".log"), process.stdout + process.stderr)
            if process.returncode:
                raise RuntimeError(f"{variant} build failed; retained logs/{variant}.log")
            artifact = crate / "dist/chessy-ai-fast.wasm"
            raw = artifact.read_bytes()
            if variant == "baseline" and identity(raw) != receipt["controlModule"]:
                raise ValueError("unchanged production control failed byte-for-byte WASM reproduction")
            module_name = "modules/" + variant + ".wasm"
            write_once(output / module_name, raw)
            capacity = MEMORY_BYTES if variant == "baseline" else receipt["candidateMemoryBytes"]
            artifacts[variant] = {"path": module_name, **identity(raw),
                                  "memoryBytes": capacity, "memoryPages": capacity // 65536}
        # The actual opened executable inodes, not pathnames, were executed.
        for name, (fd, declared) in handles.items():
            observed = os.pread(fd, declared["bytes"] + 1, 0)
            if identity(observed) != {"bytes": declared["bytes"], "sha256": declared["sha256"]}:
                raise ValueError("executed tool inode changed: " + name)
        verify_prepared(output)
        result = {
            "schema": "chessy.eval-pipeline-build.v1", "researchOnly": True,
            "preparedSha256": sha((output / "PREPARED.json").read_bytes()),
            "baseCommit": receipt["baseCommit"], "abiVersion": 2,
            "baselineMemoryBytes": MEMORY_BYTES,
            "candidateMemoryBytes": receipt["candidateMemoryBytes"],
            "explicitExtraMemoryPage": receipt["explicitExtraMemoryPage"],
            "controlReproducedExactly": True,
            "tools": {name: {**value[1], "version": versions[name]} for name, value in handles.items()},
            "modules": artifacts,
            "recipe": "retained production build.sh; explicit SIMD/cfg and path-remap changes recorded per variant",
            "playingStrengthAdmission": "not established; equal-time evidence required",
        }
        write_once(output / "BUILT.json", canonical(result))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--base-commit")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--build-existing", action="store_true")
    parser.add_argument("--extra-memory-page", action="store_true",
                        help="explicitly give research candidates and matched HCE one extra 64KiB page")
    parser.add_argument("--refit-manifest", type=Path,
                        help="optional complete retained refit RESULTS.json; requires --recipe")
    parser.add_argument("--recipe", choices=("refit-no-pawn", "refit-no-ray"))
    parser.add_argument("--rustc", type=Path)
    parser.add_argument("--cargo", type=Path)
    parser.add_argument("--wasm-opt", type=Path)
    args = parser.parse_args()
    if args.build_existing:
        if args.base_commit or args.build or args.extra_memory_page or args.refit_manifest or args.recipe:
            parser.error("--build-existing cannot change preparation options")
    elif not args.base_commit:
        parser.error("--base-commit is required for source preparation")
    if (args.refit_manifest is None) != (args.recipe is None):
        parser.error("--refit-manifest and --recipe must be provided together")
    if args.build or args.build_existing:
        if not all((args.rustc, args.cargo, args.wasm_opt)):
            parser.error("building requires explicit --rustc, --cargo, and --wasm-opt")
    result = (verify_prepared(args.output) if args.build_existing else
              prepare(args.root, args.base_commit, args.output, extra_memory_page=args.extra_memory_page,
                      refit_manifest=args.refit_manifest, recipe=args.recipe))
    if args.build or args.build_existing:
        result = build_prepared(args.output, rustc=args.rustc, cargo=args.cargo, wasm_opt=args.wasm_opt)
    print(json.dumps({"output": str(args.output.resolve()), "schema": result["schema"],
                      "baseCommit": result["baseCommit"], "modules": result.get("modules")}))


if __name__ == "__main__":
    main()
