# Oura Observatory deployment

The production dashboard is `https://oura.ronsanzone.dev`. Cloudflare Access
protects the entire hostname with an exact-owner browser policy. The Worker
does not implement a second JWT layer; Access is the human authentication
boundary.

`https://oura-hooks.ronsanzone.dev/oura-webhook` is the only public ingress.
It serves no dashboard assets or data APIs. GET challenges require the private
verification token and POST events require Oura's HMAC signature.

## Resources

- Worker: `oura-observatory`
- D1: `oura-observatory`, binding `DB`, ID `d7761828-bc02-4f02-85ae-96d47eed6c15`
- Access app: `Oura Observatory`, ID `6aa32bad-d493-4e65-8ef5-2fbbc7c10628`
- Access policy: exact-owner allow, ID `01c24fcc-1bcb-48d5-ba1b-11881638ee62`
- Dashboard custom domain: `oura.ronsanzone.dev`
- Webhook custom domain: `oura-hooks.ronsanzone.dev`
- Cron reconciliation: every six hours at minute 17
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

Apply migrations and import the existing local records:

```sh
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

Deploy only after the Access application protects the dashboard hostname.

Current production version: `71b692e1-4de9-4b58-93d8-a5c2fbd3e09f`.

## Verification

- An anonymous dashboard request redirects to Access or returns `401/403`.
- An authenticated owner can load the UI and `/api/status`.
- The webhook host returns `404` outside `/_health` and `/oura-webhook`.
- The guessed `oura-observatory.<account>.workers.dev` and preview hostnames
  return `404` or do not resolve.
- Record the deployed version and deployment IDs.

## Rollback

For later deployments, use `wrangler rollback <known-good-version-id>`. If the
first deployment activates but the perimeter is incorrect, detach only the two
custom domains. Preserve the Worker and D1 database for diagnosis; never delete
the database as rollback.
