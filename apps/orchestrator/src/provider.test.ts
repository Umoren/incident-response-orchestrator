// Provider translation tests. Shapes below mirror real Workers AI replies:
// the OpenAI-style granite shape and the legacy Hermes-style shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAiReply, toAiTools } from './provider.js';

test('tools are wrapped in OpenAI function format', () => {
  const wrapped = toAiTools([{ name: 'getErrorRate', description: 'Rate', parameters: {} }]);
  assert.deepEqual(wrapped, [
    { type: 'function', function: { name: 'getErrorRate', description: 'Rate', parameters: {} } },
  ]);
});

test('an OpenAI-style answer parses to text', () => {
  const result = parseAiReply({
    choices: [{ message: { role: 'assistant', content: 'All quiet.', tool_calls: [] } }],
  });
  assert.deepEqual(result, { kind: 'answer', text: 'All quiet.' });
});

test('an OpenAI-style tool call parses name and JSON arguments', () => {
  const result = parseAiReply({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'getErrorRate', arguments: '{"from":"2026-10-07"}' } }],
        },
      },
    ],
  });
  assert.deepEqual(result, { kind: 'tool', name: 'getErrorRate', args: { from: '2026-10-07' } });
});

test('double-encoded arguments decode to the object', () => {
  const inner = JSON.stringify({ from: '2026-10-07' });
  const result = parseAiReply({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ type: 'function', function: { name: 'getErrorRate', arguments: JSON.stringify(inner) } }],
        },
      },
    ],
  });
  assert.deepEqual(result, { kind: 'tool', name: 'getErrorRate', args: { from: '2026-10-07' } });
});

test('a legacy Hermes-style reply still parses', () => {
  const answer = parseAiReply({ response: 'Done.' });
  assert.deepEqual(answer, { kind: 'answer', text: 'Done.' });
  const call = parseAiReply({ tool_calls: [{ name: 'listDeployments', arguments: {} }] });
  assert.deepEqual(call, { kind: 'tool', name: 'listDeployments', args: {} });
});

test('an empty reply becomes an explicit non-answer, not a crash', () => {
  assert.deepEqual(parseAiReply({}), { kind: 'answer', text: '(the model returned no text)' });
  assert.deepEqual(parseAiReply(null), { kind: 'answer', text: '(the model returned no text)' });
});
