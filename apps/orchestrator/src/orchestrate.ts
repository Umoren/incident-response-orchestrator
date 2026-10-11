// The conductor. Starts independent workers at the same time, writes down
// every state change, and collects every result — including failures.
// One worker crashing never stops the others: Promise.allSettled waits for
// all of them, then the run is graded on what actually came back.
//
// Honest limits, stated up front:
// - A timeout stops WAITING, not the work. The model call already in flight
//   keeps running; its late answer is ignored and the agent is marked timed_out.
// - A duplicate alert (same dedupe key) starts nothing. It points at the
//   incident that already exists.

import { runAgent, type AgentTool, type ChatMessage, type InferResult, type ToolSchema } from './agent.js';
import type { IncidentStore, RunState } from './store.js';

export interface WorkerSlice {
  key: string;
  task: string;
  context?: string;
  tools: string[];
  maxSteps?: number;
  timeoutMs?: number;
}

export interface WorkerOutcome {
  key: string;
  agentId: string;
  status: 'succeeded' | 'failed' | 'timed_out';
  stepsUsed: number | null;
  conclusion: string | null;
}

export interface IncidentResult {
  incidentId: string;
  runId: string | null;
  deduplicated: boolean;
  workers: WorkerOutcome[];
  runStatus: RunState | 'duplicate';
}

export interface OrchestrateOptions {
  store: IncidentStore;
  infer: (messages: ChatMessage[], tools: ToolSchema[]) => Promise<InferResult>;
  readTools: AgentTool[];
  objective: string;
  context?: string;
  dedupeKey: string;
  slices: WorkerSlice[];
  defaultTimeoutMs?: number;
}

function lateTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Worker timed out after ${ms}ms`)), ms);
  });
}

export async function runIncident(options: OrchestrateOptions): Promise<IncidentResult> {
  const now = () => new Date().toISOString();
  const { store, infer, readTools, objective, context, dedupeKey, slices } = options;
  const timeoutMs = options.defaultTimeoutMs ?? 120_000;

  const existing = await store.findIncidentByDedupe(dedupeKey);
  if (existing) {
    return { incidentId: existing.incident_id, runId: null, deduplicated: true, workers: [], runStatus: 'duplicate' };
  }

  const incidentId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await store.createIncident(incidentId, dedupeKey, objective, now());
  await store.createRun(runId, incidentId, now());

  const parentId = crypto.randomUUID();
  await store.createAgent(
    { agent_id: parentId, run_id: runId, role: 'parent', task: objective, parent_agent_id: null },
    now(),
  );
  await store.setAgentState(parentId, 'running', now());

  const flights = slices.map(async (slice): Promise<WorkerOutcome> => {
    const agentId = crypto.randomUUID();
    await store.createAgent(
      { agent_id: agentId, run_id: runId, role: 'worker', task: slice.task, parent_agent_id: parentId },
      now(),
    );
    await store.setAgentState(agentId, 'running', now());

    const subset = readTools.filter((tool) => slice.tools.includes(tool.schema.name));
    if (subset.length === 0) {
      await store.finishAgent(agentId, 'failed', null, 'No valid tools selected for this worker.', now());
      return { key: slice.key, agentId, status: 'failed', stepsUsed: null, conclusion: 'No valid tools selected for this worker.' };
    }

    const recordCall = async (event: { step: number; tool: string; args: unknown; ok: boolean; output?: unknown; error?: string }) => {
      await store.recordToolCall(
        {
          agent_id: agentId,
          step: event.step,
          tool_name: event.tool,
          args_json: JSON.stringify(event.args ?? null),
          ok: event.ok,
          output_json: event.ok ? JSON.stringify(event.output ?? null).slice(0, 4000) : null,
          error_text: event.ok ? null : (event.error ?? 'Unknown error'),
        },
        now(),
      );
    };

    try {
      const report = await Promise.race([
        runAgent({
          objective: slice.task,
          context: slice.context ?? context,
          tools: subset,
          maxSteps: slice.maxSteps ?? 6,
          infer,
          onToolResult: recordCall,
        }),
        lateTimeout(slice.timeoutMs ?? timeoutMs),
      ]);
      const status = report.status === 'answered' ? 'succeeded' : 'failed';
      await store.finishAgent(agentId, status, report.stepsUsed, report.finalAnswer, now());
      return { key: slice.key, agentId, status, stepsUsed: report.stepsUsed, conclusion: report.finalAnswer };
    } catch (error) {
      const timedOut = error instanceof Error && error.message.includes('timed out');
      const status = timedOut ? 'timed_out' : 'failed';
      const note = error instanceof Error ? error.message : String(error);
      await store.finishAgent(agentId, status, null, note, now());
      return { key: slice.key, agentId, status, stepsUsed: null, conclusion: note };
    }
  });

  // Every worker settles — success or failure — before the run is graded.
  const settled = await Promise.allSettled(flights);
  const workers = settled.map((entry, index): WorkerOutcome => {
    const slice = slices[index] as WorkerSlice;
    if (entry.status === 'fulfilled') return entry.value;
    return { key: slice.key, agentId: 'unknown', status: 'failed', stepsUsed: null, conclusion: String(entry.reason) };
  });

  const succeeded = workers.filter((worker) => worker.status === 'succeeded').length;
  const runStatus: RunState = succeeded === workers.length ? 'succeeded' : succeeded > 0 ? 'partial' : 'failed';
  await store.finishRun(runId, runStatus, now());
  await store.finishAgent(parentId, runStatus === 'failed' ? 'failed' : 'succeeded', null, null, now());

  return { incidentId, runId, deduplicated: false, workers, runStatus };
}
