# Day 4 — Core Understanding

Day 3 taught the parent agent how to delegate work. Day 4 taught the application how to manage several delegated workers safely.

The distinction to remember is:

> Day 3 created workers. Day 4 made their execution concurrent, bounded, durable, and inspectable.

## 1. An incident is different from a run

An **incident** is the real problem. A **run** is one attempt to investigate that problem. A **task** is a durable unit of work inside that attempt. An **agent** is one execution attempt for a task. A **tool call** is one action taken by that agent.

Our hierarchy is:

```text
Incident
└── Run
    ├── Parent agent
    ├── Telemetry task
    │   └── Telemetry worker agent
    └── Deployment task
        └── Deployment worker agent
```

This separation matters because one incident can have several investigation runs, and one task can later have several agent attempts if retries are added.

## 2. D1 became the system's durable memory

Before Day 4, most coordination state lived inside an HTTP request and agent conversation. Day 4 added persistent records for incidents, runs, tasks, agents, and tool calls.

The database can now answer:

- Which incident caused this work?
- Which run attempted it?
- Which tasks were created?
- Which agents attempted those tasks?
- What tools did each agent call?
- How did each task and agent end?

The investigation remains inspectable after the request ends.

## 3. The store separates coordination from storage

`src/store.ts` defines one `IncidentStore` contract. `D1IncidentStore` implements it with SQL for production. `MemoryIncidentStore` implements it with maps and arrays for tests.

The orchestration code asks the store to create tasks, update states, and record calls. It does not need to know whether the data is going to D1 or memory.

```text
Production: runIncident → D1IncidentStore → D1
Tests:      runIncident → MemoryIncidentStore → memory
```

## 4. The endpoint defines independent work slices

`POST /incident` turns one alert into two tasks:

- Telemetry: count errors and list failing requests.
- Deployment: list the version timeline.

Each task receives only the tools it needs. The telemetry worker gets `queryQuoteEvents` and `getErrorRate`. The deployment worker gets `listDeployments`.

This is a capability boundary. A worker cannot use a tool that was not placed in its tool set.

## 5. `runIncident()` is the conductor

The conductor does not investigate telemetry or deployments itself. It coordinates the workers that do.

Its sequence is:

1. Check the dedupe key.
2. Create the incident and run.
3. Create the parent agent.
4. Create task and worker records.
5. Execute workers sequentially or concurrently.
6. Collect every outcome.
7. Grade and persist the run.
8. Return tasks, agents, conclusions, execution mode, and elapsed time.

## 6. Concurrency means overlapping waits

In sequential mode, one worker must finish before the next starts:

```text
Telemetry:  start ───────── finish
Deployment:                   start ───── finish
```

In concurrent mode, both promises start before either is awaited to completion:

```text
Telemetry:  start ───────── finish
Deployment: start ───── finish
```

This does not require two JavaScript threads. The expensive model and database waits overlap.

The controlled test gives both workers a 100 ms tool. Sequential execution takes about 200 ms; concurrent execution takes about 100 ms. The live run measured 25,795 ms sequentially and 15,521 ms concurrently: 10,274 ms saved, 39.8% lower elapsed time, and a 1.66x speedup.

## 7. Every task and agent has an explicit lifecycle

Tasks and worker agents begin as `queued`, move to `running`, and finish as `succeeded`, `failed`, or `timed_out`.

```text
queued → running → succeeded
                 → failed
                 → timed_out
```

The schema also allows `cancelled`, but current code does not produce that state yet.

The state answers an operational question: what happened to this unit of work? It does not answer whether the conclusion was factually correct.

## 8. Tool calls are recorded through a hook

The Day 2 agent loop now accepts an optional `onToolResult` callback. After every successful or failed tool call, the loop reports the step, tool name, arguments, output, or error.

`runIncident()` supplies a callback that writes the event to `agent_tool_calls` under the worker's agent ID.

```text
Agent requests tool
→ tool executes
→ result enters the conversation
→ onToolResult receives the event
→ event is written to D1
```

The agent loop remains independent of D1. It reports events; the orchestrator decides how to store them.

## 9. A timeout bounds how long the conductor waits

Each worker races its agent loop against a timeout.

```text
Agent finishes first → use the report
Timeout finishes first → mark task and agent timed_out
```

The timeout stops waiting. It does not cancel a model request already in flight. A late result is ignored.

The timeout timer is cleared when normal work finishes. Fixing that detail reduced the test suite from about 120 seconds to 1.14 seconds.

## 10. One worker's failure does not erase another worker's result

Concurrent mode uses `Promise.allSettled()`. It waits for every worker to succeed or fail.

With `Promise.all()`, one rejection can reject the whole collection immediately. With `Promise.allSettled()`, the conductor can preserve a telemetry success even if deployment fails.

The failure drill produced:

```text
Telemetry worker:  succeeded
Deployment worker: failed
Run:               partial
```

## 11. The run is graded from worker outcomes

The grading rule is deliberately small:

```text
All workers succeeded  → succeeded
Some workers succeeded → partial
No workers succeeded   → failed
```

This is an execution grade. It describes completion, not factual accuracy.

## 12. The live results prove the coordination path

The first live concurrent run created one parent and two workers, and both workers succeeded. The later timing run created separate task and agent IDs:

```text
Telemetry task  026b0209... → agent b194757f...
Deployment task d8434017... → agent 4e74eeae...
```

Both tasks and both worker agents ended `succeeded`. The parent had `task_id: null` because it coordinated the run rather than executing either work item.

## 13. Operational success is different from factual correctness

The telemetry worker twice claimed that request `677971f7-...` was a standard-order HTTP 500. Direct D1 inspection showed that the request does not appear among the failures and every real failure was a priority order.

The worker still ended `succeeded` because it completed its loop, stayed within its bounds, and returned an answer.

```text
Execution success ≠ factual correctness
```

Day 4 determines whether work completed. Day 5 must determine whether the completed work is trustworthy.

## 14. What Day 4 now implements

- Controlled sequential and concurrent execution modes.
- Measured `elapsedMs` in every incident response.
- Concurrent collection with `Promise.allSettled()`.
- Separate incident, run, task, and agent IDs.
- Parent-child agent relationships.
- Task-to-agent relationships.
- Durable task, agent, and tool-call state in D1.
- Tool restrictions per task.
- Step limits and worker timeouts.
- `succeeded`, `partial`, and `failed` run grading.
- Duplicate-notification handling through a stable dedupe key.
- Tests for overlap, timing, failure isolation, duplicates, timeouts, task identity, and tool history.
- 22 passing tests.

## 15. What remains intentionally incomplete

- No automatic retry policy exists.
- No interrupted run is resumed automatically.
- `cancelled` exists in the schema but has no code path.
- Allowed state names are enforced, but every valid transition path is not enforced by the database.
- Two identical notifications arriving at exactly the same instant could race: the unique database key prevents two incident rows, but the losing request may receive an insertion error instead of a clean duplicate response.
- Day 4 records conclusions but does not verify their claims.

These are not reasons to discard the implementation. They define its current boundary and the next engineering decisions.

## Teach-Back Questions

1. What is the difference between an incident and a run?
2. What is the difference between a task and an agent?
3. Why should a retry create a new agent rather than a new task?
4. Why do the telemetry and deployment workers receive different tools?
5. What causes two notifications to refer to the same incident?
6. At what point does the duplicate path return, and what work does it avoid?
7. What is the difference between sequential and concurrent execution in this implementation?
8. What did the controlled timing test prove that the live timing comparison could not prove deterministically?
9. Why does concurrent execution use `Promise.allSettled()` instead of `Promise.all()`?
10. How does the conductor decide whether a run is `succeeded`, `partial`, or `failed`?
11. What exactly does a worker timeout stop, and what does it not stop?
12. How does a tool result reach both the agent conversation and D1?
13. Why does the parent agent have no task ID?
14. Why was the telemetry worker marked `succeeded` even though it fabricated a request row?
15. Which Day 4 records would you inspect to reconstruct one worker's investigation?
16. What would need to change before the system could retry a timed-out task safely?
17. What race can occur if two identical notifications arrive at precisely the same time?
18. Which responsibility belongs to Day 5 rather than Day 4?

## One-Minute Explanation

> Day 3 gave the parent an ability to delegate. Day 4 turned delegated work into managed work. One incident creates an investigation run. The run creates telemetry and deployment tasks, and each task receives a worker agent with limited tools. The orchestrator can run those workers sequentially or concurrently, records every state and tool call in D1, bounds each worker with a step limit and timeout, and uses `Promise.allSettled()` so one failure does not erase another result. A dedupe key prevents repeated notifications from starting repeated investigations. Our live concurrent run was 39.8% faster than the sequential run. But a worker also completed successfully while making a false claim, which proves the boundary: Day 4 manages execution; Day 5 must verify truth.
