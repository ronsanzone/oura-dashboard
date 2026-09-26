# Oura Observatory deployment

The production dashboard is `https://oura.ronsanzone.dev`. Cloudflare Access
protects the entire hostname with an exact-owner browser policy. The Worker
also validates the Access JWT audience, issuer, signature, and exact owner
email. This keeps the origin fail-closed if the edge Access rule is loosened
or detached accidentally.

`https://oura-hooks.ronsanzone.dev/oura-webhook` is the only public ingress.
It serves no dashboard assets or data APIs. GET challenges require the private
verification token and POST events require Oura's HMAC signature. Webhook
events are recorded in D1, and delete events remove records immediately;
create/update events are reconciled by the scheduled sync rather than starting
a full API sync.
The Worker also requires HTTPS, limits request bodies, rate-limits the public
route, and deduplicates signed events in D1.

## Resources

- Worker: `oura-observatory`
- D1: `oura-observatory`, binding `DB`, ID `d7761828-bc02-4f02-85ae-96d47eed6c15`
- Access app: `Oura Observatory`, ID `6aa32bad-d493-4e65-8ef5-2fbbc7c10628`
- Access policy: exact-owner allow, ID `01c24fcc-1bcb-48d5-ba1b-11881638ee62`
- Access session: 8 hours; binding cookie and HttpOnly enabled; SameSite=Lax
- Dashboard custom domain: `oura.ronsanzone.dev`
- Webhook custom domain: `oura-hooks.ronsanzone.dev`
- Cron reconciliation: once daily at minute 17 past 03:00 UTC
- Static UI: Worker `ASSETS` binding from `apps/dashboard-ui/dist`

Production has `workers_dev=false` and `preview_urls=false` so neither can
bypass Cloudflare Access.

## Pre-deploy

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm deploy:dry-run:production
pnpm --filter @oura/dashboard-worker exec wrangler whoami
```

## Routine updates

Inspect pending migrations and record the current version as a rollback target.
Apply approved migrations, then publish the UI and Worker together. Existing
Worker secrets are preserved; do not regenerate or upload secrets for a routine
code release, and never import synthetic preview data into production.

```sh
pnpm --filter @oura/dashboard-worker exec wrangler deployments list --env production
pnpm --filter @oura/dashboard-worker exec wrangler d1 migrations list DB --env production --remote
pnpm --filter @oura/dashboard-worker exec wrangler d1 migrations apply DB --env production --remote
pnpm --filter @oura/dashboard-worker exec wrangler deploy --env production --strict --message "<reason>"
```

## Initial provisioning only

These import and secret-preparation steps are not part of a routine update.
Import only explicitly approved production records, never the local demo:

```sh
# Apply all migrations, including the sync lock used by the Worker.
pnpm --filter @oura/dashboard-worker exec wrangler d1 migrations apply DB --env production --remote
node scripts/export-d1-import.mjs
pnpm --filter @oura/dashboard-worker exec wrangler d1 execute DB --env production --remote --file=.wrangler/oura-records.import.sql
```

Prepare a mode-0600 temporary secret payload. Do not print or commit its
contents. Upload it alongside the Worker so the code and encrypted bindings
are published as one version:

```sh
node scripts/prepare-cloudflare-secrets.mjs
pnpm --filter @oura/dashboard-worker exec wrangler deploy --env production --strict \
  --secrets-file ../../.wrangler/production-secrets.json --message "<reason>"
```

The preparation script preserves an existing token-encryption key and webhook
verification token in `.wrangler/production-secrets.json`. Deleting that file
creates new values; do not delete it during a routine deploy. Rotating the
encryption key requires a planned token reauthorization or data re-encryption.

Deploy only after the Access application protects the dashboard hostname.

## Latest release

- Released 2026-09-26 from [1731d35](https://github.com/ronsanzone/oura-dashboard/commit/1731d35): Observatory overhaul and manual Experiment Lab.
- Production version: `13a0d90c-ac62-4dec-a2bf-41faf7c8a352` (100% traffic).
- Deployment ID: `3a65334b-742f-44a2-9556-41da79d468ca`.
- Previous known-good version: `c5a7cc75-2e5f-4066-b74e-c7ecdafb62d9`.
- Migration `0003_experiments.sql` applied; no pending migrations remain.
- Existing Oura secrets retained; no record imports or Access policy changes.
- Anonymous dashboard, status and experiment requests redirect to Access;
  webhook-host experiment requests return 404; webhook health returns 200.
  HTTP redirects to HTTPS; workers.dev and preview URLs remain disabled.
- Authenticated owner UI/data verification remains to be performed through
  the owner's Access session. No production health records were read for this release.

## Verification

- An anonymous dashboard request redirects to Access or returns `401/403`.
- An authenticated owner can load the UI and `/api/status`.
- A direct dashboard request without a valid Access JWT returns `403` from the
  Worker even if it reaches the origin.
- The webhook host returns `404` outside `/_health` and `/oura-webhook`.
- Plain HTTP redirects to HTTPS and HTTPS responses include HSTS.
- The guessed `oura-observatory.<account>.workers.dev` and preview hostnames
  return `404` or do not resolve.
- Record the deployed version and deployment IDs.

## Rollback

For later deployments, use `wrangler rollback <known-good-version-id>`. If the
first deployment activates but the perimeter is incorrect, detach only the two
custom domains. Preserve the Worker and D1 database for diagnosis; never delete
the database as rollback.
