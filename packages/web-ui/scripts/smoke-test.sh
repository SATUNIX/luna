#!/usr/bin/env bash
# smoke-test.sh — end-to-end check for pi-console.
#
# Starts the server on an isolated port, exercises the REST surface, performs a real
# pi RPC spawn + prompt + SSE roundtrip, then cleans up. Requires the `pi` binary on PATH.
#
# Usage: scripts/smoke-test.sh [provider] [model]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PI_CONSOLE_TEST_PORT:-8231}"
BASE="localhost:${PORT}"
# The console requires an access token on every API route; use a throwaway one for this run.
TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
AUTH=(-H "Authorization: Bearer ${TOKEN}")
PROVIDER="${1:-openrouter-custom}"
MODEL="${2:-deepseek/deepseek-v4.1-flash}"
TIMEOUT=90

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
	if [[ -n "${SID:-}" ]]; then
		curl -s "${AUTH[@]}" --max-time 5 -X DELETE -H 'Content-Type: application/json' "${BASE}/api/sessions/${SID}" >/dev/null 2>&1 || true
	fi
	if [[ -n "${SERVER_PID:-}" ]]; then
		kill "${SERVER_PID}" >/dev/null 2>&1 || true
	fi
	[[ -n "${SSE_FILE:-}" ]] && rm -f "${SSE_FILE}"
	[[ -n "${TMP_SESSIONS:-}" ]] && rm -rf "${TMP_SESSIONS}"
}
trap cleanup EXIT

echo "pi-console smoke test"
echo "  provider=${PROVIDER} model=${MODEL} port=${PORT}"

echo "[1] start server (isolated session dir)"
TMP_SESSIONS=$(mktemp -d)
(cd "${ROOT}" && PI_CONSOLE_TOKEN="${TOKEN}" PI_CONSOLE_PORT="${PORT}" PI_CODING_AGENT_SESSION_DIR="${TMP_SESSIONS}" node server/server.ts) >/tmp/pi-console-smoke.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do
	curl -s "${AUTH[@]}" --max-time 2 "${BASE}/api/health" >/dev/null 2>&1 && break
	sleep 0.3
done

echo "[2] health"
HEALTH=$(curl -s "${AUTH[@]}" --max-time 5 "${BASE}/api/health")
echo "${HEALTH}" | grep -q '"ok":true' && ok "health ok" || bad "health failed: ${HEALTH}"

echo "[3] discovery endpoints"
for ep in agents models cwds sessions; do
	BODY=$(curl -s "${AUTH[@]}" --max-time 10 "${BASE}/api/${ep}")
	if [[ -n "${BODY}" && "${BODY}" != *'"error"'* ]]; then ok "/api/${ep}"; else bad "/api/${ep}: ${BODY}"; fi
done

echo "[4] static frontend"
curl -s "${AUTH[@]}" --max-time 5 "${BASE}/" | grep -q '<title>pi-console</title>' && ok "index served" || bad "index not served"
curl -s "${AUTH[@]}" -o /dev/null -w "%{http_code}" --max-time 5 "${BASE}/css/style.css" | grep -q 200 && ok "stylesheet served" || bad "stylesheet not served"

echo "[5] spawn a real pi RPC session (provider=${PROVIDER})"
SPAWN=$(curl -s "${AUTH[@]}" --max-time 30 -X POST "${BASE}/api/sessions" \
	-H 'Content-Type: application/json' \
	-d "{\"cwd\":\"/home/operator\",\"provider\":\"${PROVIDER}\",\"model\":\"${MODEL}\",\"thinking\":\"off\"}")
SID=$(echo "${SPAWN}" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("session") or {}).get("id",""))' 2>/dev/null)
if [[ -n "${SID}" ]]; then ok "spawned session ${SID:0:8}"; else
	bad "spawn failed: ${SPAWN}"
	exit 1
fi

echo "[6] prompt + streamed reply"
SSE_FILE=$(mktemp)
curl -sN "${AUTH[@]}" --max-time "${TIMEOUT}" "${BASE}/api/sessions/${SID}/events" >"${SSE_FILE}" 2>&1 &
sleep 1
curl -s "${AUTH[@]}" --max-time 10 -X POST "${BASE}/api/sessions/${SID}/prompt" \
	-H 'Content-Type: application/json' \
	-d '{"message":"Reply with exactly: PI_CONSOLE_SMOKE_OK"}' >/dev/null

for _ in $(seq 1 "${TIMEOUT}"); do
	grep -q 'PI_CONSOLE_SMOKE_OK' "${SSE_FILE}" && break
	sleep 1
done
grep -q 'PI_CONSOLE_SMOKE_OK' "${SSE_FILE}" && ok "assistant replied (streamed via SSE)" || bad "no assistant reply within ${TIMEOUT}s"
grep -q 'agent_start' "${SSE_FILE}" && ok "event stream carried pi lifecycle events" || bad "no pi lifecycle events observed"
grep -q 'message_update\|message_end' "${SSE_FILE}" && ok "event stream carried assistant message events" || bad "no assistant message events observed"

echo "[7] session appears in the list"
curl -s "${AUTH[@]}" --max-time 10 "${BASE}/api/sessions" | grep -q "${SID}" && ok "session listed" || bad "session missing from list"

echo "[8] session info while running (stats / todos / lens)"
curl -s "${AUTH[@]}" --max-time 20 "${BASE}/api/sessions/${SID}/stats" | grep -q '\"tokens\"' && ok "/stats" || bad "/stats"
curl -s "${AUTH[@]}" --max-time 10 "${BASE}/api/sessions/${SID}/todos" | grep -q '\"todos\"' && ok "/todos" || bad "/todos"
curl -s "${AUTH[@]}" --max-time 10 "${BASE}/api/sessions/${SID}/lens" | grep -q '\"lens\"' && ok "/lens" || bad "/lens"

echo "[9] stop session"
curl -s "${AUTH[@]}" --max-time 10 -X DELETE -H 'Content-Type: application/json' "${BASE}/api/sessions/${SID}" | grep -q '"stopping":true' && ok "stop accepted" || bad "stop failed"
SID=""
echo "[10] live sync (tail a session file written by another process)"
# Deterministic: craft a session file the way an external pi process would, then confirm the
# events endpoint follows it (this is what makes a CLI session live in the UI).
ENC="--home-operator--"
TAIL_ID="smoke-tail-$(date +%s)"
mkdir -p "${TMP_SESSIONS}/${ENC}"
TAIL_FILE="${TMP_SESSIONS}/${ENC}/2026-01-01T00-00-00-000Z_${TAIL_ID}.jsonl"
{
	printf '%s\n' "{\"type\":\"session\",\"version\":3,\"id\":\"${TAIL_ID}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/home/operator\"}"
	printf '%s\n' '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hello from an external process"}],"timestamp":1}}'
	printf '%s\n' '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"acknowledged"}],"timestamp":2}}'
} >"${TAIL_FILE}"

timeout 6 curl -sN "${AUTH[@]}" "${BASE}/api/sessions/${TAIL_ID}/events" >/tmp/pi-console-tail.sse 2>&1 || true
if grep -q '"state":"watching"' /tmp/pi-console-tail.sse; then ok "lifecycle: watching"; else bad "no watching lifecycle"; fi
if grep -q '"type":"observed_message"' /tmp/pi-console-tail.sse; then ok "observed_message events tailed"; else bad "no observed messages tailed"; fi
if grep -q 'hello from an external process' /tmp/pi-console-tail.sse; then ok "external content replayed"; else bad "external content missing"; fi
if curl -s "${AUTH[@]}" --max-time 10 "${BASE}/api/sessions" | grep -q '"externalActive"'; then ok "sessions expose externalActive"; else bad "externalActive missing"; fi
if curl -s "${AUTH[@]}" --max-time 5 "${BASE}/" | grep -q 'toggle-inspector'; then ok "panel toggles present"; else bad "panel toggles missing"; fi

echo "[11] extended info endpoints"
curl -s "${AUTH[@]}" --max-time 10 "${BASE}/api/config" | grep -q '"cli"' && ok "/api/config" || bad "/api/config"
curl -s "${AUTH[@]}" --max-time 10 "${BASE}/api/prompts" | grep -q '"prompts"' && ok "/api/prompts" || bad "/api/prompts"
curl -s "${AUTH[@]}" --max-time 10 "${BASE}/api/skills" | grep -q '"skills"' && ok "/api/skills" || bad "/api/skills"

echo "[12] agent CRUD roundtrip"
AG="pc-smoke-agent-$$"
create=$(curl -s "${AUTH[@]}" --max-time 10 -X POST "${BASE}/api/agents" -H 'Content-Type: application/json' \
	-d "{\"name\":\"${AG}\",\"description\":\"smoke\",\"tools\":[\"read\"],\"body\":\"test\",\"source\":\"user\"}")
echo "${create}" | grep -q '"name"' && ok "create agent" || bad "create agent: ${create}"
curl -s "${AUTH[@]}" --max-time 10 "${BASE}/api/agents/${AG}?source=user" | grep -q '"body"' && ok "read agent body" || bad "read agent body"
curl -s "${AUTH[@]}" --max-time 10 -X POST "${BASE}/api/agents" -H 'Content-Type: application/json' -d '{"name":"../../evil"}' | grep -q '"error"' && ok "rejects path traversal" || bad "traversal not rejected"
curl -s "${AUTH[@]}" --max-time 10 -X PUT "${BASE}/api/agents/${AG}" -H 'Content-Type: application/json' -d "{\"description\":\"updated\",\"tools\":[\"read\",\"grep\"],\"body\":\"updated\",\"source\":\"user\"}" | grep -q 'updated' && ok "update agent" || bad "update agent"
curl -s "${AUTH[@]}" --max-time 10 -X DELETE -H 'Content-Type: application/json' "${BASE}/api/agents/${AG}?source=user" | grep -q '"deleted":true' && ok "delete agent" || bad "delete agent"
[[ ! -f "${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}/agents/${AG}.md" ]] && ok "agent file removed" || bad "agent file left behind"

echo "[13] offline UI wiring check"
if (cd "${ROOT}" && node scripts/ui-smoke.ts >/tmp/pi-console-ui-smoke.log 2>&1); then ok "ui-smoke.ts"; else bad "ui-smoke.ts (see /tmp/pi-console-ui-smoke.log)"; fi
if (cd "${ROOT}" && node scripts/tailer-test.ts >/tmp/pi-console-tailer-test.log 2>&1); then ok "tailer-test.ts (fragmented writes)"; else bad "tailer-test.ts (see /tmp/pi-console-tailer-test.log)"; fi

if (cd "${ROOT}" && scripts/live-sync-test.sh >/tmp/pi-console-live-sync.log 2>&1); then ok "live-sync-test.sh (incremental CLI updates)"; else bad "live-sync-test.sh (see /tmp/pi-console-live-sync.log)"; fi

echo
echo "smoke test: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]] || exit 1
