#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CARGO_BIN=${CHESSY_CARGO_BIN:-cargo}
RUSTC_BIN=${CHESSY_RUSTC_BIN:-rustc}
WASM_OPT_BIN=${CHESSY_WASM_OPT_BIN:-wasm-opt}
TARGET_DIR=${CHESSY_CARGO_TARGET_DIR:-/tmp/chessy-rust-target}
MEMORY_BYTES=26542080
RUST_RELEASE=1.97.1
RUST_COMMIT=8bab26f4f68e0e26f0bb7960be334d5b520ea452
BINARYEN_VERSION=131
PINNED_LINK_FLAGS="-C link-arg=--no-entry -C link-arg=--export-memory -C link-arg=--gc-sections -C link-arg=-z -C link-arg=stack-size=1048576 -C link-arg=--initial-memory=$MEMORY_BYTES -C link-arg=--max-memory=$MEMORY_BYTES"

if [ -n "${RUSTFLAGS:-}" ] || [ -n "${CARGO_ENCODED_RUSTFLAGS:-}" ]; then
  echo "error: clear ambient RUSTFLAGS/CARGO_ENCODED_RUSTFLAGS for a pinned build" >&2
  exit 2
fi
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS

mkdir -p "$SCRIPT_DIR/dist" "$TARGET_DIR"
TARGET_DIR=$(CDPATH= cd -- "$TARGET_DIR" && pwd)

rustc_version=$(
  cd "$SCRIPT_DIR"
  "$RUSTC_BIN" --version --verbose
)
case "$rustc_version" in
  *"release: $RUST_RELEASE"*) ;;
  *)
    echo "error: expected rustc release $RUST_RELEASE" >&2
    echo "$rustc_version" >&2
    exit 2
    ;;
esac
case "$rustc_version" in
  *"commit-hash: $RUST_COMMIT"*) ;;
  *)
    echo "error: expected rustc commit $RUST_COMMIT" >&2
    echo "$rustc_version" >&2
    exit 2
    ;;
esac

cargo_version=$(
  cd "$SCRIPT_DIR"
  "$CARGO_BIN" --version
)
case "$cargo_version" in
  "cargo $RUST_RELEASE "*) ;;
  *)
    echo "error: expected Cargo $RUST_RELEASE, got: $cargo_version" >&2
    exit 2
    ;;
esac

wasm_opt_version=$("$WASM_OPT_BIN" --version)
case "$wasm_opt_version" in
  *"version $BINARYEN_VERSION "*) ;;
  *)
    echo "error: expected Binaryen $BINARYEN_VERSION, got: $wasm_opt_version" >&2
    exit 2
    ;;
esac

build_one() {
  mode=$1
  profile=$2
  wasm_opt_level=$3
  raw="$SCRIPT_DIR/dist/chessy-ai-$mode.raw.wasm"
  final="$SCRIPT_DIR/dist/chessy-ai-$mode.wasm"

  if [ "$profile" = release ]; then
    cargo_profile=--release
  else
    cargo_profile="--profile $profile"
  fi

  (
    cd "$SCRIPT_DIR"
    CARGO_INCREMENTAL=0 \
    CARGO_TARGET_DIR="$TARGET_DIR" \
    SOURCE_DATE_EPOCH=0 \
    RUSTFLAGS="$PINNED_LINK_FLAGS" \
      "$CARGO_BIN" build --locked --offline \
        --target wasm32-unknown-unknown $cargo_profile
  )

  cp "$TARGET_DIR/wasm32-unknown-unknown/$profile/chessy_ai_wasm.wasm" "$raw"

  "$WASM_OPT_BIN" "$raw" \
    --enable-mutable-globals \
    --enable-sign-ext \
    --enable-reference-types \
    --enable-multivalue \
    --enable-nontrapping-float-to-int \
    --enable-bulk-memory \
    "$wasm_opt_level" \
    --converge \
    --strip-debug \
    --strip-producers \
    --strip-toolchain-annotations \
    -o "$final"
}

build_one fast release -O3
build_one small small -Oz

wc -c "$SCRIPT_DIR"/dist/chessy-ai-*.wasm
