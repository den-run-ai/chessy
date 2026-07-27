#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ZIG_BIN=${CHESSY_ZIG_BIN:-zig}
WASM_OPT_BIN=${CHESSY_WASM_OPT_BIN:-wasm-opt}
CACHE_ROOT=${CHESSY_ZIG_CACHE_ROOT:-/tmp/chessy-zig-cache}

mkdir -p "$SCRIPT_DIR/dist" "$CACHE_ROOT/local" "$CACHE_ROOT/global"

build_one() {
  mode=$1
  opt=$2
  raw="$SCRIPT_DIR/dist/chessy-ai-$mode.raw.wasm"
  final="$SCRIPT_DIR/dist/chessy-ai-$mode.wasm"

  "$ZIG_BIN" build-exe "$SCRIPT_DIR/core.zig" \
    -target wasm32-freestanding \
    -O "$opt" \
    -fno-entry \
    -rdynamic \
    -fstrip \
    -femit-bin="$raw" \
    --cache-dir "$CACHE_ROOT/local" \
    --global-cache-dir "$CACHE_ROOT/global"

  if [ "$mode" = fast ]; then
    "$WASM_OPT_BIN" "$raw" --enable-bulk-memory -O3 --converge -o "$final"
  else
    "$WASM_OPT_BIN" "$raw" --enable-bulk-memory -Oz --converge -o "$final"
  fi
}

build_one fast ReleaseFast
build_one small ReleaseSmall

wc -c "$SCRIPT_DIR"/dist/chessy-ai-*.wasm
