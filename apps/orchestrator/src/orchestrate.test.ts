// Day 4 drills. Scripted models, memory store, real timers where timing is
// the thing under test. No quota spent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentTool, ChatMessage, InferResult, ToolSchema } from './agent.js';
import { runIncident, type WorkerSlice } from './orchestrate.js';
import { MemoryIncidentStore } from './store.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeTools(events: Array<{ key: string; phase: string; at: number }>): AgentTool[] {
  return [
    {
      schema: { name: 'getErrorRate', description: 'Stub', parameters: { type: 'object', properties: {} } },
      run: async () => {
        events.push({ key: 'telemetry', phase: 'start', at: Date.now() });
        await sleep(100);
        events.push({ key: 'telemetry', phase: 'end', at: Date.now() });
        return { errorRate: 0.2 };
      },
    },
    {
      schema: { name: 'listDeployments', description: 'Stub', parameters: { type: 'object', properties: {} } },
      run: async () => {
        events.push({ key: 'deployment', phase: 'start', at: Date.now() });
        await sleep(100);
        events.push({ key: 'deployment', phase: 'end', at: Date.now() });
        return [{ version_id: 'broken' }];
      },
    },
  ];
}

const slices: WorkerSlice[] = [
  { key: 'telemetry', task: 'Telemetry slice: count errors.', tools: ['getErrorRate'] },
  { key: 'deployment', task: 'Deployment slice: list versions.', tools: ['listDeployments'] },
];

function answerAfterTools(text: string): (messages: ChatMessage[], tools: ToolSchema[]) => Promise<InferResult> {
  // Each worker owns its messages array, so one worker answering never
  // answers for another.
  const answered = new WeakSet<object>();
  return async (messages, tools) => {
    if (answered.has(messages)) return { kind: 'answer', text };
    answered.add(messages);
    const firstTool = tools[0];
    if (!firstTool) throw new Error('No tools');
    return { kind: 'tool', name: firstTool.name, args: {} };
  };
}

test('independent workers overlap in time', async () => {
  const events: Array<{ key: string; phase: string; at: number }> = [];
  const store = new MemoryIncidentStore();
  const result = await runIncident({
    store,
    infer: answerAfterTools('telemetry done'),
    readTools: fakeTools(events),
    objective: 'Investigate',
    dedupeKey: 'overlap-1',
    slices,
  });
  assert.equal(result.runStatus, 'succeeded');
  const starts = events.filter((event) => event.phase === 'start').map((event) => event.at);
  const ends = events.filter((event) => event.phase === 'end').map((event) => event.at);
  // Both workers started before either finished: they ran together.
  assert.ok(Math.max(...starts) < Math.min(...ends), 'workers did not overlap');
});

test('one worker failing does not sink the other', async () => {
  const store = new MemoryIncidentStore();
  const infer = async (messages: ChatMessage[], tools: ToolSchema[]): Promise<InferResult> => {
    const first = messages[0]?.content ?? '';
    if (first.includes('Deployment slice')) throw new Error('Model exploded');
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') return { kind: 'answer', text: 'telemetry fine' };
    const firstTool = tools[0];
    if (!firstTool) throw new Error('No tools');
    return { kind: 'tool', name: firstTool.name, args: {} };
  };
  const result = await runIncident({
    store,
    infer,
    readTools: fakeTools([]),
    objective: 'Investigate',
    dedupeKey: 'partial-1',
    slices,
  });
  assert.equal(result.runStatus, 'partial');
  const byKey = new Map(result.workers.map((worker) => [worker.key, worker]));
  assert.equal(byKey.get('telemetry')?.status, 'succeeded');
  assert.equal(byKey.get('deployment')?.status, 'failed');
  const agents = await store.listAgents(result.runId as string);
  assert.equal(agents.length, 3); // parent + two workers
});

test('the same alert twice starts one investigation', async () => {
  const store = new MemoryIncidentStore();
  const first = await runIncident({
    store,
    infer: answerAfterTools('done'),
    readTools: fakeTools([]),
    objective: 'Investigate',
    dedupeKey: 'same-alert',
    slices,
  });
  const second = await runIncident({
    store,
    infer: answerAfterTools('done'),
    readTools: fakeTools([]),
    objective: 'Investigate',
    dedupeKey: 'same-alert',
    slices,
  });
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.runId, null);
  assert.equal(store.incidents.size, 1);
  assert.equal(store.runs.size, 1);
});

test('a slow worker is marked timed out and ignored', async () => {
  const store = new MemoryIncidentStore();
  const hanging: (messages: ChatMessage[], tools: ToolSchema[]) => Promise<InferResult> = () =>
    new Promise(() => {});
  const result = await runIncident({
    store,
    infer: hanging,
    readTools: fakeTools([]),
    objective: 'Investigate',
    dedupeKey: 'timeout-1',
    slices: [{ key: 'slow', task: 'Slow work.', tools: ['getErrorRate'], timeoutMs: 50 }],
  });
  assert.equal(result.runStatus, 'failed');
  assert.equal(result.workers[0]?.status, 'timed_out');
});

test('every tool call is written down under its agent', async () => {
  const store = new MemoryIncidentStore();
  const result = await runIncident({
    store,
    infer: answerAfterTools('done'),
    readTools: fakeTools([]),
    objective: 'Investigate',
    dedupeKey: 'history-1',
    slices: [slices[0] as WorkerSlice],
  });
  assert.equal(result.runStatus, 'succeeded');
  const workerId = result.workers[0]?.agentId as string;
  const calls = store.toolCalls.filter((call) => call.agent_id === workerId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tool_name, 'getErrorRate');
  assert.equal(calls[0]?.ok, true);
});
