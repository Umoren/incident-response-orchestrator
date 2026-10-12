// Orchestrator Worker. It investigates; it never touches the quote API's
// code or configuration. The only bridge between the two Workers is the
// shared evidence database, and this Worker only reads from it.

import { runAgent, type ChatMessage, type InferResult, type ToolSchema } from './agent.js';
import { buildDelegateTool } from './delegate.js';
import { runIncident } from './orchestrate.js';
import { parseAiReply, toAiTools } from './provider.js';
import { D1IncidentStore, type DbExecutor } from './store.js';
import { buildTools, type QueryableDb } from './tools.js';

// The generated Env type covers our bindings. The cast below widens only the
// input shape; the call stays attached as env.AI.run(...) because the binding
// needs its `this` at runtime. Never detach the method into a variable.
async function workersAiInfer(env: Env, messages: ChatMessage[], schemas: ToolSchema[]): Promise<InferResult> {
  const ai = env.AI as unknown as {
    run(model: string, input: { messages: Array<{ role: string; content: string }>; tools: unknown }): Promise<unknown>;
  };
  const response = await ai.run(env.MODEL, {
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    tools: toAiTools(schemas),
  });
  return parseAiReply(response);
}

const DEFAULT_OBJECTIVE =
  'Investigate the current incident and end with what is known, what is uncertain, and what should happen next. Work through specialists: delegate a telemetry slice (error counts and failing requests, using queryQuoteEvents and getErrorRate) and a deployment slice (version timeline, using listDeployments) to separate workers, giving each only the context and tools its task needs. Then combine their conclusions with the deployment timeline into one assessment. Check every major claim against the evidence before stating it.';

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ status: 'ok' });
    }

    if (request.method === 'POST' && url.pathname === '/investigate') {
      let body: { objective?: string; context?: string; maxSteps?: number } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ error: 'Send a JSON body' }, { status: 400 });
      }
      const maxSteps = Number(env.MAX_STEPS ?? 8);
      try {
        const db = env.incident_evidence as unknown as QueryableDb;
        const readTools = buildTools(db);
        const infer = (messages: ChatMessage[], schemas: ToolSchema[]) => workersAiInfer(env, messages, schemas);
        // The parent alone receives `delegate`. Workers are built inside the
        // delegate tool from readTools only, so depth stops at 1 structurally.
        const parentTools = [...readTools, buildDelegateTool({ infer, allTools: readTools })];
        const report = await runAgent({
          objective: typeof body.objective === 'string' ? body.objective : DEFAULT_OBJECTIVE,
          context: typeof body.context === 'string' ? body.context : undefined,
          tools: parentTools,
          maxSteps: Number.isInteger(body.maxSteps) ? body.maxSteps : maxSteps,
          infer,
        });
        return Response.json(report);
      } catch (error) {
        console.error(JSON.stringify({ event: 'investigate.failed', error: error instanceof Error ? error.message : String(error) }));
        return Response.json({ error: 'Investigation failed', detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }

    // Temporary diagnostic endpoint. Calls inference twice — once with plain
    // messages, once with tools attached — to isolate which half the model
    // rejects. Remove before Day 7.
    if (request.method === 'POST' && url.pathname === '/probe') {
      const ai = env.AI as unknown as { run(model: string, input: unknown): Promise<unknown> };
      const messages = [{ role: 'user', content: 'Reply with the word OK.' }];
      const results: Record<string, unknown> = {};
      try {
        results.plain = await ai.run(env.MODEL, { messages });
      } catch (error) {
        results.plainError = error instanceof Error ? error.message : String(error);
      }
      try {
        results.withTools = await ai.run(env.MODEL, {
          messages,
          tools: buildTools(env.incident_evidence as unknown as QueryableDb).map((tool) => tool.schema),
        });
      } catch (error) {
        results.withToolsError = error instanceof Error ? error.message : String(error);
      }
      return Response.json(results);
    }

    // One alert in, concurrent investigation out. The same dedupeKey twice
    // points at the existing incident instead of starting a new run.
    if (request.method === 'POST' && url.pathname === '/incident') {
      let body: {
        dedupeKey?: string;
        objective?: string;
        context?: string;
        timeoutMs?: number;
        executionMode?: 'sequential' | 'concurrent';
      } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ error: 'Send a JSON body' }, { status: 400 });
      }
      if (typeof body.dedupeKey !== 'string' || body.dedupeKey.length === 0) {
        return Response.json({ error: 'dedupeKey is required' }, { status: 400 });
      }
      if (body.executionMode && !['sequential', 'concurrent'].includes(body.executionMode)) {
        return Response.json({ error: 'executionMode must be sequential or concurrent' }, { status: 400 });
      }
      try {
        const db = env.incident_evidence as unknown as QueryableDb & DbExecutor;
        const readTools = buildTools(db);
        const infer = (messages: ChatMessage[], schemas: ToolSchema[]) => workersAiInfer(env, messages, schemas);
        const store = new D1IncidentStore(db);
        const context = typeof body.context === 'string' ? body.context : undefined;
        const result = await runIncident({
          store,
          infer,
          readTools,
          objective: typeof body.objective === 'string' ? body.objective : DEFAULT_OBJECTIVE,
          context,
          dedupeKey: body.dedupeKey,
          slices: [
            {
              key: 'telemetry',
              task: 'Telemetry slice: count errors and list failing requests in the given window.',
              context,
              tools: ['queryQuoteEvents', 'getErrorRate'],
            },
            {
              key: 'deployment',
              task: 'Deployment slice: list the version timeline covering the given window.',
              context,
              tools: ['listDeployments'],
            },
          ],
          defaultTimeoutMs: Number.isInteger(body.timeoutMs) ? body.timeoutMs : 120_000,
          executionMode: body.executionMode ?? 'concurrent',
        });
        const [tasks, agents] = result.runId
          ? await Promise.all([store.listTasks(result.runId), store.listAgents(result.runId)])
          : [[], []];
        return Response.json({ ...result, tasks, agents });
      } catch (error) {
        console.error(JSON.stringify({ event: 'incident.failed', error: error instanceof Error ? error.message : String(error) }));
        return Response.json({ error: 'Incident run failed', detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }

    return Response.json({ error: 'Route not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
