#!/usr/bin/env python3
import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


HOST = os.environ.get("PI_AGENT_HEALTH_HOST", os.environ.get("PENTEST_HEALTH_HOST", "127.0.0.1"))
PORT = int(os.environ.get("PI_AGENT_HEALTH_PORT", os.environ.get("PENTEST_HEALTH_PORT", "8080")))
DATA_ROOT = os.environ.get(
    "PI_AGENT_DATA_ROOT", os.environ.get("PENTEST_DATA_ROOT", "/srv/data/pi-system")
)


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path != "/health":
            self._json(404, {"error": "not_found"})
            return

        writable = os.access(DATA_ROOT, os.W_OK)
        self._json(
            200 if writable else 503,
            {
                "status": "ok" if writable else "degraded",
                "capability": "pi-system",
                "data_root": DATA_ROOT,
                "data_root_writable": writable,
            },
        )

    def log_message(self, _format, *args):
        return


def serve():
    HTTPServer((HOST, PORT), Handler).serve_forever()


def check():
    # Local probe: nothing in the image starts --serve, so --check must not need the server.
    # It applies the same test /health reports: the data root is writable.
    if not os.access(DATA_ROOT, os.W_OK):
        print(f"healthcheck failed: data root {DATA_ROOT} is not writable", file=sys.stderr)
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    if args.serve:
        serve()
        return
    if args.check:
        check()
        return
    parser.error("expected --serve or --check")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"healthcheck failed: {exc}", file=sys.stderr)
        raise
