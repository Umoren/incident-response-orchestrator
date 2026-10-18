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
import type { QueryableDb } from './tools.js';
import {
  buildAssessment,
  confidenceOf,
  verifyDeployment,
  verifyTelemetry,
  type Assessment,
  type WorkerVerdicts,
} from './verify.js';

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
  taskId: string;
  agentId: string;
  status: 'succeeded' | 'failed' | 'timed_out';
  stepsUsed: number | null;
  conclusion: string | null;
  confidence: number | null;
}

export interface IncidentResult {
  incidentId: string;
  runId: string | null;
  deduplicated: boolean;
  workers: WorkerOutcome[];
  runStatus: RunState | 'duplicate';
  executionMode: 'sequential' | 'concurrent';
  elapsedMs: number;
  /** Share of checked claims that verified. Null when nothing was checkable. */
  confidence: number | null;
  assessment: Assessment;
  verdicts: WorkerVerdicts[];
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
  executionMode?: 'sequential' | 'concurrent';
  /** Evidence database for the rule-based verifier. Absent: no verification. */
  evidenceDb?: QueryableDb;
}

function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Worker timed out after ${ms}ms`)), ms);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function runIncident(options: OrchestrateOptions): Promise<IncidentResult> {
  const startedAt = Date.now();
  const now = () => new Date().toISOString();
  const { store, infer, readTools, objective, context, dedupeKey, slices } = options;
  const timeoutMs = options.defaultTimeoutMs ?? 120_000;
  const executionMode = options.executionMode ?? 'concurrent';

  const existing = await store.findIncidentByDedupe(dedupeKey);
  if (existing) {
    return {
      incidentId: existing.incident_id,
      runId: null,
      deduplicated: true,
      workers: [],
      runStatus: 'duplicate',
      executionMode,
      elapsedMs: Date.now() - startedAt,
      confidence: null,
      assessment: { known: [], uncertain: [], next: [] },
      verdicts: [],
    };
  }

  const incidentId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await store.createIncident(incidentId, dedupeKey, objective, now());
  await store.createRun(runId, incidentId, now());

  const parentId = crypto.randomUUID();
  await store.createAgent(
    { agent_id: parentId, run_id: runId, task_id: null, role: 'parent', task: objective, parent_agent_id: null },
    now(),
  );
  await store.setAgentState(parentId, 'running', now());

  // A task is the durable unit of work. An agent is one attempt to execute it.
  // Create all tasks first so queued work is visible before execution begins.
  const prepared: Array<{ slice: WorkerSlice; taskId: string; agentId: string }> = [];
  for (const slice of slices) {
    const taskId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    await store.createTask(
      { task_id: taskId, run_id: runId, task_key: slice.key, description: slice.task },
      now(),
    );
    await store.createAgent(
      { agent_id: agentId, run_id: runId, task_id: taskId, role: 'worker', task: slice.task, parent_agent_id: parentId },
      now(),
    );
    prepared.push({ slice, taskId, agentId });
  }

  const runWorker = async ({ slice, taskId, agentId }: (typeof prepared)[number]): Promise<WorkerOutcome> => {
    await store.setTaskState(taskId, 'running', now());
    await store.setAgentState(agentId, 'running', now());

    const subset = readTools.filter((tool) => slice.tools.includes(tool.schema.name));
    if (subset.length === 0) {
      await store.finishTask(taskId, 'failed', now());
      await store.finishAgent(agentId, 'failed', null, 'No valid tools selected for this worker.', now());
      return { key: slice.key, taskId, agentId, status: 'failed', stepsUsed: null, conclusion: 'No valid tools selected for this worker.', confidence: null };
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
      const report = await withTimeout(
        runAgent({
          objective: slice.task,
          context: slice.context ?? context,
          tools: subset,
          maxSteps: slice.maxSteps ?? 6,
          infer,
          onToolResult: recordCall,
        }),
        slice.timeoutMs ?? timeoutMs,
      );
      const status = report.status === 'answered' ? 'succeeded' : 'failed';
      await store.finishTask(taskId, status, now());
      await store.finishAgent(agentId, status, report.stepsUsed, report.finalAnswer, now());
      return { key: slice.key, taskId, agentId, status, stepsUsed: report.stepsUsed, conclusion: report.finalAnswer, confidence: null };
    } catch (error) {
      const timedOut = error instanceof Error && error.message.includes('timed out');
      const status = timedOut ? 'timed_out' : 'failed';
      const note = error instanceof Error ? error.message : String(error);
      await store.finishTask(taskId, status, now());
      await store.finishAgent(agentId, status, null, note, now());
      return { key: slice.key, taskId, agentId, status, stepsUsed: null, conclusion: note, confidence: null };
    }
  };

  let settled: PromiseSettledResult<WorkerOutcome>[];
  if (executionMode === 'sequential') {
    settled = [];
    for (const item of prepared) {
      try {
        settled.push({ status: 'fulfilled', value: await runWorker(item) });
      } catch (reason) {
        settled.push({ status: 'rejected', reason });
      }
    }
  } else {
    // Every worker settles — success or failure — before the run is graded.
    settled = await Promise.allSettled(prepared.map(runWorker));
  }

  const workers = settled.map((entry, index): WorkerOutcome => {
    const slice = slices[index] as WorkerSlice;
    const item = prepared[index];
    if (entry.status === 'fulfilled') return entry.value;
    return {
      key: slice.key,
      taskId: item?.taskId ?? 'unknown',
      agentId: item?.agentId ?? 'unknown',
      status: 'failed',
      stepsUsed: null,
      conclusion: String(entry.reason),
      confidence: null,
    };
  });

  const succeeded = workers.filter((worker) => worker.status === 'succeeded').length;
  const executionGrade: RunState = succeeded === workers.length ? 'succeeded' : succeeded > 0 ? 'partial' : 'failed';

  // Day 5 verification: re-check every mechanical claim in each succeeded
  // worker's conclusion against the evidence tables. Verification runs after
  // all workers settle, so it never slows the investigation itself.
  const workerVerdicts: WorkerVerdicts[] = [];
  if (options.evidenceDb) {
    for (const worker of workers) {
      if (worker.status !== 'succeeded' || !worker.conclusion) continue;
      const check = worker.key === 'deployment' ? verifyDeployment : verifyTelemetry;
      const verdicts = await check(options.evidenceDb, worker.conclusion);
      const confidence = confidenceOf(verdicts);
      worker.confidence = confidence;
      workerVerdicts.push({ workerKey: worker.key, taskId: worker.taskId, agentId: worker.agentId, verdicts, confidence });
      for (const verdict of verdicts) {
        await store.recordVerdict(
          {
            run_id: runId,
            task_id: worker.taskId,
            agent_id: worker.agentId,
            worker_key: worker.key,
            claim: verdict.claim,
            kind: verdict.kind,
            status: verdict.status,
            detail: verdict.detail,
          },
          now(),
        );
      }
    }
  }
  const allVerdicts = workerVerdicts.flatMap((worker) => worker.verdicts);
  const confidence = allVerdicts.length > 0 ? confidenceOf(allVerdicts) : null;
  const assessment = buildAssessment(workerVerdicts);

  // Confidence defines the grade: it can only downgrade execution, never
  // upgrade it. A run that completed but verified nothing is not succeeded.
  const confidenceGrade: RunState | null =
    confidence === null ? null : confidence >= 0.8 ? 'succeeded' : confidence >= 0.5 ? 'partial' : 'failed';
  const rank: Record<RunState, number> = { running: 1, failed: 0, partial: 1, succeeded: 2 };
  const runStatus: RunState =
    confidenceGrade === null || rank[confidenceGrade] >= rank[executionGrade] ? executionGrade : confidenceGrade;
  await store.finishRun(runId, runStatus, now());
  await store.setRunVerification(runId, { confidence, assessmentJson: JSON.stringify(assessment) }, now());
  await store.finishAgent(parentId, runStatus === 'failed' ? 'failed' : 'succeeded', null, null, now());

  return {
    incidentId,
    runId,
    deduplicated: false,
    workers,
    runStatus,
    executionMode,
    elapsedMs: Date.now() - startedAt,
    confidence,
    assessment,
    verdicts: workerVerdicts,
  };
}
