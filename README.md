# Oura Lab

A private, local-first dashboard for exploring Oura Ring data beyond the standard app. It includes a realistic demo dataset, OAuth 2 connection, incremental API syncing, SQLite storage, interactive trends, sleep composition, correlations, heart-rate timelines, and CSV export.

The repository also contains the production Cloudflare implementation under
`apps/`: a React/Vite observability console, Worker API, D1 storage, encrypted
OAuth tokens, scheduled reconciliation, and signature-verified webhook ingress.
See `DEPLOYMENT.md` for the protected-domain deployment contract.

Oura's API provides processed measurements and time series. It does **not** provide raw PPG/LED readings or full accelerometer samples.

## 1. Run the demo dashboard

Requires Python 3.9 or newer.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
streamlit run app.py
```

The first launch automatically creates 120 days of deterministic demo data in `data/oura.db`. The database and credentials are excluded from git.

## 2. Connect your Oura account

Oura removed personal access tokens in December 2025, so a personal project must use OAuth 2.

1. Sign in at [Oura Cloud](https://cloud.ouraring.com/).
2. Register an API application. Use `http://localhost:8765/callback` as its redirect URI. If Oura asks for a website, a personal project/repository URL is sufficient.
3. Copy `.env.example` to `.env` and enter the client ID and client secret.
4. Authorize this local app:

```bash
cp .env.example .env
# Edit .env, then:
source .venv/bin/activate
python scripts/authorize.py
```

The browser consent flow writes tokens to `data/token.json` with owner-only file permissions. Never commit or share `.env` or `data/token.json`.

## 3. Sync and view real data

```bash
source .venv/bin/activate
python scripts/sync.py --days 365
streamlit run app.py
```

Syncing is idempotent: existing records are updated rather than duplicated. Individual endpoints that are unavailable to your account or OAuth scopes are reported and skipped without stopping the rest of the sync.

Oura data appears in the API only after the ring has synced through the mobile app. Open the Oura app first when recent sleep data is missing.

## Test

```bash
source .venv/bin/activate
python -m unittest discover -s tests -v
```

## Local files

- `app.py` — interactive dashboard
- `oura_dashboard/api.py` — OAuth token refresh and Oura API collections
- `oura_dashboard/db.py` — SQLite storage
- `oura_dashboard/demo.py` — reproducible demo records
- `scripts/authorize.py` — localhost OAuth helper
- `scripts/sync.py` — command-line sync
