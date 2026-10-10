# Day 2 — Evidence store, then one incident agent

## Part A — Queryable evidence (groundwork)

Workers Logs served Day 1 manual inspection. Agents need a stable table with a fixed shape. D1 holds two tables defined in `infra/d1/schema.sql`:

- `deployments`: one row per Worker deployment (version ID, release label, variant, deploy time, traffic share). Recorded by hand after each deploy.
- `quote_events`: one row per attempted quote request (time, server request ID, order type, HTTP status, release label, error or transport failure).

`scripts/traffic.mjs` accepts an optional fifth argument, a path for a SQL record file. It parses each HTTP response body for the server's `requestId` and `release`, so a recorded row links the client's observation to the server's log entry. Transport failures are recorded with a NULL status, never silently dropped.

### Your WSL steps (run in `apps/incident-api/`)

1. Create the database:

   ```sh
   npx wrangler d1 create incident-evidence
   ```

   Copy the `database_id` into the observations below.

2. Apply the schema:

   ```sh
   npx wrangler d1 execute incident-evidence --remote --file=../../infra/d1/schema.sql
   ```

3. Read the exact deploy times from the dashboard (**Workers & Pages → incident-quote-api → Deployments**, hover each entry), then record all three Day 1 deployments:

   ```sh
   npx wrangler d1 execute incident-evidence --remote --command="INSERT INTO deployments (version_id, release_label, variant, deployed_at, traffic_percent) VALUES ('3e9e73ee-88fa-409e-9ea7-3632fb8a23f3', 'healthy-01', 'healthy', '<HEALTHY_DEPLOY_TIME>', 0), ('14ba0d70-d62f-4281-a3b6-bbcc4d357eef', 'broken-02', 'broken', '<BROKEN_DEPLOY_TIME>', 0), ('a4f9a86f-df57-4e5a-9bb5-a3a49773b3ed', 'healthy-01', 'healthy', '<RESTORE_DEPLOY_TIME>', 100)"
   ```

   Times must come from the dashboard, not from memory. Use ISO format (`2026-10-09T12:15:53Z`).

4. Record a fresh healthy traffic sample from the project root:

   ```sh
   node scripts/traffic.mjs https://incident-quote-api.samuelumoren365.workers.dev 3 1000 /tmp/quote-events.sql
   npx wrangler d1 execute incident-evidence --remote --file=/tmp/quote-events.sql
   ```

   The second command runs from `apps/incident-api/`. Verify with:

   ```sh
   npx wrangler d1 execute incident-evidence --remote --command="SELECT release_label, http_status, COUNT(*) FROM quote_events GROUP BY release_label, http_status"
   ```

## Observations

- D1 database name and ID: `incident-evidence`, `f44ad014-a8d8-4d7e-8fc2-03f62136f77a` (region WEUR, created 2026-10-09 on Samuel's personal account); binding `incident_evidence` added to both Worker configs for Day 2 tools
- Schema applied 2026-10-09: 4 queries executed (deployments, quote_events, 2 indexes), database size 0.04 MB.
- Deployments rows recorded: all three Day 1 versions with dashboard-sourced timestamps (healthy `3e9e73ee` 2026-10-07T16:21:12.316Z, broken `14ba0d70` 2026-10-07T16:37:03.397Z, healthy restore `a4f9a86f` 2026-10-09T12:47:48.980Z), each at 100% traffic during its window.
- Traffic sample recorded (cycles, counts, time window): 3 cycles against the restored healthy Worker, 15 HTTP 200, zero failures; SQL file applied as 15 queries.
- Verification query result: `healthy-01 | 200 | 15` — matches the traffic run exactly. Part A complete.

## Part B — One incident agent (in progress)

`apps/orchestrator/` holds a second Worker with the AI and D1 bindings. `runAgent()` (injected inference), read-only tools (`queryQuoteEvents`, `getErrorRate`, `listDeployments`), and a `POST /investigate` endpoint are built. Six loop tests pass: direct answer, tool success, tool failure as observation, unknown tool as observation, step limit, and repeated-call stop. Live model test pending (deploy + POST against the real tables).

First live POST returned 1101 (Worker threw). Tail showed `TypeError: Cannot set properties of undefined (setting '#options')` inside the AI binding: `workersAiInfer` had detached `env.AI.run` into a standalone function, losing its `this`. Fixed by casting the input shape instead and keeping the call attached as `ai.run(...)`. Also wrapped the investigate handler so future exceptions return structured JSON instead of an HTML error page. Lesson: bindings are objects with internal state — call their methods attached, the same rule as never destructuring `ctx`.

Second failure: the configured model `@hf/nousresearch/hermes-2-pro-mistral-7b` was deprecated on 2026-05-30 (Workers AI returned error 5028, now surfaced as structured JSON thanks to the handler fix). Switched `MODEL` to `@cf/ibm-granite/granite-4.0-h-micro`, whose catalog page confirms function calling support, Cloudflare hosting, and low unit pricing. Lesson: model names are dependencies that rot — the catalog, not old docs, is the source of truth, and keeping the name in config made the switch a one-line change.

Third failure: `8001: Invalid input` on calls with tools. A temporary `/probe` endpoint bisected the input — plain messages worked, tools attached did not. Two defects in the translation layer: tools were sent Hermes-style (`{name, description, parameters}`) while granite speaks OpenAI-style (`{type: 'function', function: {...}}`), and the reply parser read Hermes-style top-level fields while granite returns `choices[0].message`. Fix isolated in a new tested module, `src/provider.ts` (`toAiTools` + `parseAiReply`, 5 tests). Lesson: the loop speaks `InferResult`; each model speaks its own dialect; keep a tested translator between them. `/probe` stays until Day 7, then it goes.

Fourth failure, live: the model sent `getErrorRate` arguments as a JSON string (possibly double-encoded), the tool threw "expects an object," the model repeated the identical call, and the loop correctly stopped with `repeated_tool_call` at step 2 — no quota burned, transcript preserved. Fix in the provider layer, not the tools: `normalizeArgs` decodes string arguments repeatedly until they stop being strings. Tools stay strict (objects only); the provider tolerates transport encoding. Lesson: strictness belongs at the domain boundary, forgiveness at the transport boundary.

First live `answered` report (orchestrator version `5cdf3f54`): 4 steps — `getErrorRate`, `queryQuoteEvents`, `listDeployments`, then a summary. Arguments arrived as proper objects, all three tools returned `ok: true`. But the store held only the 15 healthy rows recorded in Part A, so the agent correctly reported 0% errors: the Day 1 broken traffic predates the recorder and was never stored. Lesson: the agent reasons over the store, not over history — missing rows are invisible, not suspicious. A broken-window sample must be recorded before the live test means anything.

Second live report (orchestrator `5cdf3f54`): `answered` in 4 steps over a store now holding 30 rows (15 healthy + 15 broken re-run, 6 HTTP 5xx, 20% window rate). Tool sequence was sound — rate, then events, then deployments. But the model queried events filtered to `orderType: standard` only, never looked at a failing row, and still wrote that "all recorded failures are standard" — false; the bug fails priority orders. Lesson: a correct loop with real tools can still produce an unsupported conclusion. That gap is Day 5's subject. The deployment table was later corrected: the new broken version is `034ebbee-24d6-467e-b8d8-da20905fe489` at `2026-10-09T17:24:18.965Z`, and the healthy restore is `66da21c3-088d-4406-a9bc-4065c8c7818d` at `2026-10-09T17:26:40.473Z`. No placeholder rows remain.

Third live report (same orchestrator version, corrected store): `answered` in 4 steps with the identical tool sequence — rate, standard-filtered events, deployments. The model again never queried a failing row and again concluded failures are "standard," adding the self-contradicting line "30 completed (100% success). 6 of those returned HTTP 5xx." The error is now reproducible, not a fluke: this model checks the healthy slice and generalizes. Day 2 closes here — the loop, tools, provider, endpoint, and evidence store all work live. Conclusion-checking is explicitly Day 5's job.
