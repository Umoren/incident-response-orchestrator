# Day 3 — Delegation

## Design

The parent receives `delegate` plus the three read tools. Workers are built inside the delegate tool from the read tools only, so workers can never delegate further — depth stops at 1 structurally, not by policy. Each worker gets a fresh history (task + context only), a tool subset named by the parent, and its own step budget (default 6). The parent receives `{status, stepsUsed, conclusion}`: the result, never the worker's transcript.

The parent's default objective now describes the strategy: a telemetry slice (error counts and failing requests) and a deployment slice (version timeline), then one combined assessment with every major claim checked against evidence.

## Unit tests (16 passing)

- Delegation returns the worker's conclusion, not its transcript (raw rows verified absent from the parent's observation).
- A worker requesting a tool outside its subset gets an unknown-tool observation.
- A worker requesting `delegate` gets an unknown-tool observation (no recursion).
- Missing task or empty tool selection fails loudly.

## Live experiment — the context boundary

Deploy from `apps/orchestrator/`, then run the same investigation twice with different context. First, rich context:

```sh
npm run deploy
curl -s -X POST "https://incident-orchestrator.samuelumoren365.workers.dev/investigate" -H 'content-type: application/json' -d '{"context":"Time window: 2026-10-07 to 2026-10-09. The quote API had a broken deployment in that window. Known versions: healthy-01 (3e9e73ee), broken-02 (14ba0d70). The bug fails priority orders with a shipping-rule lookup error."}' -o /tmp/delegate-rich.json
python3 -c "import json; r=json.load(open('/tmp/delegate-rich.json')); print(r['status'], r['stepsUsed'])"
```

Then minimal context:

```sh
curl -s -X POST "https://incident-orchestrator.samuelumoren365.workers.dev/investigate" -H 'content-type: application/json' -d '{"context":"Something is wrong with the quote API."}' -o /tmp/delegate-minimal.json
python3 -c "import json; r=json.load(open('/tmp/delegate-minimal.json')); print(r['status'], r['stepsUsed'])"
```

Compare the two transcripts: did the parent delegate in both? What task, context, and tools did each worker receive? Did the minimal-context workers ask for the missing window, search the wrong period, or conclude without support?

## Observations

- Orchestrator version deployed: `2be8eecc-d756-4e46-bc2b-0311b75b9ede` (first build with `delegate`).
- Rich-context run: `answered`, 4 steps, zero delegate calls (parent used its own read tools directly).
- Minimal-context run: `answered`, 3 steps, one delegate call — telemetry slice (`queryQuoteEvents` + `getErrorRate`) with a generic context restating the incident, no time window passed down.
- What changed when useful context was missing: the context-poor parent delegated; the context-rich parent worked solo. Delegation followed uncertainty, not instruction. Worker conclusions and both final answers still to compare.

## Full comparison (transcripts received)

**Rich run (answered, 4 steps, no delegation).** The parent queried all three tools itself with the given window and no order-type filter. Its first event row was a priority HTTP 500 on `broken-02`, and its answer correctly ties failures to priority orders on the broken release. Numbers are still sloppy ("all 30 priority orders" — the store holds 30 mixed requests, 6 failed), but it looked at a failing row for the first time. Context quality improved the investigation without any delegation.

**Minimal run (answered, 3 steps, one delegation).** The parent spawned a telemetry worker with a generic context restating the incident and no time window. The worker searched some other period ("last 7 days"), found 0 rows, and concluded no traffic exists. The parent then combined that empty result with its own correct `listDeployments` output (all five deployments) into a confident falsehood: the API "is not being invoked at all" while `broken-02` was "active the entire window." Nobody checked the worker's conclusion against anything. The failure chain is exact: missing context → wrong period → empty result → trusted blindly → false report delivered as fact.

## Manual investigation questions

1. What task, context, and tools did each worker receive, and who chose them?
2. Which worker produced each claim in the final assessment?
3. What happened when the worker lacked the time window?
4. Where does the parent's transcript show a worker conclusion being used — or ignored?
