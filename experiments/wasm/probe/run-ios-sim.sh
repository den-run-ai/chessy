#!/usr/bin/env bash
# Run the WASM probe in Mobile Safari on an iOS Simulator (macOS host/CI).
#
# The simulator shares the host network stack, so the probe page is served on
# 127.0.0.1 and results come back as HTTP POSTs — no WebDriver/Appium needed.
#
# Env overrides: PORT (8123), OUT (probe/reports), TARGET (ios-safari),
#   DEPTH (5), PARITY_DEPTH (=DEPTH), REPS (2), MIN_MS (50), FIVE (4),
#   WAIT_S (1500), DEVICE_NAME (first available iPhone).
set -uo pipefail
cd "$(dirname "$0")/../../.."

PORT="${PORT:-8123}"
OUT="${OUT:-experiments/wasm/probe/reports}"
TARGET="${TARGET:-ios-safari}"
DEPTH="${DEPTH:-5}"
PARITY_DEPTH="${PARITY_DEPTH:-$DEPTH}"
REPS="${REPS:-2}"
MIN_MS="${MIN_MS:-50}"
FIVE="${FIVE:-4}"
WAIT_S="${WAIT_S:-1500}"
DEVICE_NAME="${DEVICE_NAME:-}"

mkdir -p "$OUT"

UDID=$(python3 - "$DEVICE_NAME" <<'PY'
import json, subprocess, sys
want = sys.argv[1] if len(sys.argv) > 1 else ''
data = json.loads(subprocess.check_output(
    ['xcrun', 'simctl', 'list', 'devices', 'available', '--json']))
candidates = []
for runtime, devs in data['devices'].items():
    if 'iOS' not in runtime:
        continue
    for dev in devs:
        name = dev.get('name', '')
        if want:
            if name == want:
                candidates.append((runtime, dev))
        elif name.startswith('iPhone'):
            candidates.append((runtime, dev))
if not candidates:
    sys.exit('no matching iPhone simulator available')
# newest runtime last in sort order; take it
candidates.sort(key=lambda c: c[0])
runtime, dev = candidates[-1]
print(dev['udid'])
print('picked %s (%s)' % (dev['name'], runtime), file=sys.stderr)
PY
) || { echo "FAIL: no iPhone simulator found"; xcrun simctl list devices available; exit 1; }
echo "--- simulator UDID: $UDID"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
echo "--- simulator booted"

node experiments/wasm/probe/server.js --port "$PORT" --host 127.0.0.1 --out "$OUT" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true; xcrun simctl shutdown "$UDID" 2>/dev/null || true' EXIT
sleep 1

URL="http://127.0.0.1:${PORT}/experiments/wasm/probe/?depth=${DEPTH}&parityDepth=${PARITY_DEPTH}&reps=${REPS}&minMs=${MIN_MS}&five=${FIVE}&target=${TARGET}"
echo "--- opening $URL in Mobile Safari"
xcrun simctl openurl "$UDID" "$URL"

if node experiments/wasm/probe/wait-report.js "$OUT/final-${TARGET}.json" "$WAIT_S"; then
  exit 0
fi

echo "--- probe failed; collecting diagnostics"
xcrun simctl io "$UDID" screenshot "$OUT/${TARGET}-screen.png" || true
xcrun simctl spawn "$UDID" log show --last 5m --predicate 'processImagePath contains "MobileSafari"' > "$OUT/${TARGET}-safari-log.txt" 2>/dev/null || true
exit 1
