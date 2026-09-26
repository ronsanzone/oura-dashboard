# Jev × Oura Observatory — field notes

Standalone research/design deliverable, not an application integration. Open `index.html` or serve this directory with a static HTTP server. No build step, runtime dependency, API keys, telemetry, remote fonts, or inference calls. The two UI interactions only change the current DOM and reset on reload.

## Contents

- Three proposed capabilities and interactive synthetic examples.
- Daily Debrief: a bounded, outcome-blind interview storyboard, question-selection contract, and capture provenance feeding Smart Context and manual experiments.
- Updated vocabulary: no alcohol classification; opt-in Adderall and Zepbound reported-use context, without inferred schedules or medication adherence.
- Source-payload and proposed application models, typed Jev question/response examples.
- Outcome-blind classification, independent statistics, provenance/corrections, validation and privacy boundaries.
- A linked source ledger checked 2026-09-26.

All examples are synthetic and hand-authored. Numerical toy comparisons are arithmetic illustrations, not measured model or health results. The evidence-card baseline values are explicitly separate from its six-row toy history. No production data accessed or health text transmitted. No paid inference was performed. Price, limits and provider terms require rechecking before a future pilot.

## Preview

From the repository root, use the orb-managed service (do not run an unsupervised background server):

```sh
amp orb service start jev-report --command 'python3 -m http.server 4174 --bind 0.0.0.0 --directory /home/user/workspace/repo/research/jev' --port 4174 --portal
```

Only the report directory is served; the repository and its credential/configuration files are not exposed. A persistent `.amp/services.yaml` entry can be added later if Ron wants this review service available in future orbs. No production deployment is needed.

## Subsequent live-first integration work

**Deployment update:** Ron approved production rollout on 2026-09-26. Version `a915b8fd-58b3-460e-af91-4af6c7aa850f` is live at https://oura.ronsanzone.dev with Jev enabled and migration `0004_context.sql` applied. Access/perimeter checks passed; authenticated owner acceptance remains pending. The verification notes below describe the pre-deployment checks. See `DEPLOYMENT.md` for release and rollback details. Source/proposal retention remains as disclosed; the debug log is session-memory only.

Ron subsequently approved connecting real Cloudflare Jev before building the experience. The report above remains a design artifact; its examples are not live results.

The local application now has a Daily Debrief tab and opt-in Experiment Concierge. `POST /api/jev/classify` accepts `{ "note": "…", "consent": true }`, optional `responses` (at most two curated question IDs, 500 characters each), `medications` (whether medication follow-ups may be offered), and `experiment: { id, version }` for adherence assistance. It classifies 12 context topics, including reported Adderall/Zepbound use, into `present`, `absent`, `unknown`, or `conflicting`. The classifier never fetches Oura outcomes. For experiments, only the declared habit and adherence rules from the requested current revision are added. User-written notes/rules can still contain outcomes; the prompt forbids using them, but cannot guarantee outcome blindness. The UI asks users to leave measured outcomes out.

Daily Debrief uses classifier outputs to select up to two fixed questions, prioritizing conflicts, then low confidence (<0.7, a pilot heuristic), then unknowns. It does not let the model generate questions or search outcomes. Skipped answers remain unknown. Medication follow-up prompts are opt-in; voluntarily mentioned medication use can still be classified. A user explicitly reclassifies after answering and can correct every proposed label before accepting. Oura tag comments can be copied into the draft; copying does not send them.

Migration `0004_context.sql` stores immutable model proposals (including source note/answers) separately from accepted daily revisions. `GET /api/context/:day` and `/revisions` read accepted records; `PUT /api/context/:day` requires expected `version`, server-issued `proposalId`, all 12 `labels`, and `reason`. An atomic insert rejects stale writes with 409. Source hash now covers JSON of `{note,responses}` under rubric `context-2`; original proposals survive human corrections. Raw notes are not logged but **are retained in the private database**, including unaccepted proposals; no automatic retention/deletion job exists yet. Review this retention policy before production activation.

Manual Lab can attach a specific accepted daily revision without changing adherence, notes, or exclusions. Its optional Jev adherence suggestion uses existing rules; Unknown prompts one rule-specific clarification. Only an explicit “Use suggestion” followed by “Save check-in” commits it. The server reconstructs context labels and classifier receipts from immutable records, storing proposed versus accepted adherence and plan version in ordinary experiment revisions. Snapshots freeze that provenance alongside existing evidence. Later context edits never rewrite saved snapshots.

Explore now includes a deterministic Signal Detective pilot. It screens daily high-stress time against the prior 28 days (at least 14 measured; threshold mean + max(0.5 hours, one sample SD)). The user chooses a context and same/next-day pairing before requesting a comparison; there is no automated topic ranking or lag search. Only latest human-accepted revisions enter the comparison, fetched through bounded `GET /api/context?start=&end=`. Present versus explicitly absent means, unknown/conflicting/missing counts, weekday/weekend/sleep/travel strata, and every paired day are visible. A circular seven-calendar-day block bootstrap uses 1,000 resamples and fixed seed 20260926; intervals require at least 28 calendar days, seven measured pairs per group, and 900 valid resamples. These are declared exploratory heuristics, not clinical thresholds or causal estimates. Selective logging, retrospective capture, partial-period labels and nonstationarity remain limitations. No inference calls run in this view.

Production Access authentication, same-origin checks, a default-off `JEV_ENABLED` switch, 4,000-character/8,192-byte limits and a six-request-per-minute Workers rate limiter bound the endpoint. The limiter is not a global billing cap. There are no automatic retries or raw provider-error logs. Returned provenance includes requested/returned model, rubric version, base64 SHA-256 source hash, timestamp, usage and estimated input cost at $0.042/M input tokens. Classifier confidence is not evidence of a health effect. Responses require human review; no automatic exclusions or medication advice are produced.

Apply the migration **locally only**, then build and run the live-provider preview:

```sh
pnpm --filter @oura/dashboard-worker exec wrangler d1 migrations apply oura-observatory-local --local
pnpm build
amp orb service start jev-api --command 'pnpm --filter @oura/dashboard-worker exec wrangler dev --ip 127.0.0.1 --port 8788 --var JEV_ENABLED:true' --port 8788
```

This is intentionally loopback-only: local mode bypasses production Access. Do not expose it through a public portal. The AI binding is remote and can incur inference charges; the database is local. Do not bulk-submit stored notes. API responses are not cached, and successful schema checks do not establish classifier accuracy.

**Verification status, 2026-09-26: live end-to-end check passed.** After Ron updated Workers AI permissions and funded the gateway, `POST /api/jev/classify` returned HTTP 200 using real `jev-1.13.0`. The non-health software-connectivity note returned all 12 topics as `unknown`, as expected. Usage: 2,474 input / 565 output tokens; estimated input cost $0.000103908 for that request. This proves connectivity and response handling, not accuracy on health notes. No health data was sent, and no production deployment or migration was performed. Typecheck, application/Worker build and all 35 unit tests pass; unit provider responses remain explicitly mocked.

Browser checks exercised real classification, the two-question interview, manual corrections, persistence/reload, and the experiment suggestion/save/snapshot flow using non-health software-verification text. Signal Detective was checked with unavailable measurements and an explicitly marked, browser-only numerical fixture (not sent to Jev or stored). Desktop 1440px and narrow 390px screenshots were inspected; neither viewport had horizontal overflow. Tests cover latest-revision range reads, stale writes, source mismatches, outcome-field omission, snapshot immutability, prior-only baselines, lag alignment, true zeros, unknown controls, and sparse-interval withholding. These checks do not replace a human-labelled chronological accuracy evaluation before trusting classifications.

The live check revealed Cloudflare's binding returns a `{ state: "Completed", result: { model, answers, usage } }` envelope. The handler now validates completion before unwrapping and validating the model result; tests cover incomplete and malformed envelopes. Earlier blockers were HTTP 401 authentication followed by HTTP 402 insufficient gateway balance. Cloudflare's [REST setup guide](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) specifies Workers AI Read and Edit for a custom token. Neither credentials nor funding are checked into the repository.

## Session debug panel

A collapsed-by-default **Jev debug** section sits above the footer on every tab. It retains the last ten classification calls in browser memory, with pending/completed status, browser round-trip duration, submitted JSON, and the application response. Successful responses include `debug.model` and `debug.input`: the exact question/state payload sent through the Workers AI binding. The validated proposal contains model/rubric, probabilities, confidence, usage and estimated input cost. This is not raw upstream HTTP traffic; provider exceptions remain sanitized. Debug metadata is returned only, not added to stored proposal records.

Opening the panel makes no requests. Headers/credentials are not captured. Notes remain sensitive and are visible when expanded; Clear or reload removes the in-memory log, not database records. Browser verification confirmed default collapse, a real HTTP 200 on non-health verification text, a deliberately blocked network request, Clear, and readable desktop/narrow layouts. Unit tests check exact binding payload disclosure and non-persistence of debug metadata.
