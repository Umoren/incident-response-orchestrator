# Day 4 — Concurrent workers with durable state

For the 15-part teaching explanation and review questions, see [`day-04-core-understanding.md`](./day-04-core-understanding.md).

## What was built

- `infra/d1/migrate-day04.sql`: `incidents` (unique `dedupe_key`), `runs`, `agents` (queued/running/succeeded/failed/timed_out/cancelled), `agent_tool_calls` (every tool request and outcome, per agent).
- `infra/d1/migrate-day04-task-ids.sql`: first-class `tasks` plus `agents.task_id`. A task is durable work; an agent is one attempt to execute it.
- `src/store.ts`: one state-keeper interface; D1 version for production, memory version for tests.
- `src/agent.ts`: an `onToolResult` hook — the loop reports each tool call without changing behavior.
- `src/orchestrate.ts`: supports a measured sequential baseline and concurrent execution with `Promise.allSettled()`; returns `executionMode` and `elapsedMs`; grades the run succeeded/partial/failed; enforces per-worker timeouts; maps a repeated alert to the existing incident. A timeout stops waiting, not the work — recorded as a known limit.
- `POST /incident`: one alert in (`dedupeKey` required), sequential or concurrent investigation out, task and agent lists attached.
- The timeout timer is cleared when work finishes, so successful tests no longer wait for the unused 120-second timer.

## Live drills

Run from `apps/incident-api/`. If the original Day 4 migration is not already applied, apply it first:

```sh
npx wrangler d1 execute incident-evidence --remote --file=../../infra/d1/migrate-day04.sql
```

The original migration executes 6 queries (4 tables + 2 indexes). Apply the task-identity follow-up once:

```sh
npx wrangler d1 execute incident-evidence --remote --file=../../infra/d1/migrate-day04-task-ids.sql
```

Then deploy from `apps/orchestrator/`:

```sh
npm run deploy
```

Fire the incident (any directory):

```sh
curl -s -X POST "https://incident-orchestrator.samuelumoren365.workers.dev/incident" -H 'content-type: application/json' -d '{"dedupeKey":"drill-2026-10-10","context":"Time window: 2026-10-07 to 2026-10-09. The quote API had a broken deployment in that window."}' -o /tmp/incident-1.json
python3 -c "import json; r=json.load(open('/tmp/incident-1.json')); print(r['runStatus'], [(w['key'], w['status']) for w in r['workers']])"
```

## Sequential versus concurrent baseline

The automated baseline gives both workers a 100 ms tool. Sequential execution must wait about 200 ms; concurrent execution overlaps the waits and takes about 100 ms. The test asserts the measured concurrent `elapsedMs` is lower, and separately proves both workers started before either finished.

For a live comparison, use different dedupe keys so both requests execute:

```sh
curl -s -X POST "https://incident-orchestrator.samuelumoren365.workers.dev/incident" -H 'content-type: application/json' -d '{"dedupeKey":"timing-sequential-2026-10-12","executionMode":"sequential","context":"Time window: 2026-10-07 to 2026-10-09."}' | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['executionMode'], r['elapsedMs'])"

curl -s -X POST "https://incident-orchestrator.samuelumoren365.workers.dev/incident" -H 'content-type: application/json' -d '{"dedupeKey":"timing-concurrent-2026-10-12","executionMode":"concurrent","context":"Time window: 2026-10-07 to 2026-10-09."}' | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['executionMode'], r['elapsedMs'])"
```

The live times include model latency and are therefore illustrative, not a controlled benchmark.

Send the same alert again and confirm nothing restarts:

```sh
curl -s -X POST "https://incident-orchestrator.samuelumoren365.workers.dev/incident" -H 'content-type: application/json' -d '{"dedupeKey":"drill-2026-10-10","context":"Time window: 2026-10-07 to 2026-10-09."}' -o /tmp/incident-2.json
python3 -c "import json; r=json.load(open('/tmp/incident-2.json')); print(r['deduplicated'], r['runStatus'])"
```

Expect `deduplicated: true`. Then inspect the stored state:

```sh
npx wrangler d1 execute incident-evidence --remote --command="SELECT role, task, status, steps_used FROM agents WHERE run_id = '<RUN_ID>'"
npx wrangler d1 execute incident-evidence --remote --command="SELECT task_id, task_key, status FROM tasks WHERE run_id = '<RUN_ID>'"
npx wrangler d1 execute incident-evidence --remote --command="SELECT tool_name, ok, COUNT(*) FROM agent_tool_calls GROUP BY tool_name, ok"
```

## Observations

- Task-identity migration: applied remotely; 4 queries in 4.07 ms, 10 rows written, bookmark `00000011-00000006-00005102-7efa764a66606c4ddaeca83945ee5708`.
- Orchestrator version deployed: `603f38e3-f0ba-4bcf-9f60-98239445dfa4`.
- First run (`drill-2026-10-10`, incident `de776c00`, run `828f52c4`): `succeeded`; telemetry 3 steps, deployment 2 steps; agent rows persisted (1 parent + 2 workers, all `succeeded`); worker conclusions returned inline. Telemetry claims 6 HTTP 500s at 20% — matches the store totals. One listed failing row claims `order_type: standard` with status 500, which the bug should never produce. Verified against D1: all 6 real failures are `priority` on `broken-02`. The `677971f7-... standard 500` row appears nowhere in the store — the worker fabricated a request ID and a failure that never happened, inside a table of otherwise-correct totals. Durable state now preserves a falsehood alongside the facts. This is the strongest possible exhibit for Day 5: persistence without verification just makes lies last longer.
- Duplicate run: `deduplicated: true`, same incident ID, no new run, no workers spawned, no model calls. The database holds exactly one incident and one run for the key.
- Task/agent identity observed on run `fa4dbd37`: telemetry task `026b0209` was executed by agent `b194757f`; deployment task `d8434017` was executed by agent `4e74eeae`. Both task rows and both worker rows ended `succeeded`; the parent has no task because it is the conductor.
- Sequential live baseline: 25,795 ms; both workers succeeded.
- Concurrent live run: 15,521 ms; both workers succeeded. Concurrency saved 10,274 ms (39.8% lower elapsed time, 1.66x faster). Live model latency varies, so the controlled 100 ms unit drill remains the deterministic proof of overlap.
- The telemetry worker repeated the previously disproven `677971f7-... standard 500` row in the concurrent run. The execution system correctly marks completion, but still has no factual-verification stage.

## Limits recorded

- Timeout stops waiting, not the in-flight model call; late answers are ignored.
- Worker histories are write-only during a run (parent judges conclusions; methods accumulate for later audit).
