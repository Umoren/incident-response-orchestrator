# Day 1 — Build the incident environment

## Incident contract

The healthy deployment quotes standard and priority orders. The bad deployment has a shipping-rule lookup defect for priority orders. Each traffic cycle sends three standard and two priority orders. When the broken version receives all requests, expect HTTP 500 for 2 of 5 requests (40%). This is a prediction, not an observed live metric.

`/health` reports that the Worker can answer a request. It does not check quote correctness; the broken deployment can return a healthy status while priority quotes fail.

The two files `apps/incident-api/wrangler.jsonc` and `apps/incident-api/wrangler.broken.jsonc` use the same Worker name. They select different pricing code paths and release labels. Each deploy creates a version of that Worker. Record the Cloudflare-assigned version ID as the authoritative deployment identifier; the release label is a readable clue inside our logs.

## Local evidence

`npm test` passed: healthy priority quotes total 65, broken priority quotes return HTTP 500, and broken standard quotes still succeed. The failed request logs `quote.failed` with `Cannot read properties of undefined (reading 'fee')`. Wrangler dry runs built both variants without deploying them.

## Live baseline in progress

Samuel deployed the healthy Worker as version `3e9e73ee-88fa-409e-9ea7-3632fb8a23f3`. At 2026-10-07 16:24 UTC, `/health` returned HTTP 200 with `healthy-01`, and a priority quote returned HTTP 200 with total 65. His first 15-request traffic attempt received zero HTTP responses: all requests failed at the client with `TypeError: fetch failed`. This is a transport failure, not evidence of HTTP 500 from the Worker. A subsequent five-request traffic cycle from the same WSL environment returned five HTTP 200 responses.

The full baseline rerun succeeded: all three cycles received five HTTP 200 responses each. Final counts were 15 successes, zero HTTP 5xx, zero other HTTP responses, and zero transport errors. No synthetic alert was emitted. The time of this rerun has not yet been recorded.

Samuel then deployed the broken version of the same Worker as `14ba0d70-d62f-4281-a3b6-bbcc4d357eef` with release label `broken-02`. After the investigation, he signed back into his personal Cloudflare account (a work account had been selected in between; no course deployment went to it) and restored the healthy version as `a4f9a86f-df57-4e5a-9bb5-a3a49773b3ed` with release label `healthy-01`. Post-restore traffic returned 15 HTTP 200 responses across three complete cycles, zero HTTP 5xx, zero transport errors, and no synthetic alert. The error rate returned to baseline when traffic moved back to the healthy version.

The first broken traffic cycle received only two HTTP responses: a priority HTTP 500 and a standard HTTP 200. Three other requests failed before an HTTP response with `TypeError: fetch failed` (`AggregateError`). This incomplete cycle is not a valid five-request sample.

Cycles two and three each received five responses: three standard HTTP 200 and two priority HTTP 500. The measured HTTP 5xx rate for each complete cycle was 40%, matching the prediction. The synthetic checker emitted `synthetic.alert` in cycle three after two complete high-error cycles. Across the whole run, the client received seven successes, five HTTP 5xx responses, and three transport errors. Do not report the incomplete run as 6 of 15 HTTP 500; five actual HTTP 500 responses were observed. Cloudflare log and deployment inspection is pending.

## Your WSL deployment sequence

You perform the account login and both live deploys. Run these commands in `career/incident-response-orchestrator/apps/incident-api/`:

1. Prepare Node and check the local build:

   ```sh
   source "$HOME/.nvm/nvm.sh"
   nvm use 22
   npm ci
   npm test
   ```

2. Sign in to your Cloudflare account and verify the selected account:

   ```sh
   npx wrangler login
   npx wrangler whoami
   ```

   Complete the browser flow yourself. Do not share authorization codes or API tokens. If prompted to set a `workers.dev` subdomain, enable it for the public demo endpoint.

3. Deploy the healthy version:

   ```sh
   npm run deploy:healthy
   npx wrangler versions list
   ```

   Copy the deployed `workers.dev` URL and version ID into the observations below. Run `curl "SERVICE_URL/health"` and `curl "SERVICE_URL/quote?type=priority&quantity=2"` with the real URL.

4. From the project root (`career/incident-response-orchestrator/`), send a short healthy baseline:

   ```sh
   node scripts/traffic.mjs SERVICE_URL 3 1000
   ```

   Expect 15 successful requests, no HTTP 500, and no `synthetic.alert`. Use the full URL shown by Wrangler in place of `SERVICE_URL`.

5. After you have recorded the baseline, return to `apps/incident-api/` and deploy the broken version:

   ```sh
   npm run deploy:broken
   npx wrangler versions list
   ```

   This deploy replaces the active version of the **same Worker**. Record the new version ID and deploy time. From the project root, run the same traffic command. Expect six HTTP 500 responses over three cycles and one `synthetic.alert` after cycle two. The alert is an observation from this client sample, not a Cloudflare Monitoring policy.

6. In the Cloudflare dashboard, open **Workers & Pages → incident-quote-api → Observability**. Find `quote.failed` logs and inspect the order type, release label, error, and request ID. Open **Deployments** to inspect the active and previous version IDs. Compare the deployment time with the first failing request.

   If the Worker name is already taken in your account, change the `name` field in **both** Wrangler configs to the same unique name before deploying either version.

## Observations to record after each run

- Cloudflare account and Worker name (no credentials): `incident-quote-api` (Samuel's account)
- Public Worker URL: `https://incident-quote-api.samuelumoren365.workers.dev`
- Healthy version ID and deploy time: `3e9e73ee-88fa-409e-9ea7-3632fb8a23f3`; deploy time not yet recorded
- Healthy traffic totals and time window: 15 HTTP 200, zero HTTP 5xx, zero transport errors across three complete cycles; exact rerun time not recorded
- Broken version ID and deploy time: `14ba0d70-d62f-4281-a3b6-bbcc4d357eef`; exact deploy time not recorded
- Broken traffic totals and time window: 7 HTTP 200, 5 HTTP 500, 3 client transport errors; cycles 2 and 3 each showed 2 of 5 HTTP 500 (40%); exact time not recorded
- First failed request ID, order type, and log time: app `requestId` `25f5a1b8-545c-44af-8d29-a5a70a25aa27`, `type=priority&quantity=2`, logged 2026-10-09 12:15:53 UTC (13:15:53 GMT+1), served by version `14ba0d70-d62f-4281-a3b6-bbcc4d357eef`
- Exact error shown in Workers Logs: `quote.failed` with `Cannot read properties of undefined (reading 'fee')`, `release: broken-02`; the paired invocation log records `response.status: 500` with `outcome: ok`
- Synthetic alert cycle and measured error rate: cycle 3, 40% in both complete cycles 2 and 3
- Differences between predicted and observed behavior: cycle 1 of the broken run was incomplete (3 client transport errors, only 2 HTTP responses received); dashboard Deployments screen shows active version `14ba0d70` at 100% traffic with `0 req/sec` and `0%` error rate at snapshot time — the platform `0%` counts uncaught Worker errors, not HTTP 500 responses the Worker returns itself, so it does not contradict the observed 40% application error rate

## Manual investigation questions

1. Which deployed version was active for the first HTTP 500?
2. How close was its deployment time to the first failure?
3. Are failures limited to priority orders?
4. Which application error appears with a failed request ID?
5. Does `/health` pass while a customer-facing route fails?
6. Which evidence is available in Workers Logs, and what would an agent need in a queryable store?

The Day 1 article goes in `docs/articles/` after you have live evidence. Record what happened; do not describe a predicted result as something observed in Cloudflare.
