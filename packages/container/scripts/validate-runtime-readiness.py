#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_DATA_ROOT = pathlib.Path("/srv/data/pi-system")
REQUIRED_DATA_DIRS = [
    "audit",
    "checkpoints",
    "evidence/artifacts",
    "findings",
    "hypotheses",
    "memory",
    "reports",
    "sessions",
    "tasks/history",
    "trace",
    "db",
    "verification",
    "pi-agent",
]
REQUIRED_MCP_SETTINGS = {
    "directTools": False,
    "disableProxyTool": False,
    "sampling": False,
    "samplingAutoApprove": False,
    "autoAuth": False,
    "elicitation": False,
    "elicitationAutoOpenUrls": False,
}
REQUIRED_GOVERNANCE_SETTINGS = {
    "directTools": False,
    "sampling": False,
    "samplingAutoApprove": False,
}
REQUIRED_MEMORY_MCP_SETTINGS = {
    "directTools": False,
    "sampling": False,
    "samplingAutoApprove": False,
}
EXPECTED_GOVERNANCE_TOOLS = {
    "evidence_append",
    "note_append",
    "checkpoint_append",
    "task_state_read",
    "task_state_update",
    "memory_append",
    "verification_append",
    "state_summary",
}
EXPECTED_MEMORY_MCP_TOOLS = {
    "memory_store",
    "memory_search",
    "memory_update",
    "memory_list",
    "task_create",
    "task_list",
    "task_state_read",
    "task_state_update",
    "task_complete",
    "checkpoint_append",
    "trace_append",
    "trace_tail",
    "state_summary",
}
SENSITIVE_KEY_RE = re.compile(
    r"(api[_-]?key|secret|token|password|passwd|credential|authorization|private[_-]?key)",
    re.IGNORECASE,
)
SECRET_VALUE_PATTERNS = [
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"ASIA[0-9A-Z]{16}"),
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{20,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]
PLACEHOLDER_VALUES = {
    "",
    "example",
    "example-value",
    "placeholder",
    "redacted",
    "changeme",
    "change-me",
    "none",
    "null",
    "false",
    "true",
    "your-api-key",
    "your-token",
    "your-secret",
    "ollama",
}


class Reporter:
    def __init__(self):
        self.failures = []
        self.warnings = []

    def ok(self, message):
        print(f"OK: {message}")

    def warn(self, message):
        self.warnings.append(message)
        print(f"WARN: {message}")

    def fail(self, message):
        self.failures.append(message)
        print(f"FAIL: {message}", file=sys.stderr)


def load_json(relative_path, reporter):
    path = ROOT / relative_path
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except Exception as exc:
        reporter.fail(f"{relative_path} is not readable valid JSON: {exc}")
        return None
    reporter.ok(f"{relative_path} is readable valid JSON")
    return value


def config_path(name):
    generated = ROOT / ".pi" / name
    if generated.is_file():
        return pathlib.Path(".pi") / name
    overlay = ROOT / "overlays" / "pi" / name
    if overlay.is_file():
        return pathlib.Path("overlays") / "pi" / name
    return pathlib.Path(".pi") / name


def verify_required_files(reporter):
    required = [config_path("settings.json"), config_path("mcp.json"), config_path("models.json")]
    for relative_path in required:
        path = ROOT / relative_path
        if not path.is_file():
            reporter.fail(f"{relative_path} is missing")
            continue
        try:
            path.read_text(encoding="utf-8")
        except Exception as exc:
            reporter.fail(f"{relative_path} is not readable: {exc}")
            continue
        reporter.ok(f"{relative_path} is readable")

    append_system = ROOT / ".pi" / "APPEND_SYSTEM.md"
    if append_system.is_file():
        reporter.ok(".pi/APPEND_SYSTEM.md is readable")
    else:
        reporter.warn(".pi/APPEND_SYSTEM.md is absent; runtime may rely on installed pi-kit prompts instead")

    settings = load_json(str(config_path("settings.json")), reporter)
    mcp = load_json(str(config_path("mcp.json")), reporter)
    models = load_json(str(config_path("models.json")), reporter)
    return settings, mcp, models


def verify_data_dirs(data_root, reporter):
    default_runtime_root = data_root == DEFAULT_DATA_ROOT
    if data_root == DEFAULT_DATA_ROOT and not data_root.exists():
        reporter.warn(
            f"{data_root} is absent on this host; directory creation is deferred to container/Pi System runtime"
        )
        return

    for relative_dir in REQUIRED_DATA_DIRS:
        target = data_root / relative_dir
        try:
            target.mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            if default_runtime_root and os.name == "nt":
                reporter.warn(
                    f"cannot create {target} on this Windows host; directory creation is deferred to container/Pi System runtime: {exc}"
                )
                continue
            reporter.fail(f"cannot create required data directory {target}: {exc}")
            continue
        if not target.is_dir():
            reporter.fail(f"required data path is not a directory: {target}")
            continue
        reporter.ok(f"data directory ready: {target}")


def verify_mcp_config(mcp, reporter):
    if not isinstance(mcp, dict):
        return
    settings = mcp.get("settings")
    if not isinstance(settings, dict):
        reporter.fail(".pi/mcp.json must contain object settings")
        return

    for key, expected in REQUIRED_MCP_SETTINGS.items():
        actual = settings.get(key)
        if actual is not expected:
            reporter.fail(f".pi/mcp.json settings.{key} must be {str(expected).lower()}")
        else:
            reporter.ok(f".pi/mcp.json settings.{key} is {str(expected).lower()}")

    servers = mcp.get("mcpServers")
    if not isinstance(servers, dict):
        reporter.fail(".pi/mcp.json must contain object mcpServers")
        return
    governance = servers.get("pi_system_governance")
    if not isinstance(governance, dict):
        reporter.fail(".pi/mcp.json must configure pi_system_governance")
        return
    memory_mcp = servers.get("memory_mcp")
    if not isinstance(memory_mcp, dict):
        reporter.fail(".pi/mcp.json must configure memory_mcp")
        return

    if governance.get("command") != "node":
        reporter.fail('pi_system_governance command must be "node"')
    else:
        reporter.ok('pi_system_governance command is "node"')

    args = governance.get("args")
    expected_governance_paths = {
        "/workspace/.pi/mcp-servers/governance/index.ts",
        "/opt/pi-agent/mcp-servers/governance/index.ts",
    }
    if not isinstance(args, list) or not expected_governance_paths.intersection(set(args)):
        reporter.fail("pi_system_governance args must include a known governance MCP server path")
    else:
        reporter.ok("pi_system_governance points at the local governance MCP server")

    for key, expected in REQUIRED_GOVERNANCE_SETTINGS.items():
        actual = governance.get(key)
        if actual is not expected:
            reporter.fail(f"pi_system_governance {key} must be {str(expected).lower()}")
        else:
            reporter.ok(f"pi_system_governance {key} is {str(expected).lower()}")

    if memory_mcp.get("command") != "node":
        reporter.fail('memory_mcp command must be "node"')
    else:
        reporter.ok('memory_mcp command is "node"')

    memory_args = memory_mcp.get("args")
    if not isinstance(memory_args, list) or "/opt/pi-agent/mcp-servers/memory-mcp/index.ts" not in memory_args:
        reporter.fail("memory_mcp args must include /opt/pi-agent/mcp-servers/memory-mcp/index.ts")
    else:
        reporter.ok("memory_mcp points at the memory MCP launcher")

    for key, expected in REQUIRED_MEMORY_MCP_SETTINGS.items():
        actual = memory_mcp.get(key)
        if actual is not expected:
            reporter.fail(f"memory_mcp {key} must be {str(expected).lower()}")
        else:
            reporter.ok(f"memory_mcp {key} is {str(expected).lower()}")


def extract_governance_tools(reporter):
    generated = ROOT / ".pi" / "mcp-servers" / "governance" / "index.ts"
    server_path = generated if generated.is_file() else ROOT / "mcp-servers" / "governance" / "index.ts"
    try:
        text = server_path.read_text(encoding="utf-8")
    except Exception as exc:
        reporter.fail(f"cannot read governance MCP server: {exc}")
        return set()
    tools = set(re.findall(r"registerTool\(\s*[\"']([^\"']+)[\"']", text))
    if not tools:
        reporter.fail("could not find registered governance MCP tools")
        return set()
    missing = EXPECTED_GOVERNANCE_TOOLS - tools
    extra = tools - EXPECTED_GOVERNANCE_TOOLS
    if missing:
        reporter.fail(f"governance MCP server missing expected tools: {', '.join(sorted(missing))}")
    if extra:
        reporter.fail(f"governance MCP server has unexpected tools: {', '.join(sorted(extra))}")
    if not missing and not extra:
        reporter.ok("governance MCP server exposes the expected local tool set")
    return tools


def verify_tool_policy(reporter):
    policy = load_json("engagement/tool-policy.json", reporter)
    if not isinstance(policy, dict):
        return
    tools = extract_governance_tools(reporter)
    policy_tools = policy.get("tools")
    if not isinstance(policy_tools, dict):
        reporter.fail("engagement/tool-policy.json must contain object tools")
        return

    expected_keys = {f"mcp.tool.pi_system_governance_{tool}" for tool in tools}
    actual_keys = {
        key
        for key, value in policy_tools.items()
        if isinstance(value, dict) and value.get("server") == "pi_system_governance"
    }
    missing_keys = expected_keys - actual_keys
    extra_keys = actual_keys - expected_keys
    if missing_keys:
        reporter.fail(f"tool policy missing pi_system_governance mappings: {', '.join(sorted(missing_keys))}")
    if extra_keys:
        reporter.fail(f"tool policy has stale pi_system_governance mappings: {', '.join(sorted(extra_keys))}")

    for tool in sorted(tools):
        key = f"mcp.tool.pi_system_governance_{tool}"
        entry = policy_tools.get(key)
        if not isinstance(entry, dict):
            continue
        if entry.get("server") != "pi_system_governance":
            reporter.fail(f"{key} server must be pi_system_governance")
        if entry.get("tool_name") != tool:
            reporter.fail(f"{key} tool_name must be {tool}")
        if entry.get("decision") not in {"allow", "ask", "deny"}:
            reporter.fail(f"{key} decision must be allow, ask, or deny")
    if not missing_keys and not extra_keys:
        reporter.ok("tool policy has exact local mappings for pi_system_governance tools")

    memory_keys = {
        key
        for key, value in policy_tools.items()
        if isinstance(value, dict) and value.get("server") == "memory_mcp"
    }
    expected_memory_keys = {f"mcp.tool.memory_mcp_{tool}" for tool in EXPECTED_MEMORY_MCP_TOOLS}
    missing_memory_keys = expected_memory_keys - memory_keys
    if missing_memory_keys:
        reporter.fail(f"tool policy missing memory_mcp mappings: {', '.join(sorted(missing_memory_keys))}")
    else:
        reporter.ok("tool policy has expected mappings for memory_mcp tools")


def is_placeholder(value):
    normalized = str(value).strip().strip("\"'").lower()
    return (
        normalized in PLACEHOLDER_VALUES
        or normalized.startswith("your-")
        or normalized.startswith("<")
        or normalized.endswith(".example")
    )


def scan_json_value(value, path, reporter, key_path=""):
    if isinstance(value, dict):
        for key, nested in value.items():
            nested_path = f"{key_path}.{key}" if key_path else str(key)
            if SENSITIVE_KEY_RE.search(str(key)) and isinstance(nested, str) and not is_placeholder(nested):
                reporter.fail(f"{path}: secret-looking value at {nested_path}")
            scan_json_value(nested, path, reporter, nested_path)
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            scan_json_value(nested, path, reporter, f"{key_path}[{index}]")
    elif isinstance(value, str):
        for pattern in SECRET_VALUE_PATTERNS:
            if pattern.search(value) and not is_placeholder(value):
                reporter.fail(f"{path}: secret-looking token at {key_path or '<value>'}")


def scan_secret_text(path, text, reporter):
    assignment_re = re.compile(
        r"(?im)^\s*([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|credential|authorization|private[_-]?key)[A-Za-z0-9_.-]*)\s*[:=]\s*([^#\r\n]+)"
    )
    for match in assignment_re.finditer(text):
        key = match.group(1)
        value = match.group(2).strip()
        if is_placeholder(value):
            continue
        if value.lower() in {"true", "false", "null", "none"}:
            continue
        reporter.fail(f"{path}: secret-looking assignment for {key}")

    for pattern in SECRET_VALUE_PATTERNS:
        if pattern.search(text):
            reporter.fail(f"{path}: secret-looking token pattern")


def verify_no_committed_secrets(reporter):
    paths = [ROOT / config_path("mcp.json")]
    root_mcp = ROOT / ".mcp.json"
    if root_mcp.exists():
        paths.append(root_mcp)
    paths.extend(sorted((ROOT / "engagement").glob("*.json")))
    paths.extend(sorted((ROOT / "engagement").glob("*.yaml")))
    paths.extend(sorted((ROOT / "engagement").glob("*.yml")))

    for path in paths:
        relative = path.relative_to(ROOT).as_posix()
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as exc:
            reporter.fail(f"cannot read {relative} for secret scan: {exc}")
            continue
        if path.suffix == ".json":
            try:
                scan_json_value(json.loads(text), relative, reporter)
            except Exception as exc:
                reporter.fail(f"{relative} is not valid JSON during secret scan: {exc}")
        scan_secret_text(relative, text, reporter)
    reporter.ok("committed MCP config and engagement overlays scanned for secret-looking values")


def verify_compose_parity(reporter):
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "validate-compose-parity.py")],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
    )
    if result.returncode:
        details = (result.stderr or result.stdout).strip()
        reporter.fail(f"compose parity validation failed: {details}")
    else:
        reporter.ok("root and canonical compose parity validation passed")


def model_probe_url(url):
    stripped = url.rstrip("/")
    if stripped.endswith("/v1"):
        return f"{stripped}/models"
    return f"{stripped}/v1/models"


def probe_model_endpoint(url, timeout, required, reporter):
    probe_url = model_probe_url(url)
    request = urllib.request.Request(probe_url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if 200 <= response.status < 500:
                reporter.ok(f"model endpoint responded at {probe_url} with HTTP {response.status}")
            else:
                message = f"model endpoint returned HTTP {response.status} at {probe_url}"
                reporter.fail(message) if required else reporter.warn(message)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        message = f"model endpoint unreachable at {probe_url}: {exc}"
        reporter.fail(message) if required else reporter.warn(message)


def main():
    parser = argparse.ArgumentParser(description="Validate Pi agent runtime readiness without starting Pi.")
    parser.add_argument("--data-root", default=os.environ.get("PI_AGENT_DATA_ROOT", os.environ.get("PENTEST_DATA_ROOT", str(DEFAULT_DATA_ROOT))))
    parser.add_argument("--check-model-endpoint", action="store_true")
    parser.add_argument("--require-model-endpoint", action="store_true")
    parser.add_argument("--model-endpoint-url", default=os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434/v1"))
    parser.add_argument("--model-timeout", type=float, default=2.0)
    args = parser.parse_args()

    reporter = Reporter()
    verify_data_dirs(pathlib.Path(args.data_root), reporter)
    _settings, mcp, _models = verify_required_files(reporter)
    verify_mcp_config(mcp, reporter)
    verify_tool_policy(reporter)
    verify_no_committed_secrets(reporter)
    verify_compose_parity(reporter)

    if args.check_model_endpoint or args.require_model_endpoint:
        probe_model_endpoint(args.model_endpoint_url, args.model_timeout, args.require_model_endpoint, reporter)
    else:
        reporter.ok("model endpoint probe skipped; pass --check-model-endpoint to probe Ollama")

    if reporter.failures:
        print(f"Runtime readiness failed with {len(reporter.failures)} error(s)", file=sys.stderr)
        return 1
    if reporter.warnings:
        print(f"Runtime readiness passed with {len(reporter.warnings)} warning(s)")
    else:
        print("Runtime readiness checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
