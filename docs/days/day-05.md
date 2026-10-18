# Day 5 — Merge the results with verification

## Decisions

- Hybrid: a rule-based checker verifies mechanical claims (request rows, aggregates, timeline). No model in the verification path.
- Confidence defines the grade: verified ÷ checked. ≥0.8 `succeeded`, ≥0.5 `partial`, below `failed`. Confidence downgrades execution, never upgrades it.
- Unverified claims are labeled UNCERTAIN and kept, never silently dropped.

## What was built

- `src/verify.ts`: `verifyTelemetry`, `verifyDeployment`, `confidenceOf`, `buildAssessment`. Request IDs are extracted, looked up in the evidence tables, and compared against nearby claimed attributes. Aggregates are checked only when stated. Each ID is judged on its own clause so labels never leak across rows (a real bug caught by tests: the fake row's `standard` label bled into real rows' windows).
- `infra/d1/migrate-day05.sql`: `claim_verdicts` table; `runs.confidence` and `runs.assessment_json`.
- `src/store.ts`: `recordVerdict`, `setRunVerification` (D1 + memory).
- `src/orchestrate.ts`: after all workers settle, every succeeded worker's conclusion is verified against `evidenceDb`, verdicts persist per worker, the run grade combines execution with confidence, and the response carries `confidence`, `assessment` (known / uncertain / next), and per-worker `verdicts`.
- `POST /incident` passes the evidence database and returns verdicts plus the assessment.
- 31 tests passing (22 prior + 9 drills: real/fake rows, mislabeled type, aggregates, skipped numbers, unknown versions, partial downgrade, clean run, absent evidence, fail threshold).

## Live drills

Apply the migration once from `apps/incident-api/`:

```sh
npx wrangler d1 execute incident-evidence --remote --file=../../infra/d1/migrate-day05.sql
```

Deploy from `apps/orchestrator/`:

```sh
npm run deploy
```

Fire a fresh incident (new dedupe key so it executes):

```sh
curl -s -X POST "https://incident-orchestrator.samuelumoren365.workers.dev/incident" -H 'content-type: application/json' -d '{"dedupeKey":"verify-live-2026-10-12","context":"Time window: 2026-10-07 to 2026-10-09. The quote API had a broken deployment in that window."}' -o /tmp/verify-1.json
python3 -c "import json; r=json.load(open('/tmp/verify-1.json')); print(r['runStatus'], r['confidence']); print('KNOWN:', *r['assessment']['known'], sep='\n  '); print('UNCERTAIN:', *r['assessment']['uncertain'], sep='\n  '); print('NEXT:', *r['assessment']['next'], sep='\n  ')"
```

Expect the invented `677971f7` row (if the worker repeats it) to appear under UNCERTAIN with a `not_found` reason, and `runStatus` at `partial` rather than `succeeded`.

Inspect stored verdicts:

```sh
npx wrangler d1 execute incident-evidence --remote --command="SELECT worker_key, claim, status FROM claim_verdicts WHERE run_id = '<RUN_ID>'"
npx wrangler d1 execute incident-evidence --remote --command="SELECT status, confidence FROM runs WHERE run_id = '<RUN_ID>'"
```

## Observations

- Migration result:
- Orchestrator version deployed:
- First live run (`verify-live-2026-10-12`, incident `5db27452`, run `b4c982f6`): `succeeded`, confidence 1.0, 5 known, 0 uncertain, 13.3s concurrent. Aggregates (total 30, rate 0.20) and 3 deployment versions verified.
- Blind spot found in that run: the telemetry table's request IDs used non-ASCII hyphens (U+2011), so no request_row verdicts were produced — confidence 1.0 rested on aggregates alone. The `fd738079 standard` failing row went unchecked by the verifier. Fixed by normalizing lookalike hyphens before extraction, plus a fallback `5xx errors` pattern and an assessment note when no request rows are extractable. 33 tests pass.
- Second live run (`verify-live-2026-10-14`): `partial`, confidence `0.7142857142857143` (5 of 7 checked claims verified), 5 known, 2 uncertain. The verifier caught `fd738079...` presented as a 5xx even though D1 says HTTP 200, and `a4225d5c...` presented as `standard` even though D1 says `priority`/500. The worker completed successfully; confidence correctly downgraded the run.
- Did the worker repeat the invented row, and did the verifier catch it: the suspicious `fd738079` request was real, but the worker's status claim was wrong. The updated verifier caught the contradiction and kept it under `UNCERTAIN`.

## Limits recorded

- Attribution is clause-based: attributes stated far from an ID are not checked against it.
- Aggregates are checked only for totals, 5xx counts, and error rate in recognizable forms.
- The verifier cannot judge prose reasoning, only mechanical claims. A conclusion can verify fully and still argue poorly — that gap is stated, not solved.
