#!/bin/sh
# Research-only candidate build: the pinned production flags from
# experiments/wasm/build.sh plus the `nnue` Cargo feature, an embedded weight
# file, and an explicit memory ceiling (weights + accumulator stack do not fit
# in the production 405-page module; production limits are unchanged).
# Builds from the patched research copy prepared by tools/nnue/prepare-crate.sh
# (prepared automatically when absent); experiments/wasm is never modified.
#
# Usage:
#   CHESSY_WASM_OPT_BIN=/path/wasm-opt \
#   tools/nnue/build-candidate.sh <weights.bin> <hidden> <memory-pages> <out.wasm> [features]
set -eu

WEIGHTS=$1
HIDDEN=$2
PAGES=$3
OUT=$4
# Optional fifth argument: extra Cargo feature list (e.g. "nnue-mopup").
FEATURES=${5:-nnue}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CRATE_DIR=${CHESSY_NNUE_CRATE:-/tmp/chessy-nnue-crate}
if [ ! -f "$CRATE_DIR/src/nnue.rs" ]; then
  "$SCRIPT_DIR/prepare-crate.sh" "$CRATE_DIR" > /dev/null
fi
WASM_OPT_BIN=${CHESSY_WASM_OPT_BIN:-wasm-opt}
TARGET_DIR=${CHESSY_NNUE_TARGET_DIR:-/tmp/chessy-nnue-target-$HIDDEN}
MEMORY_BYTES=$((PAGES * 65536))
PINNED_LINK_FLAGS="-C link-arg=--no-entry -C link-arg=--export-memory -C link-arg=--gc-sections -C link-arg=-z -C link-arg=stack-size=1048576 -C link-arg=--initial-memory=$MEMORY_BYTES -C link-arg=--max-memory=$MEMORY_BYTES"

if [ -n "${RUSTFLAGS:-}" ] || [ -n "${CARGO_ENCODED_RUSTFLAGS:-}" ]; then
  echo "error: clear ambient RUSTFLAGS/CARGO_ENCODED_RUSTFLAGS" >&2
  exit 2
fi
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS

WEIGHTS=$(CDPATH= cd -- "$(dirname -- "$WEIGHTS")" && pwd)/$(basename -- "$WEIGHTS")
mkdir -p "$TARGET_DIR" "$(dirname -- "$OUT")"

(
  cd "$CRATE_DIR"
  CARGO_INCREMENTAL=0 \
  CARGO_TARGET_DIR="$TARGET_DIR" \
  SOURCE_DATE_EPOCH=0 \
  CHESSY_NNUE_BIN="$WEIGHTS" \
  CHESSY_NNUE_HIDDEN="$HIDDEN" \
  RUSTFLAGS="$PINNED_LINK_FLAGS" \
    cargo build --locked --offline --features "$FEATURES" \
      --target wasm32-unknown-unknown --release
)

"$WASM_OPT_BIN" "$TARGET_DIR/wasm32-unknown-unknown/release/chessy_ai_wasm.wasm" \
  --enable-mutable-globals \
  --enable-sign-ext \
  --enable-reference-types \
  --enable-multivalue \
  --enable-nontrapping-float-to-int \
  --enable-bulk-memory \
  -O3 \
  --converge \
  --strip-debug \
  --strip-producers \
  --strip-toolchain-annotations \
  -o "$OUT"

wc -c "$OUT"
