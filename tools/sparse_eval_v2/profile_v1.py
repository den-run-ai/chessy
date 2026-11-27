#!/usr/bin/env python3
"""Instrument the frozen v1 evaluator; diagnostic overhead is not a benchmark.

The input is the existing label-free list of timing roots. Retained source,
compiler, binary, weights, roots and raw observations are hashed in the receipt.
This tool never edits v1 and never trains or reads teacher labels.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

PROFILE = r'''
#[derive(Default)]
struct Diagnostic {
    calls: u64, baseline_ns: u128, residual_ns: u128,
    pieces: u64, pawns: u64, unique_board_hits: u64, direct_hits: u64,
    seen: std::collections::HashSet<[u8;64]>,
    direct: std::collections::HashMap<usize, [u8;64]>,
}
static DIAGNOSTIC: OnceLock<std::sync::Mutex<Diagnostic>> = OnceLock::new();
fn profile_reset() {
    let mut p = DIAGNOSTIC.get_or_init(Default::default).lock().unwrap();
    p.seen.clear(); p.direct.clear();
}
fn profile_record(position: &Position, base_ns: u128, residual_ns: u128) {
    let mut p = DIAGNOSTIC.get_or_init(Default::default).lock().unwrap();
    p.calls += 1; p.baseline_ns += base_ns; p.residual_ns += residual_ns;
    let board = position.board.map(|piece| piece as u8);
    p.pieces += board.iter().filter(|&&piece|piece != 0).count() as u64;
    p.pawns += board.iter().filter(|&&piece|piece == 1 || piece == 7).count() as u64;
    if !p.seen.insert(board) {p.unique_board_hits += 1;}
    let mut hash = 0x9e3779b97f4a7c15u64;
    for chunk in board.chunks_exact(8) {
        let word = u64::from_le_bytes(chunk.try_into().unwrap());
        hash = (hash ^ word).rotate_left(13).wrapping_mul(0xbf58476d1ce4e5b9);
    }
    let slot = hash as usize & 1023;
    if p.direct.insert(slot, board) == Some(board) {p.direct_hits += 1;}
}
fn profile_print() {
    let p = DIAGNOSTIC.get_or_init(Default::default).lock().unwrap();
    eprintln!("{{\"calls\":{},\"baseline_ns\":{},\"residual_ns\":{},\"piece_visits\":{},\"pawn_visits\":{},\"same_board_hits_unbounded\":{},\"same_board_hits_direct1024\":{}}}",
        p.calls,p.baseline_ns,p.residual_ns,p.pieces,p.pawns,p.unique_board_hits,p.direct_hits);
}
'''


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rustc", required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--roots", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    source_raw = (ROOT / "tools/sparse_eval/runtime.rs").read_bytes()
    source = source_raw.decode()
    for name in ("engine", "eval", "search"):
        source = source.replace(f'"baseline/{name}.rs"', json.dumps(str(ROOT / f"tools/sparse_eval/baseline/{name}.rs")))
    start = source.index("mod eval {")
    end = source.index("\nstruct Model {", start)
    source = source[:start] + PROFILE + r'''
mod eval {
    pub fn evaluate(position: &crate::engine::Position) -> i32 {
        if !crate::CANDIDATE.load(std::sync::atomic::Ordering::Relaxed) {
            return crate::baseline::evaluate(position);
        }
        let start = crate::Instant::now();
        let base = crate::baseline::evaluate(position);
        let base_ns = start.elapsed().as_nanos();
        let start = crate::Instant::now();
        let residual = crate::MODEL.get().unwrap().correction(position);
        let residual_ns = start.elapsed().as_nanos();
        crate::profile_record(position, base_ns, residual_ns);
        base + residual
    }
}
''' + source[end:]
    source = source.replace("unsafe { search::clear_game_history(); }", "unsafe { search::clear_game_history(); } profile_reset();")
    source = source.replace("    output.flush()?;", "    profile_print(); output.flush()?;")
    source_path = args.output / "instrumented.rs"
    source_path.write_text(source)
    binary = args.output / "instrumented"
    command = [args.rustc, "--edition=2021", "-O", "--cfg", "sparse_fast", str(source_path), "-o", str(binary)]
    subprocess.run(command, check=True, capture_output=True)
    roots_raw = args.roots.read_bytes()
    roots = json.loads(roots_raw)
    fen_text = "\n".join(row["fen"] for row in roots) + "\n"
    weights_raw = args.weights.read_bytes()
    weights = args.output / "weights.i16le"
    weights.write_bytes(weights_raw)
    raw = subprocess.run([str(binary), "search", str(weights), "10000", "30"],
                         input=fen_text, text=True, check=True, capture_output=True)
    (args.output / "search.jsonl").write_text(raw.stdout)
    (args.output / "instrumentation.json").write_text(raw.stderr)
    receipt = {"schema": "chessy.sparse-v2-instrumentation.v1", "purpose": "profile-only-not-runtime-benchmark",
               "sourceSha256": sha(source_raw), "instrumentedSourceSha256": sha(source.encode()),
               "binarySha256": sha(binary.read_bytes()), "compiler": subprocess.check_output([args.rustc, "--version", "--verbose"], text=True),
               "build": command, "weightsSha256": sha(weights_raw), "rootsSha256": sha(roots_raw),
               "positions": len(roots), "nodesPerSearch": 10000, "maximumDepth": 30,
               "clearCacheEveryRoot": True, "cacheVerifiedBoardBytes": 64,
               "note": "Per-call clocks, locks and board copying distort whole-search timings; component timings include clock overhead.",
               "counts": json.loads(raw.stderr), "searchSha256": sha(raw.stdout.encode())}
    (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt["counts"], indent=2))


if __name__ == "__main__":
    main()
