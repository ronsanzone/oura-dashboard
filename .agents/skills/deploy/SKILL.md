# Deploy Oura Observatory

Use this skill when the user explicitly asks to deploy the Cloudflare Worker,
apply production D1 migrations, or verify a production deployment.

## Safety rules

- Deploy only after explicit user approval in the current conversation.
- Run commands from the repository root unless a command says otherwise.
- Never print, paste, commit, or share `.env` or
  `.wrangler/production-secrets.json`.
- Never run `wrangler d1 create DB`; the production database already exists.
- Apply D1 migrations before deploying Worker code that depends on them.
- Do not undo an applied D1 migration during a Worker rollback.
- Stop if the worktree contains unrelated changes or if validation fails.

## Project deployment contract

- Production Wrangler config: `apps/dashboard-worker/wrangler.jsonc`
- Production Worker environment: `production`
- Production D1 binding: `DB`
- Production D1 database: `oura-observatory`
- Dashboard: `https://oura.ronsanzone.dev`
- Webhook health endpoint: `https://oura-hooks.ronsanzone.dev/_health`
- Stable secret payload: `.wrangler/production-secrets.json`

## Procedure

### 1. Inspect state and authentication

```sh
git status --short --branch
npx wrangler whoami
```

Confirm the current branch and remote before deploying. Do not proceed if
unrelated uncommitted changes are present.

### 2. Install and validate dependencies

The repository pins pnpm in `package.json`. Prefer the installed `pnpm`; when
it is unavailable, use the pinned version through `npx`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm deploy:dry-run:production
```

Fallback:

```sh
npx --yes pnpm@10.12.1 install --frozen-lockfile
npx --yes pnpm@10.12.1 typecheck
npx --yes pnpm@10.12.1 test
npx --yes pnpm@10.12.1 build
npx --yes pnpm@10.12.1 deploy:dry-run:production
```

Do not apply migrations or deploy if any validation command fails.

### 3. Apply pending D1 migrations

Run this before deploying code that references a new table or column:

```sh
npx --yes pnpm@10.12.1 --filter @oura/dashboard-worker exec \
  wrangler d1 migrations apply DB --env production --remote
```

Verify important migrations explicitly. For the sync lock:

```sh
npx --yes pnpm@10.12.1 --filter @oura/dashboard-worker exec \
  wrangler d1 execute DB --env production --remote \
  --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_locks'"
```

Expected result: `sync_locks`.

### 4. Prepare stable production secrets

The script reads the local `.env` and writes a mode-0600 payload. It preserves
the existing encryption and webhook secrets:

```sh
node scripts/prepare-cloudflare-secrets.mjs
```

Confirm only that the file exists and has restrictive permissions. Never print
its contents.

### 5. Deploy

```sh
npx --yes pnpm@10.12.1 --filter @oura/dashboard-worker exec \
  wrangler deploy --env production --strict \
  --secrets-file .wrangler/production-secrets.json \
  --message "<short reason>"
```

Record the returned Worker version ID and deployed cron schedule.

### 6. Verify production

Check the public webhook health endpoint:

```sh
curl -sS -i --max-time 20 https://oura-hooks.ronsanzone.dev/_health
```

Expected response: HTTP 200 with `"mode":"production"`.

Open the dashboard through Cloudflare Access and verify the dashboard and
`/api/status` load. Do not bypass Access by exposing a preview or workers.dev
hostname.

Inspect recent sync accounting without selecting payloads:

```sh
npx --yes pnpm@10.12.1 --filter @oura/dashboard-worker exec \
  wrangler d1 execute DB --env production --remote \
  --command "SELECT id, started_at, finished_at, status,
    json_extract(details, '\$.trigger') AS trigger,
    json_extract(details, '\$.fetched.heart_rate') AS heart_rate_rows
    FROM sync_log ORDER BY id DESC LIMIT 20"
```

Expected behavior is one scheduled sync per day plus intentional manual syncs.
Webhook create/update bursts must not create one `sync_log` row per event.

### 7. Report

Report:

- Validation commands and results
- Migration names applied
- Worker version ID
- Cron schedule
- Health and Access verification results
- Any follow-up observation needed after the next scheduled sync

## Rollback

Use the known-good Worker version ID:

```sh
npx wrangler rollback <known-good-version-id> \
  --config apps/dashboard-worker/wrangler.jsonc \
  --env production
```

Do not revert or delete the D1 migration. The `sync_locks` table is harmless
to older Worker versions.
