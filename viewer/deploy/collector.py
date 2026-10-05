#!/usr/bin/env python3
"""Diagnostic sink for the VR probe.

The probe runs on a headset with no usable devtools, so everything it learns has
to leave the device to be worth anything. This accepts the report it posts and
appends it as one JSON object per line, which is the shape that survives being
grepped six weeks later.

Stdlib only, deliberately: it sits next to nginx on the media host and should
never be a thing that needs maintaining.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG_DIR = os.environ.get("LOG_DIR", "/logs")
MAX_BODY = 512 * 1024
PORT = int(os.environ.get("PORT", "9000"))


def logfile():
    return os.path.join(LOG_DIR, f"vr-{datetime.now(timezone.utc):%Y%m%d}.jsonl")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, body=b""):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            self._send(200, b"ok")
        elif self.path.startswith("/tail"):
            # Convenience for reading back from the host without a shell in here.
            try:
                with open(logfile(), "rb") as f:
                    data = f.readlines()[-200:]
                self._send(200, b"".join(data))
            except FileNotFoundError:
                self._send(200, b"")
        else:
            self._send(404)

    def do_POST(self):
        if not self.path.startswith("/log"):
            self._send(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._send(413)
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {"parseError": True, "raw": raw[:2000].decode("utf-8", "replace")}

        record = {
            "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "ip": self.headers.get("X-Forwarded-For", self.client_address[0]),
            "ua": self.headers.get("User-Agent", ""),
            "payload": payload,
        }
        line = json.dumps(record, ensure_ascii=False, default=str)
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(logfile(), "a", encoding="utf-8") as f:
            f.write(line + "\n")
        # Also to stdout, so `docker logs` shows it live during a headset session.
        print(line, flush=True)
        self._send(204)

    def log_message(self, fmt, *args):
        pass  # the records above are the log; access noise is not wanted


if __name__ == "__main__":
    os.makedirs(LOG_DIR, exist_ok=True)
    print(f"vr collector listening on :{PORT}, writing to {LOG_DIR}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
