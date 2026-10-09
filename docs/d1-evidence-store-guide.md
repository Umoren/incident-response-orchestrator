# D1 Evidence Store — Setup Guide

How the `incident-evidence` database was created, and how to recreate every step. Run commands from `apps/incident-api/` unless stated otherwise. Prerequisites: Node 22 via nvm, `npm ci` done, `npx wrangler login` completed on your personal account.

## 1. Create the database

```sh
npx wrangler d1 create incident-evidence
```

Save the `database_id` from the output. Ours: `f44ad014-a8d8-4d7e-8fc2-03f62136f77a` (region WEUR).

## 2. Bind it to the Workers

Add the same snippet to every `wrangler.*.jsonc` that needs the evidence (both incident-api configs, and later the orchestrator):

```jsonc
"d1_databases": [
  {
    "binding": "incident_evidence",
    "database_name": "incident-evidence",
    "database_id": "f44ad014-a8d8-4d7e-8fc2-03f62136f77a"
  }
]
```

The binding takes effect on the next deploy. D1 bindings cannot be read-only, so read-only access is enforced in code (tools run `SELECT` only).

## 3. Apply the schema

Schema lives in `infra/d1/schema.sql`. Two tables (`deployments`, `quote_events`) plus two indexes:

```sh
npx wrangler d1 execute incident-evidence --remote --file=../../infra/d1/schema.sql
```

Expect `Executed 4 queries`. Omit `--remote` only to target the local simulator instead.

## 4. Record the deployments by hand

Get exact timestamps from the dashboard (**Workers & Pages → incident-quote-api → Deployments**, hover each entry). Never guess times:

```sh
npx wrangler d1 execute incident-evidence --remote --command="INSERT INTO deployments (version_id, release_label, variant, deployed_at, traffic_percent) VALUES ('<VERSION_ID>', '<RELEASE_LABEL>', '<healthy|broken>', '<ISO_TIME>', 100)"
```

One row per deployment, comma-separated in a single statement. Our three rows: healthy `3e9e73ee` (2026-10-07T16:21:12.316Z), broken `14ba0d70` (2026-10-07T16:37:03.397Z), healthy restore `a4f9a86f` (2026-10-09T12:47:48.980Z).

## 5. Record a traffic sample

From the project root, run traffic with a record file (fifth argument):

```sh
node scripts/traffic.mjs https://incident-quote-api.samuelumoren365.workers.dev 3 1000 /tmp/quote-events.sql
```

Each row captures the server's `requestId` and `release` from the response body, linking the client's observation to the server log. Transport failures are stored with NULL status, never dropped.

Load it (from `apps/incident-api/`):

```sh
npx wrangler d1 execute incident-evidence --remote --file=/tmp/quote-events.sql
```

## 6. Verify

```sh
npx wrangler d1 execute incident-evidence --remote --command="SELECT release_label, http_status, COUNT(*) AS n FROM quote_events GROUP BY release_label, http_status"
```

Compare against the `traffic.finished` line. They must agree — if they don't, the store is not the evidence you think it is.
