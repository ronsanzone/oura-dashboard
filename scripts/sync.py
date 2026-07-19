#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from oura_dashboard.api import sync_all


parser = argparse.ArgumentParser(description="Sync Oura API data into the local database")
parser.add_argument("--days", type=int, default=90, help="Number of days to fetch")
args = parser.parse_args()
print(json.dumps(sync_all(date.today() - timedelta(days=args.days), date.today()), indent=2))

