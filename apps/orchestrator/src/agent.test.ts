// Loop behavior tests. Inference is a stub script: each test decides what the
// model says at each step, so the loop's rules get tested without any quota.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent, type AgentTool, type ChatMessage, type InferResult, type ToolSchema } from './agent.js';

function stubInfer(script: InferResult[]): (messages: ChatMessage[], tools: ToolSchema[]) => Promise<InferResult> {
  let position = 0;
  return async () => {
    const next = script[position] ?? script[script.length - 1];
    position++;
    if (!next) throw new Error('Empty inference script');
    return next;
  };
}

const successTool: AgentTool = {
  schema: { name: 'getErrorRate', description: 'Stub', parameters: { type: 'object', properties: {} } },
  run: async () => ({ errorRate: 0.4 }),
};

const failingTool: AgentTool = {
  schema: { name: 'queryQuoteEvents', description: 'Stub', parameters: { type: 'object', properties: {} } },
  run: async () => {
    throw new Error('D1 is unreachable');
  },
};

test('an answer with no tools ends the loop in one step', async () => {
  const report = await runAgent({
    objective: 'Check the service',
    tools: [successTool],
    infer: stubInfer([{ kind: 'answer', text: 'All quiet.' }]),
  });
  assert.equal(report.status, 'answered');
  assert.equal(report.stepsUsed, 1);
  assert.equal(report.finalAnswer, 'All quiet.');
});

test('a tool result reaches the model and informs the answer', async () => {
  const report = await runAgent({
    objective: 'Check the error rate',
    tools: [successTool],
    infer: stubInfer([
      { kind: 'tool', name: 'getErrorRate', args: {} },
      { kind: 'answer', text: 'The error rate is 40%.' },
    ]),
  });
  assert.equal(report.status, 'answered');
  assert.equal(report.stepsUsed, 2);
  const toolMessage = report.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage?.content ?? '', /0\.4/);
});

test('a tool failure becomes an observation instead of a crash', async () => {
  const report = await runAgent({
    objective: 'Check the events',
    tools: [failingTool],
    infer: stubInfer([
      { kind: 'tool', name: 'queryQuoteEvents', args: {} },
      { kind: 'answer', text: 'The events table is unreachable, so I cannot conclude.' },
    ]),
  });
  assert.equal(report.status, 'answered');
  const toolMessage = report.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage?.content ?? '', /D1 is unreachable/);
  assert.match(report.finalAnswer ?? '', /cannot conclude/);
});

test('an unknown tool becomes an observation instead of a crash', async () => {
  const report = await runAgent({
    objective: 'Check the service',
    tools: [successTool],
    infer: stubInfer([
      { kind: 'tool', name: 'restartService', args: {} },
      { kind: 'answer', text: 'That tool does not exist.' },
    ]),
  });
  assert.equal(report.status, 'answered');
  const toolMessage = report.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage?.content ?? '', /Unknown tool/);
});

test('a model that never answers hits the step limit', async () => {
  // Fresh arguments every step, so only the step limit can end this loop.
  let attempt = 0;
  const report = await runAgent({
    objective: 'Check the service',
    tools: [successTool],
    maxSteps: 3,
    infer: async () => ({ kind: 'tool', name: 'getErrorRate', args: { attempt: attempt++ } }),
  });
  assert.equal(report.status, 'step_limit');
  assert.equal(report.stepsUsed, 3);
  assert.equal(report.finalAnswer, null);
});

test('asking for the identical call twice stops the loop', async () => {
  const report = await runAgent({
    objective: 'Check the service',
    tools: [successTool],
    infer: stubInfer([{ kind: 'tool', name: 'getErrorRate', args: {} }]),
  });
  assert.equal(report.status, 'repeated_tool_call');
  assert.equal(report.stepsUsed, 2);
  assert.equal(report.finalAnswer, null);
});
