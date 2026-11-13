#!/usr/bin/env sh
set -eu

DATA_ROOT="${PI_AGENT_DATA_ROOT:-${PENTEST_DATA_ROOT:-/srv/data/pi-system}}"

python3 scripts/validate-runtime-readiness.py
python3 scripts/validate-scope-roe.py
sh scripts/validate-engagement-env.sh
sh scripts/validate-governance-mcp-server.sh
python3 scripts/validate-engagement-overlays.py
python3 scripts/validate-compose-parity.py
python3 scripts/validate-ledgers.py --data-root "$DATA_ROOT"
sh capability/tests/validate-compose.sh
