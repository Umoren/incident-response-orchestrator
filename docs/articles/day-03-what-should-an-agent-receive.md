# What Should an Agent Receive When Work Is Delegated?

Delegation creates boundaries: the parent decides what problem the worker owns, what it knows, and what it can touch. I tested those boundaries by running the same incident investigation twice — once with full context, once with almost none — and watching what broke.

## The setup

The parent agent holds read-only evidence tools plus one `delegate` tool. Delegating builds a sub-agent with a fresh history containing only its task and the context the parent passes, a named subset of tools, and no ability to delegate further. Depth stops at one structurally. The parent receives a verdict — status, step count, conclusion — never the worker's transcript.

The experiment changed exactly one variable: the opening sentence. The rich run opened with the time window, the versions, and the bug description. The minimal run opened with "Something is wrong with the quote API."

## What happened

The rich run never delegated. The parent queried the evidence itself, landed on a priority-500 row first, and tied failures to the broken release. Context did the job delegation was meant for.

The minimal run delegated once — a telemetry slice with a generic context restating the incident and no time window. The worker, knowing nothing of October 7–9, constructed its own window ("last 7 days" from its blurry sense of today), searched the wrong period, found zero rows, and truthfully reported zero traffic. The parent merged that empty result with its own correct deployment listing into a confident falsehood: the API "is not being invoked at all." Nobody checked the worker's conclusion against anything. The failure chain is exact: missing context, wrong period, empty result, trusted blindly, false report as fact.

## What a worker should receive

**A task narrow enough to verify.** "Gather error counts" is checkable; "investigate the incident" is not. The parent can only judge what it could re-check, so the task should be sized to its supervision.

**The facts the task assumes.** A time window is not background — it is the task's coordinate system. The worker had tools, a sensible objective, and correct behavior, and still failed, because nothing in its world said *when* to look. Whatever the parent doesn't pass down doesn't exist.

**Only the tools the task needs.** The telemetry worker got two read tools; the deployment slice would get one. Capability scoping worked everywhere it was tried — including keeping `delegate` out of workers' hands.

**And the parent should receive the method, not just the verdict.** This run exposed the gap: the worker's transcript stayed behind the boundary, including the one detail — which dates it searched — that would have unmasked the error. Conclusions cross; methods don't; so a wrong method arrives looking identical to a right one. Persisting worker histories is Day 4's work, and this failure is why.

## The operating principle

**Delegate the work, not the judgment.** The parent may hand away the querying, but it keeps the duty of checking — against other evidence, against the timeline, against the question the worker never thought to ask. A conclusion you didn't watch being produced is a rumor with good formatting.
