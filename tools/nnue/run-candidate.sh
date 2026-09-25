#!/bin/sh
# Build one candidate module from a trained net (in the patched research copy
# of the engine crate, see prepare-crate.sh) and run the timing-insensitive
# evidence: Rust tests with the exporter goldens, WASM-level golden parity,
# lone-king conversion, and fixed-node development matches.
#
#   tools/nnue/run-candidate.sh <hidden> [features] [tag]
# Environment: CHESSY_WASM_OPT_BIN, CHESSY_NNUE_DATA (default /home/user/data)
set -eu
H=$1
FEATURES=${2:-nnue}
TAG=${3:-h$H}
DATA=${CHESSY_NNUE_DATA:-/home/user/data}
NETS=$DATA/nets
OUT=$DATA/matches
WORKERS=${CHESSY_NNUE_WORKERS:-3}
mkdir -p "$OUT"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

# The weight file defaults to the width's main net; CHESSY_NNUE_BIN_PATH
# selects a differently trained net of the same width (e.g. the D1 student).
BIN=${CHESSY_NNUE_BIN_PATH:-$NETS/h$H.bin}
GOLDENS=${BIN%.bin}.goldens.txt
WASM=$NETS/$TAG.wasm
# Weights (2*771*H + 16 bytes) plus the accumulator stack (130*2*H*2 bytes)
# do not fit the production 405-page module; add whole pages plus one spare.
PAGES=$((405 + (2062 * H + 65535) / 65536 + 1))

tools/nnue/build-candidate.sh "$BIN" "$H" "$PAGES" "$WASM" "$FEATURES" > "$OUT/$TAG-build.log" 2>&1
echo "pages=$PAGES bytes=$(wc -c < "$WASM") brotli=$(node -e "const z=require('zlib');process.stdout.write(String(z.brotliCompressSync(require('fs').readFileSync('$WASM'),{params:{[z.constants.BROTLI_PARAM_QUALITY]:11}}).length))")" > "$OUT/$TAG-size.txt"
CRATE_DIR=${CHESSY_NNUE_CRATE:-/tmp/chessy-nnue-crate}
(cd "$CRATE_DIR" && CHESSY_NNUE_BIN="$BIN" CHESSY_NNUE_HIDDEN="$H" CHESSY_NNUE_GOLDENS="$GOLDENS" \
  cargo test --locked --offline --features "$FEATURES") > "$OUT/$TAG-cargo-test.log" 2>&1
grep -E "test result" "$OUT/$TAG-cargo-test.log"
if [ "$FEATURES" = nnue ]; then
  node tools/nnue/check-goldens-wasm.js --wasm "$WASM" --goldens "$GOLDENS" > "$OUT/$TAG-wasm-goldens.json"
fi
node tools/nnue/mate-conversion.js --module "$WASM" --nodes 36000 > "$OUT/$TAG-mate.json" 2> /dev/null
for N in 10000 36000; do
  node tools/nnue/match.js --base assets/chessy-ai-fast.wasm --candidate "$WASM" \
    --openings eval/nnue-proto-2026-09/dev-openings.json --nodes "$N" --workers "$WORKERS" \
    --out "$OUT/$TAG-n$N.json" --label "$TAG-n$N" > "$OUT/$TAG-n$N.summary.json" 2> "$OUT/$TAG-n$N.log"
  node -e "const s=require('$OUT/$TAG-n$N.summary.json').summary;console.log(JSON.stringify({tag:'$TAG',nodes:$N,score:s.score,wdl:[s.wins,s.draws,s.losses],ci:s.openingClustered.ci95,elo:s.eloEstimate,npsRatio:s.npsRatio}))"
done
echo "CANDIDATE_DONE $TAG"
