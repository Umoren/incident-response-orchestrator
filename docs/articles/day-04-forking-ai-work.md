# Forking AI Work Creates Distributed Systems Problems

The moment two agents run at the same time, you stop building a chatbot and start building a distributed system. Day 4 fanned the telemetry and deployment investigations out concurrently, gave every entity an ID and a state, and persisted it all. Everything worked — and the system preserved a lie with the same care as the truth.

## What concurrency changed

One `Promise.allSettled()` carries the whole idea: both workers launch together, and the conductor waits for *every* outcome, not just the first success. A plain `Promise.all` would reject on one worker's crash and orphan the other's result. The drill proved the difference with a throwing worker: its explosion became a `failed` record while its sibling delivered, and the run graded `partial` instead of dying. Live, both workers succeeded — telemetry in 3 steps, deployment in 2 — and the response carried both conclusions side by side.

## State makes the system inspectable

Five tables now record the investigation the way an airline records a flight: incidents (one row per alert, with a unique dedupe key), runs (one row per attempt), tasks (the durable work assigned during that attempt), agents (the parent and each execution attempt, moving `queued → running → succeeded/failed/timed_out/cancelled`), and every tool call with its arguments and outcome. Keeping tasks separate from agents gives retries a stable target: a new agent can attempt the same task without pretending it is new work. The duplicate-alert drill proved the outer identity stays consistent: the same key twice produced one incident, one run, and zero new model calls.

## Bounded work, honestly labeled

Every unit of work has two ceilings: a step budget and a timeout. The timeout's fine print matters — it stops *waiting*, not the work. A model call already in flight keeps running; its late answer is ignored and the agent is marked `timed_out`. That limitation is written in the code comments, not discovered in production. Two gaps stay open and stated: nothing resumes an interrupted run yet (the state to do it exists; the path doesn't), and the `cancelled` state has no writer, because abandonment currently covers what cancellation would.

## The warning the week earned

With all machinery green, the telemetry worker's conclusion contained a failing request — wrong order type, invented ID — that appears nowhere in the evidence tables. Every real failure is a priority order; the worker served one as standard and fabricated its identifier. The durable store preserved it with full provenance formatting, indistinguishable from the verified rows beside it.

So the distributed-systems work is done and insufficient. Forking, grading, deduplicating, persisting — all correct, all live. And the record now holds a falsehood that outlives the run that produced it. Coordination machinery guarantees *that* something was said and *who* said it. Nothing in Day 4 checks *whether it was true*. That check is Day 5's entire job, and this row is its first case file.

The operating principle: **a system that remembers everything must also verify something — otherwise persistence just makes lies last longer.**
