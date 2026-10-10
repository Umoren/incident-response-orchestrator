// Delegation tests. One scripted inference function plays parent and worker:
// the script order is parent-decides, worker-works, parent-concludes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent, type AgentTool, type ChatMessage, type InferResult, type ToolSchema } from './agent.js';
import { buildDelegateTool } from './delegate.js';

const readTool: AgentTool = {
  schema: { name: 'listDeployments', description: 'Stub', parameters: { type: 'object', properties: {} } },
  run: async () => [{ version_id: 'abc', variant: 'broken' }],
};

function scripted(script: InferResult[]): (messages: ChatMessage[], tools: ToolSchema[]) => Promise<InferResult> {
  let position = 0;
  return async (_messages, _tools) => {
    const next = script[position] ?? script[script.length - 1];
    position++;
    if (!next) throw new Error('Empty script');
    return next;
  };
}

test('delegation returns the worker conclusion to the parent', async () => {
  // One shared script: parent delegates, worker answers, parent concludes.
  // The worker's answer must reach the parent as a conclusion, not a transcript.
  const shared = scripted([
    { kind: 'tool', name: 'delegate', args: { task: 'Check deployments', tools: ['listDeployments'] } },
    { kind: 'answer', text: 'Worker says broken.' },
    { kind: 'answer', text: 'Parent concludes: broken deployment.' },
  ]);
  const delegate = buildDelegateTool({ infer: shared, allTools: [readTool] });
  const report = await runAgent({ objective: 'Investigate', tools: [delegate], infer: shared });
  assert.equal(report.status, 'answered');
  assert.equal(report.finalAnswer, 'Parent concludes: broken deployment.');
  const toolMessage = report.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage?.content ?? '', /Worker says broken/);
  assert.doesNotMatch(toolMessage?.content ?? '', /version_id/);
});

test('a worker cannot use tools outside its subset', async () => {
  const delegate = buildDelegateTool({
    allTools: [readTool],
    infer: scripted([
      { kind: 'tool', name: 'queryQuoteEvents', args: {} },
      { kind: 'answer', text: 'I lack that tool.' },
    ]),
  });
  const outcome = (await delegate.run({ task: 'Check events', tools: ['listDeployments'] })) as {
    status: string;
    conclusion: string;
  };
  assert.equal(outcome.status, 'answered');
  assert.equal(outcome.conclusion, 'I lack that tool.');
});

test('a worker cannot delegate further', async () => {
  const delegate = buildDelegateTool({
    allTools: [readTool],
    infer: scripted([
      { kind: 'tool', name: 'delegate', args: { task: 'Nested work' } },
      { kind: 'answer', text: 'No delegate here.' },
    ]),
  });
  const outcome = (await delegate.run({ task: 'Outer work', tools: ['listDeployments'] })) as {
    status: string;
    conclusion: string;
  };
  assert.equal(outcome.status, 'answered');
  assert.equal(outcome.conclusion, 'No delegate here.');
});

test('delegation without a task or valid tools fails loudly', async () => {
  const delegate = buildDelegateTool({ infer: scripted([]), allTools: [readTool] });
  await assert.rejects(delegate.run({}), /needs a task/);
  await assert.rejects(delegate.run({ task: 'Work', tools: ['nonexistent'] }), /no valid tools/);
});
