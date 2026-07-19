from __future__ import annotations

import json
import os
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import requests

from .db import connect, initialize, upsert_records


API_ROOT = "https://api.ouraring.com/v2/usercollection"
TOKEN_URL = "https://api.ouraring.com/oauth/token"
DEFAULT_TOKEN_PATH = Path(os.getenv("OURA_TOKEN_PATH", "data/token.json"))

# Endpoints are intentionally independent: unavailable scopes or newly introduced
# data types do not prevent the rest of a personal sync from completing.
ENDPOINTS = {
    "daily_activity": "daily_activity",
    "daily_sleep": "daily_sleep",
    "daily_readiness": "daily_readiness",
    "sleep": "sleep",
    "heart_rate": "heartrate",
    "workout": "workout",
    "session": "session",
    "tag": "enhanced_tag",
    "daily_spo2": "daily_spo2",
    "daily_stress": "daily_stress",
    "daily_resilience": "daily_resilience",
    "cardiovascular_age": "daily_cardiovascular_age",
    "vo2_max": "vO2_max",
}


class OuraClient:
    def __init__(self, token_path: str | Path = DEFAULT_TOKEN_PATH) -> None:
        self.token_path = Path(token_path)
        if not self.token_path.exists():
            raise FileNotFoundError(
                f"No OAuth token at {self.token_path}. Run: python scripts/authorize.py"
            )
        self.tokens = json.loads(self.token_path.read_text())
        self.session = requests.Session()

    def _save_tokens(self) -> None:
        self.token_path.parent.mkdir(parents=True, exist_ok=True)
        self.token_path.write_text(json.dumps(self.tokens, indent=2))
        self.token_path.chmod(0o600)

    def _refresh(self) -> None:
        response = requests.post(
            TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "refresh_token": self.tokens["refresh_token"],
                "client_id": os.environ["OURA_CLIENT_ID"],
                "client_secret": os.environ["OURA_CLIENT_SECRET"],
            },
            timeout=30,
        )
        response.raise_for_status()
        refreshed = response.json()
        if "refresh_token" not in refreshed:
            refreshed["refresh_token"] = self.tokens["refresh_token"]
        self.tokens = refreshed
        self._save_tokens()

    def _get(self, url: str, params: dict[str, str]) -> requests.Response:
        response = self.session.get(
            url,
            params=params,
            headers={"Authorization": f"Bearer {self.tokens['access_token']}"},
            timeout=30,
        )
        if response.status_code == 401 and self.tokens.get("refresh_token"):
            self._refresh()
            response = self.session.get(
                url,
                params=params,
                headers={"Authorization": f"Bearer {self.tokens['access_token']}"},
                timeout=30,
            )
        response.raise_for_status()
        return response

    def collection(self, endpoint: str, start: date, end: date) -> list[dict[str, Any]]:
        url = f"{API_ROOT}/{endpoint}"
        params = {"start_date": start.isoformat(), "end_date": end.isoformat()}
        items: list[dict[str, Any]] = []
        while url:
            payload = self._get(url, params).json()
            items.extend(payload.get("data", []))
            token = payload.get("next_token")
            url = f"{API_ROOT}/{endpoint}" if token else ""
            params = {"next_token": token} if token else {}
        return items


def sync_all(start: date | None = None, end: date | None = None) -> dict[str, Any]:
    end = end or date.today()
    start = start or end - timedelta(days=90)
    client = OuraClient()
    connection = connect()
    initialize(connection)
    result: dict[str, Any] = {"synced": {}, "skipped": {}}
    for data_type, endpoint in ENDPOINTS.items():
        try:
            items = client.collection(endpoint, start, end)
            result["synced"][data_type] = upsert_records(connection, data_type, items)
        except requests.HTTPError as exc:
            result["skipped"][data_type] = f"HTTP {exc.response.status_code}"
    return result

