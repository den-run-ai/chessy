#!/usr/bin/env bash
# Build the Zig WASM play-search module with pinned toolchain provenance.
#
# Requires: zig 0.16.0 on PATH (or ZIG=/path/to/zig), optionally wasm-opt
# (Binaryen 131) for the post-optimized "fast" artifact. Produces:
#   chessy.wasm       — speed candidate (ReleaseFast [+ wasm-opt -O3 --converge])
#   chessy-size.wasm  — size candidate (ReleaseSmall [+ wasm-opt -Oz --converge])
#   chessy.wasm.provenance.txt — toolchain versions, flags, source/binary hashes
set -euo pipefail
cd "$(dirname "$0")"

ZIG="${ZIG:-zig}"
WASM_OPT="${WASM_OPT:-wasm-opt}"

EXPORTS=(--export=search --export=reset --export=inPtr --export=outPtr
  --export=perft --export=evalFen)
# Zig 0.16 wasm32 baseline emits bulk-memory / sign-ext / nontrapping-fptoint;
# wasm-opt must be told (all supported by every 2023+ mobile browser engine).
WASM_OPT_FEATURES=(--enable-bulk-memory --enable-sign-ext
  --enable-nontrapping-float-to-int --enable-mutable-globals)

"$ZIG" build-exe src/main.zig -target wasm32-freestanding -O ReleaseFast \
  -fstrip -fno-entry "${EXPORTS[@]}" -femit-bin=chessy.wasm
"$ZIG" build-exe src/main.zig -target wasm32-freestanding -O ReleaseSmall \
  -fstrip -fno-entry "${EXPORTS[@]}" -femit-bin=chessy-size.wasm

WASM_OPT_VERSION="(not run)"
if command -v "$WASM_OPT" >/dev/null 2>&1; then
  "$WASM_OPT" "${WASM_OPT_FEATURES[@]}" -O3 --converge chessy.wasm -o chessy.wasm.tmp
  mv chessy.wasm.tmp chessy.wasm
  "$WASM_OPT" "${WASM_OPT_FEATURES[@]}" -Oz --converge chessy-size.wasm -o chessy-size.wasm.tmp
  mv chessy-size.wasm.tmp chessy-size.wasm
  WASM_OPT_VERSION="$("$WASM_OPT" --version)"
else
  echo "note: wasm-opt not found — emitting unoptimized zig output" >&2
fi

{
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "zig: $("$ZIG" version)"
  echo "wasm-opt: $WASM_OPT_VERSION"
  echo "flags: -target wasm32-freestanding -fno-entry (fast: -O ReleaseFast + wasm-opt -O3 --converge; size: -O ReleaseSmall + wasm-opt -Oz --converge)"
  echo "source sha256: $(sha256sum src/main.zig | cut -d' ' -f1)"
  echo "chessy.wasm sha256: $(sha256sum chessy.wasm | cut -d' ' -f1)"
  echo "chessy-size.wasm sha256: $(sha256sum chessy-size.wasm | cut -d' ' -f1)"
  echo "chessy.wasm bytes: $(wc -c < chessy.wasm)"
  echo "chessy-size.wasm bytes: $(wc -c < chessy-size.wasm)"
} > chessy.wasm.provenance.txt
cat chessy.wasm.provenance.txt
