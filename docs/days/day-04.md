# Day 4 — Concurrent workers with durable state

## What was built

- `infra/d1/migrate-day04.sql`: `incidents` (unique `dedupe_key`), `runs`, `agents` (queued/running/succeeded/failed/timed_out/cancelled), `agent_tool_calls` (every tool request and outcome, per agent).
- `src/store.ts`: one state-keeper interface; D1 version for production, memory version for tests.
- `src/agent.ts`: an `onToolResult` hook — the loop reports each tool call without changing behavior.
- `src/orchestrate.ts`: launches telemetry + deployment slices together with `Promise.allSettled()`; grades the run succeeded/partial/failed; enforces per-worker timeouts; maps a repeated alert to the existing incident. A timeout stops waiting, not the work — recorded as a known limit.
- `POST /incident`: one alert in (`dedupeKey` required), concurrent investigation out, agent list attached.
- 21 tests passing (16 prior + 5 drills: overlap, failure isolation, dedupe, timeout, history).

## Live drills

Run from `apps/incident-api/` first — apply the migration to the real database:

```sh
npx wrangler d1 execute incident-evidence --remote --file=../../infra/d1/migrate-day04.sql
```

Expect 6 executed queries (4 tables + 2 indexes). Then deploy from `apps/orchestrator/`:

```sh
npm run deploy
```

Fire the incident (any directory):

```sh
curl -s -X POST "https://incident-orchestrator.samuelumoren365.workers.dev/incident" -H 'content-type: application/json' -d '{"dedupeKey":"drill-2026-10-10","context":"Time window: 2026-10-07 to 2026-10-09. The quote API had a broken deployment in that window."}' -o /tmp/incident-1.json
python3 -c "import json; r=json.load(open('/tmp/incident-1.json')); print(r['runStatus'], [(w['key'], w['status']) for w in r['workers']])"
```

Send the same alert again and confirm nothing restarts:

```sh
curl -s -X POST "https://incident-orchestrator.samuelumoren365.workers.dev/incident" -H 'content-type: application/json' -d '{"dedupeKey":"drill-2026-10-10","context":"Time window: 2026-10-07 to 2026-10-09."}' -o /tmp/incident-2.json
python3 -c "import json; r=json.load(open('/tmp/incident-2.json')); print(r['deduplicated'], r['runStatus'])"
```

Expect `deduplicated: true`. Then inspect the stored state:

```sh
npx wrangler d1 execute incident-evidence --remote --command="SELECT role, task, status, steps_used FROM agents WHERE run_id = '<RUN_ID>'"
npx wrangler d1 execute incident-evidence --remote --command="SELECT tool_name, ok, COUNT(*) FROM agent_tool_calls GROUP BY tool_name, ok"
```

## Observations

- Migration result:
- Orchestrator version deployed:
- First run (`drill-2026-10-10`, incident `de776c00`, run `828f52c4`): `succeeded`; telemetry 3 steps, deployment 2 steps; agent rows persisted (1 parent + 2 workers, all `succeeded`); worker conclusions returned inline. Telemetry claims 6 HTTP 500s at 20% — matches the store totals. One listed failing row claims `order_type: standard` with status 500, which the bug should never produce. Verified against D1: all 6 real failures are `priority` on `broken-02`. The `677971f7-... standard 500` row appears nowhere in the store — the worker fabricated a request ID and a failure that never happened, inside a table of otherwise-correct totals. Durable state now preserves a falsehood alongside the facts. This is the strongest possible exhibit for Day 5: persistence without verification just makes lies last longer.
- Duplicate run: `deduplicated: true`, same incident ID, no new run, no workers spawned, no model calls. The database holds exactly one incident and one run for the key.
- Agent rows and tool-call rows observed:

## Limits recorded

- Timeout stops waiting, not the in-flight model call; late answers are ignored.
- Worker histories are write-only during a run (parent judges conclusions; methods accumulate for later audit).
