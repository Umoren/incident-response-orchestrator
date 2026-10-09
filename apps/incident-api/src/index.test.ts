import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleQuoteRequest } from './index.js';

function quote(variant: 'healthy' | 'broken', type: string): Response {
  return handleQuoteRequest(
    new Request(`https://incident.test/quote?type=${type}&quantity=2`),
    variant,
    `${variant}-test`,
  );
}

test('healthy deployment quotes both order types', async () => {
  assert.equal((await quote('healthy', 'standard').json() as { total: number }).total, 55);
  assert.equal((await quote('healthy', 'priority').json() as { total: number }).total, 65);
});

test('broken deployment returns HTTP 500 only for priority orders', () => {
  assert.equal(quote('broken', 'standard').status, 200);
  assert.equal(quote('broken', 'priority').status, 500);
});

test('health does not hide a broken quote path', async () => {
  const response = handleQuoteRequest(new Request('https://incident.test/health'), 'broken', 'broken-test');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', release: 'broken-test' });
});
