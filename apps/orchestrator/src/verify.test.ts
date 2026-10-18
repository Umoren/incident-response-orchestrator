// Day 5 drills. The verifier is code, so its tests use a fake evidence
// database with known rows — including the exact fabrication our live
// telemetry worker produced twice.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InferResult } from './agent.js';
import { runIncident } from './orchestrate.js';
import { MemoryIncidentStore } from './store.js';
import type { QueryableDb } from './tools.js';
import { buildAssessment, confidenceOf, verifyDeployment, verifyTelemetry } from './verify.js';

const REAL_A = 'a4225d5c-acf6-405c-bd32-569817d73c8b';
const REAL_B = '969c06d4-70f4-489f-bbe8-df8d439cbb5b';
// The invented row from the live Day 4 runs: standard 500, no store row.
const FAKE = '677971f7-17cf-48f8-ba3a-aa61582bfc0d';

class FakeEvidenceDb implements QueryableDb {
  constructor(
    private requests: Array<{ request_id: string; order_type: string; http_status: number; release_label: string }> = [
      { request_id: REAL_A, order_type: 'priority', http_status: 500, release_label: 'broken-02' },
      { request_id: REAL_B, order_type: 'priority', http_status: 500, release_label: 'broken-02' },
    ],
  ) {}

  prepare(query: string) {
    return {
      bind: (...params: unknown[]) => ({
        all: async <T>(): Promise<{ results: T[] }> => {
          if (query.includes('FROM quote_events WHERE request_id')) {
            return { results: this.requests.filter((row) => row.request_id === params[0]) as unknown as T[] };
          }
          if (query.includes('COUNT(*)')) {
            return { results: [{ total: 30, http5xx: 2, transportUnknown: 0 }] as unknown as T[] };
          }
          if (query.includes('FROM deployments')) {
            return { results: [] as unknown as T[] };
          }
          return { results: [] as unknown as T[] };
        },
      }),
    };
  }
}

const answerWith = (text: string) => async (): Promise<InferResult> => ({ kind: 'answer', text });

const telemetrySlice = [{ key: 'telemetry', task: 'Telemetry slice.', tools: ['getErrorRate'] }];

const stubTools = [
  {
    schema: { name: 'getErrorRate', description: 'Stub', parameters: { type: 'object', properties: {} } },
    run: async () => ({ errorRate: 0.2 }),
  },
];

test('real rows verify, the invented row is not_found', async () => {
  const db = new FakeEvidenceDb();
  const verdicts = await verifyTelemetry(
    db,
    `Failures: ${REAL_A} priority 500. ${REAL_B} priority 500. ${FAKE} standard 500.`,
  );
  const byStatus = new Map(verdicts.map((v) => [v.claim.slice(0, 20), v.status]));
  assert.equal(verdicts.filter((v) => v.status === 'verified').length, 2);
  assert.ok(verdicts.some((v) => v.status === 'not_found' && v.detail.includes(FAKE)));
  void byStatus;
});

test('lookalike hyphens in IDs are normalized before lookup', async () => {
  const db = new FakeEvidenceDb();
  const fancy = REAL_A.replace(/-/g, '‑');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(fancy), 'test setup must use non-ASCII hyphens');
  const verdicts = await verifyTelemetry(db, `Failure: ${fancy} priority 500.`);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]?.status, 'verified');
});

test('a 5xx count without the http prefix is still checked', async () => {
  const db = new FakeEvidenceDb();
  const right = await verifyTelemetry(db, '| 5xx errors | 2 |');
  assert.ok(right.length === 1 && right[0]?.status === 'verified');
  const wrong = await verifyTelemetry(db, '| 5xx errors | 6 |');
  assert.ok(wrong.some((v) => v.status === 'contradicted'));
});
test('a mislabeled order type contradicts the store', async () => {
  const db = new FakeEvidenceDb();
  const verdicts = await verifyTelemetry(db, `Failure: ${REAL_A} standard 500.`);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]?.status, 'contradicted');
  assert.ok(verdicts[0]?.detail.includes('priority'));
});

test('aggregate totals verify when stated, contradict when wrong', async () => {
  const db = new FakeEvidenceDb();
  const right = await verifyTelemetry(db, '| Total requests | 30 |\n| HTTP 5xx errors | 2 |');
  assert.ok(right.every((v) => v.status === 'verified'));
  const wrong = await verifyTelemetry(db, '| Total requests | 30 |\n| HTTP 5xx errors | 6 |');
  assert.ok(wrong.some((v) => v.status === 'contradicted'));
});

test('unstated numbers are skipped, never penalized', async () => {
  const db = new FakeEvidenceDb();
  const verdicts = await verifyTelemetry(db, 'Some failures happened.');
  assert.equal(verdicts.length, 0);
  assert.equal(confidenceOf(verdicts), null);
});

test('unknown deployment versions are not_found', async () => {
  const db = new FakeEvidenceDb();
  const verdicts = await verifyDeployment(db, 'Deployed 14ba0d70-d62f-4281-a3b6-bbcc4d357eef as broken-02.');
  assert.equal(verdicts[0]?.status, 'not_found');
});

test('one invented row downgrades a succeeded run to partial', async () => {
  const store = new MemoryIncidentStore();
  const result = await runIncident({
    store,
    infer: answerWith(`Failures: ${REAL_A} priority 500. ${REAL_B} priority 500. ${FAKE} standard 500.`),
    readTools: stubTools,
    evidenceDb: new FakeEvidenceDb(),
    objective: 'Investigate',
    dedupeKey: 'verify-partial',
    slices: telemetrySlice,
  });
  assert.equal(result.workers[0]?.status, 'succeeded');
  assert.equal(result.confidence?.toFixed(3), (2 / 3).toFixed(3));
  assert.equal(result.runStatus, 'partial');
  assert.equal(result.assessment.uncertain.length, 1);
  assert.ok(result.assessment.uncertain[0]?.includes('UNCERTAIN'));
  assert.equal(result.assessment.known.length, 2);
  assert.equal(store.verdicts.length, 3);
});

test('fully verified conclusions keep the run succeeded', async () => {
  const store = new MemoryIncidentStore();
  const result = await runIncident({
    store,
    infer: answerWith(`Failures: ${REAL_A} priority 500. ${REAL_B} priority 500.`),
    readTools: stubTools,
    evidenceDb: new FakeEvidenceDb(),
    objective: 'Investigate',
    dedupeKey: 'verify-clean',
    slices: telemetrySlice,
  });
  assert.equal(result.confidence, 1);
  assert.equal(result.runStatus, 'succeeded');
  assert.equal(result.assessment.uncertain.length, 0);
});

test('without an evidence database nothing is checked and grading is unchanged', async () => {
  const store = new MemoryIncidentStore();
  const result = await runIncident({
    store,
    infer: answerWith('All good.'),
    readTools: stubTools,
    objective: 'Investigate',
    dedupeKey: 'verify-absent',
    slices: telemetrySlice,
  });
  assert.equal(result.confidence, null);
  assert.equal(result.runStatus, 'succeeded');
  assert.deepEqual(result.assessment, buildAssessment([]));
});

test('confidence below one half fails the run', async () => {
  const store = new MemoryIncidentStore();
  const result = await runIncident({
    store,
    infer: answerWith(`Failures: ${FAKE} standard 500.`),
    readTools: stubTools,
    evidenceDb: new FakeEvidenceDb(),
    objective: 'Investigate',
    dedupeKey: 'verify-fail',
    slices: telemetrySlice,
  });
  assert.equal(result.confidence, 0);
  assert.equal(result.runStatus, 'failed');
});
