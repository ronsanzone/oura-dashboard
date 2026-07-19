#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")


def main() -> None:
    client_id = os.environ.get("OURA_CLIENT_ID")
    client_secret = os.environ.get("OURA_CLIENT_SECRET")
    redirect_uri = os.getenv("OURA_REDIRECT_URI", "http://localhost:8765/callback")
    if not client_id or not client_secret:
        raise SystemExit("Set OURA_CLIENT_ID and OURA_CLIENT_SECRET in .env first.")
    state = secrets.token_urlsafe(24)
    result: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            query = parse_qs(urlparse(self.path).query)
            if query.get("state", [""])[0] != state:
                self.send_response(400); self.end_headers(); self.wfile.write(b"Invalid OAuth state."); return
            result["code"] = query.get("code", [""])[0]
            result["error"] = query.get("error", [""])[0]
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
            self.wfile.write(b"<h2>Oura connected.</h2><p>You can close this tab and return to the terminal.</p>")
            threading.Thread(target=self.server.shutdown, daemon=True).start()

        def log_message(self, *_):
            return

    parsed = urlparse(redirect_uri)
    if parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise SystemExit("This helper expects a localhost OURA_REDIRECT_URI.")
    server = HTTPServer((parsed.hostname, parsed.port or 80), Handler)
    params = {
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri, "state": state,
        "scope": "email personal daily heartrate tag workout session spo2 ring_configuration stress heart_health",
    }
    url = "https://cloud.ouraring.com/oauth/authorize?" + urlencode(params)
    print("Opening Oura authorization in your browser…")
    print(url)
    webbrowser.open(url)
    server.serve_forever()
    if result.get("error") or not result.get("code"):
        raise SystemExit(f"Authorization failed: {result.get('error', 'missing code')}")
    response = requests.post("https://api.ouraring.com/oauth/token", data={
        "grant_type": "authorization_code", "code": result["code"], "redirect_uri": redirect_uri,
        "client_id": client_id, "client_secret": client_secret,
    }, timeout=30)
    response.raise_for_status()
    token_path = ROOT / os.getenv("OURA_TOKEN_PATH", "data/token.json")
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(json.dumps(response.json(), indent=2)); token_path.chmod(0o600)
    print(f"Saved OAuth credentials to {token_path}")


if __name__ == "__main__":
    main()
