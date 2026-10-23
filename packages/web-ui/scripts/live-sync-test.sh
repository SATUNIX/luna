#!/usr/bin/env bash
# live-sync-test.sh — end-to-end check that the web UI sees NEW messages written to a
# session file by another process (the CLI scenario), not just the initial replay.
#
# Runs an isolated server (temp session dir, own port) so it never touches real sessions.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PI_CONSOLE_SYNC_PORT:-8237}"
BASE="localhost:${PORT}"
# The console requires an access token on every API route; use a throwaway one for this run.
TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
AUTH=(-H "Authorization: Bearer ${TOKEN}")
TMP="$(mktemp -d)"
ENC="--home-operator--"
SID="live-sync-test"
FILE="${TMP}/${ENC}/2026-01-01T00-00-00-000Z_${SID}.jsonl"

pass=0
fail=0
ok() {
	echo "  PASS  $1"
	pass=$((pass + 1))
}
bad() {
	echo "  FAIL  $1"
	fail=$((fail + 1))
}

cleanup() {
	[[ -n "${SERVER_PID:-}" ]] && kill "${SERVER_PID}" >/dev/null 2>&1
	pkill -f "curl -sN "${AUTH[@]}" ${BASE}" >/dev/null 2>&1 || true
	rm -rf "${TMP}"
}
trap cleanup EXIT

msg() { # role text
	printf '{"type":"message","id":"m-%s","parentId":null,"timestamp":"2026-01-01T00:00:0%s.000Z","message":{"role":"%s","content":[{"type":"text","text":"%s"}],"timestamp":1}}\n' "$1" "$2" "$1" "$3"
}

mkdir -p "${TMP}/${ENC}"
{
	printf '{"type":"session","version":3,"id":"%s","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/operator"}\n' "${SID}"
	msg user 1 "MESSAGE_ONE_initial"
} >"${FILE}"

echo "pi-console live-sync test (port ${PORT})"

(cd "${ROOT}" && PI_CONSOLE_TOKEN="${TOKEN}" PI_CONSOLE_PORT="${PORT}" PI_CODING_AGENT_SESSION_DIR="${TMP}" node server/server.ts) >/tmp/pi-console-sync.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
	curl -s "${AUTH[@]}" --max-time 2 "${BASE}/api/health" >/dev/null 2>&1 && break
	sleep 0.3
done

echo "[1] session is listed with live status"
BODY=$(curl -s "${AUTH[@]}" --max-time 10 "${BASE}/api/sessions")
echo "${BODY}" | grep -q "${SID}" && ok "session listed" || bad "session not listed: ${BODY:0:200}"
echo "${BODY}" | grep -q '"status":"external"' && ok "marked external while being written" || bad "not marked external"

echo "[2] initial subscribe replays existing history"
curl -sN "${AUTH[@]}" --max-time 12 "${BASE}/api/sessions/${SID}/events" >/tmp/sync-cap1.txt 2>&1 &
sleep 3
grep -q 'MESSAGE_ONE_initial' /tmp/sync-cap1.txt && ok "history replayed" || bad "history missing"

echo "[3] NEW message written while subscribed (the CLI case)"
msg assistant 2 "MESSAGE_TWO_incremental" >>"${FILE}"
sleep 4
grep -q 'MESSAGE_TWO_incremental' /tmp/sync-cap1.txt && ok "incremental message streamed" || bad "incremental message NOT streamed"

echo "[4] another new message"
msg user 3 "MESSAGE_THREE_incremental" >>"${FILE}"
sleep 4
grep -q 'MESSAGE_THREE_incremental' /tmp/sync-cap1.txt && ok "second incremental message streamed" || bad "second incremental message NOT streamed"

echo "[5] reconnect after the previous viewer drops (reacquire path)"
pkill -f "curl -sN "${AUTH[@]}" ${BASE}" >/dev/null 2>&1 || true
sleep 1
curl -sN "${AUTH[@]}" --max-time 12 "${BASE}/api/sessions/${SID}/events" >/tmp/sync-cap2.txt 2>&1 &
sleep 3
msg assistant 4 "MESSAGE_FOUR_after_reconnect" >>"${FILE}"
sleep 4
grep -q 'MESSAGE_FOUR_after_reconnect' /tmp/sync-cap2.txt && ok "message streamed after reconnect" || bad "no streaming after reconnect"

echo "[6] no duplicate delivery of the same message"
DUPES=$(grep -o 'MESSAGE_TWO_incremental' /tmp/sync-cap1.txt | wc -l)
[[ "${DUPES}" -le 1 ]] && ok "no duplicates (saw ${DUPES})" || bad "duplicate delivery (saw ${DUPES})"

echo
echo "live-sync test: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]] || exit 1
