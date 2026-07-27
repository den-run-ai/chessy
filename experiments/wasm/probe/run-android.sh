#!/usr/bin/env bash
# Run the WASM probe in REAL Chrome for Android on a (CI) emulator.
#
# Executes on the host while an emulator is attached via adb (in CI, inside
# reactivecircus/android-emulator-runner's `script:`). The probe page is
# served from the host and reached from the emulator at 10.0.2.2; results
# come back as HTTP POSTs, so no WebDriver stack is needed.
#
# Env overrides: PORT (8123), OUT (probe/reports), TARGET (android-chrome),
#   DEPTH (5), PARITY_DEPTH (=DEPTH), REPS (2), MIN_MS (50), FIVE (4),
#   WAIT_S (1500).
set -uo pipefail
cd "$(dirname "$0")/../../.."

PORT="${PORT:-8123}"
OUT="${OUT:-experiments/wasm/probe/reports}"
TARGET="${TARGET:-android-chrome}"
DEPTH="${DEPTH:-5}"
PARITY_DEPTH="${PARITY_DEPTH:-$DEPTH}"
REPS="${REPS:-2}"
MIN_MS="${MIN_MS:-50}"
FIVE="${FIVE:-4}"
WAIT_S="${WAIT_S:-1500}"

mkdir -p "$OUT"
node experiments/wasm/probe/server.js --port "$PORT" --host 0.0.0.0 --out "$OUT" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
sleep 1

adb wait-for-device
adb shell settings put global window_animation_scale 0 || true
adb shell settings put global transition_animation_scale 0 || true
adb shell settings put global animator_duration_scale 0 || true

echo "--- chrome package check"
if ! adb shell pm list packages | tr -d '\r' | grep -q '^package:com.android.chrome$'; then
  echo "FAIL: com.android.chrome not present on this emulator image"
  adb shell pm list packages | tr -d '\r' | grep -i -e chrome -e webview || true
  exit 1
fi

# Skip Chrome's first-run experience. The command-line file is honored on
# userdebug (google_apis) emulator images.
adb shell "echo '_ --no-first-run --no-default-browser-check --disable-fre --disable-features=FirstRunUi,ChromeWhatsNewUI' > /data/local/tmp/chrome-command-line" || true
adb shell am set-debug-app --persistent com.android.chrome || true

URL="http://10.0.2.2:${PORT}/experiments/wasm/probe/?depth=${DEPTH}&parityDepth=${PARITY_DEPTH}&reps=${REPS}&minMs=${MIN_MS}&five=${FIVE}&target=${TARGET}"
echo "--- opening $URL"
# Inner quotes keep the device-side shell from splitting the URL on '&'.
adb shell "am start -a android.intent.action.VIEW -d '$URL' com.android.chrome"

if node experiments/wasm/probe/wait-report.js "$OUT/final-${TARGET}.json" "$WAIT_S"; then
  exit 0
fi

echo "--- probe failed; collecting diagnostics"
adb exec-out screencap -p > "$OUT/${TARGET}-screen.png" || true
adb logcat -d -t 400 > "$OUT/${TARGET}-logcat.txt" || true
exit 1
