# Oura Lab

A private, local-first dashboard for exploring Oura Ring data beyond the standard app. It includes a realistic demo dataset, OAuth 2 connection, incremental API syncing, SQLite storage, interactive trends, sleep composition, correlations, heart-rate timelines, and CSV export.

The repository also contains the production Cloudflare implementation under
`apps/`: a React/Vite observability console, Worker API, D1 storage, encrypted
OAuth tokens, scheduled reconciliation, and signature-verified webhook ingress.
See `DEPLOYMENT.md` for the protected-domain deployment contract.

## Observatory web experience

The React site uses Ron's [Waffle Cat palette](https://github.com/ronsanzone/dotfiles/blob/main/theme-picker/themes/omarchy-waffle-cat.json): cream, plum-brown, and ember orange. Today provides a dated morning brief, three overnight measurements, and a linked sleep/heart-rate/MET/context timeline. Sleep, Cardio, Activity, Explore, and Data retain deeper investigation without mixing incompatible units on a shared axis.

- Account days and chart clocks use `America/New_York`, including daylight-saving boundaries. Oura's explicit daily `day` is preserved; timestamp-only records are filtered by Eastern midnight instants. Enhanced tags normalize `start_day` and `start_time`.
- The brief never substitutes an older measurement for the selected date. Baselines exclude that date and use the preceding 28 calendar days, requiring at least seven observed values. Gaps are not zero and chart lines do not bridge missing days.
- Main sleep means the longest episode for a day. The sleep selector also exposes naps/additional episodes and total daily sleep. Intraday samples appear only when present in source payloads; daily stress remains a daily total.
- Connection, date, range, and sync/coverage controls remain available on narrow screens. API responses remain `no-store`; no service worker or persistent browser health-data cache is introduced.
- Data distinguishes sync attempts from last changed/imported records and shows collection-level errors. A 403 is reported as access denied, not diagnosed as a missing permission: an expired Oura subscription can produce the same response.
- Explore is a conservative same-day association tool (at least 14 paired days, no composite-score/component pairs). It does not supply causal claims or infer adherence from unlogged context. Experiments is a separate persistent manual notebook; automated uncertainty analysis and Jev integration remain future features.

`GET /api/records?start=YYYY-MM-DD&end=YYYY-MM-DD&offset=0` now returns `{ records, nextOffset }`, in pages of at most 2,000 records. Continue until `nextOffset` is null. The UI loads all pages before presenting charts and cancels obsolete date/range requests. There is no silent 25,000-record response cap. Deploy the UI and Worker together because the response contract changed. Pagination is not a database snapshot; do not run bulk imports concurrently with a history read.

Local web checks: `pnpm typecheck`, `pnpm test`, `pnpm build`, then `pnpm dev`. Tests include SQLite execution of the record filters and pagination beyond 25,000 rows, DST boundaries, sparse baselines, heart-rate API pagination/chunking and token rotation, and production Access rejection. The SQLite tests require Node 22.13+ (Node 24+ recommended).

For a synthetic-only local D1 preview, use the existing Python demo and importer; never use production tokens or records for screenshots:

```bash
.venv/bin/python -c "from oura_dashboard.db import connect,initialize; from oura_dashboard.demo import seed_demo; c=connect('/tmp/oura-demo.db'); initialize(c); seed_demo(c); c.close()"
node scripts/export-d1-import.mjs /tmp/oura-demo.db /tmp/oura-demo.sql
pnpm --filter @oura/dashboard-worker exec wrangler d1 migrations apply DB --local
pnpm --filter @oura/dashboard-worker exec wrangler d1 execute DB --local --file=/tmp/oura-demo.sql
```

The Python demo intentionally has no sleep-stage or MET samples. Empty timeline lanes are expected, not replaced with illustrative traces. Production Access configuration is unchanged.

### Personal Experiment Lab

Experiments persist in D1 behind the same single-owner Access boundary as the dashboard. Apply `migrations/0003_experiments.sql` before shipping the updated Worker/UI; only local migration is part of development verification. Production migration/deployment requires separate authorization.

- Define a question/habit, one primary outcome and up to four supporting daily measures, explicit adherence rules, and draft/active/paused/finished lifecycle. Before/During/optional After windows are non-overlapping and span at most 366 calendar days. Each exposure day pairs with the same or following Eastern calendar day's outcome, including across DST. Oura sleep uses the reported day (usually the wake day).
- Check-ins record followed/partly/not followed/unknown, notes, and optional explicit exclusion reasons. Unanswered is unknown. Pausing does not silently remove dates. No automatic outlier, travel, or context exclusions; excluded measurements remain in plots and the ledger. Daily stress is hours per day, not an intraday trace.
- Before/During/After comparisons show arithmetic means, differences in native units (percentage points for percentages), measured/missing/excluded/pending counts, and daily plots with shared vertical scales. Adherence comparisons keep partial and unknown cohorts separate. Other signals are exploratory and never ranked to cherry-pick a winner. No causal, significance, or uncertainty claim is computed.
- Every save appends a complete plan/check-in/reflection revision. Updates require the expected version and return HTTP 409 on conflicts rather than overwriting another tab. Revision history remains visible, including outcome/rule/window changes after logging began.
- Evidence snapshots are generated by the Worker and freeze the plan revision, check-ins, all supported daily values, contextual notes/tags, exclusions, read time and source-update timestamp. Subsequent edits/imports do not alter them. A snapshot is an immutable record of a read, not a transactionally isolated database snapshot during concurrent imports. Avoid imports during a review. No browser persistent health-data cache is used.
- `GET/POST /api/experiments` lists/creates notebooks; `GET/PUT /api/experiments/:id` reads/appends revisions; `GET .../evidence` reads current evidence; `GET .../revisions` reads history; `GET/POST .../snapshots` reads/creates snapshots. Mutations require same-origin JSON, all routes require Access in production, and responses are `no-store`.
- No Jev calls or automatic adherence inference. A later human-approved context proposal could create a normal check-in revision; classifier/rubric/source provenance would need a validated schema extension first.

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
