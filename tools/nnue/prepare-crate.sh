#!/bin/sh
# Prepare a research copy of the production engine crate with the NNUE
# evaluator applied. The production crate under experiments/wasm is never
# modified: this copies it, applies tools/nnue/engine-nnue.patch (Cargo
# features, evaluator shims in search.rs/lib.rs, `pub` mop_up) and adds
# tools/nnue/nnue.rs. With the `nnue` feature off, the copied crate still
# reproduces assets/chessy-ai-fast.wasm byte for byte.
#
#   tools/nnue/prepare-crate.sh [dest]      (default /tmp/chessy-nnue-crate)
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
DEST=${1:-${CHESSY_NNUE_CRATE:-/tmp/chessy-nnue-crate}}

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$ROOT/experiments/wasm/src" "$DEST/src"
cp "$ROOT/experiments/wasm/Cargo.toml" "$ROOT/experiments/wasm/Cargo.lock" \
   "$ROOT/experiments/wasm/rust-toolchain.toml" "$ROOT/experiments/wasm/build.sh" "$DEST/"
# The patch paths are repository-relative (experiments/wasm/...); strip them.
(cd "$DEST" && patch -p3 --silent < "$SCRIPT_DIR/engine-nnue.patch")
cp "$SCRIPT_DIR/nnue.rs" "$DEST/src/nnue.rs"
echo "prepared $DEST"
