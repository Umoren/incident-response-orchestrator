# Incident orchestrator

Second Worker. It investigates the quote API and never modifies it. The only bridge between the two Workers is the shared `incident-evidence` D1 database, and this Worker only runs `SELECT` against it.

- `src/agent.ts` — the `runAgent()` loop. Model thinks, runtime acts, observations return. Inference is injected, so tests drive the loop without quota.
- `src/tools.ts` — read-only tools over D1: `queryQuoteEvents`, `getErrorRate`, `listDeployments`. SELECT only, by file-level rule.
- `src/index.ts` — `GET /health` and `POST /investigate`. The request body accepts an optional `objective`, `context`, and `maxSteps`.

```sh
npm ci
npm test
npm run dev
```

To run a live investigation against the real evidence tables, deploy and POST an objective:

```sh
npm run deploy
curl -X POST "https://incident-orchestrator.<your-subdomain>.workers.dev/investigate" \
  -H 'content-type: application/json' \
  -d '{"context":"Time window: 2026-10-07 to 2026-10-09. The quote API had a broken deployment in that window."}'
```

Model and step budget come from `wrangler.jsonc` vars (`MODEL`, `MAX_STEPS`), not from code.
