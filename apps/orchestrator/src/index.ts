// Orchestrator Worker. It investigates; it never touches the quote API's
// code or configuration. The only bridge between the two Workers is the
// shared evidence database, and this Worker only reads from it.

import { runAgent, type ChatMessage, type InferResult, type ToolSchema } from './agent.js';
import { buildTools, type QueryableDb } from './tools.js';

interface WorkersAiResponse {
  response?: string;
  tool_calls?: Array<{ name: string; arguments: unknown }>;
}

// The generated Env type covers our bindings. The cast below widens only the
// input shape; the call stays attached as env.AI.run(...) because the binding
// needs its `this` at runtime. Never detach the method into a variable.
async function workersAiInfer(env: Env, messages: ChatMessage[], schemas: ToolSchema[]): Promise<InferResult> {
  const ai = env.AI as unknown as {
    run(model: string, input: { messages: Array<{ role: string; content: string }>; tools: ToolSchema[] }): Promise<WorkersAiResponse>;
  };
  const response = await ai.run(env.MODEL, {
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    tools: schemas,
  });
  const call = response.tool_calls?.[0];
  if (call) return { kind: 'tool', name: call.name, args: call.arguments };
  return { kind: 'answer', text: response.response ?? '(the model returned no text)' };
}

const DEFAULT_OBJECTIVE =
  'Investigate the current incident: determine whether quote failures are occurring, which order types and deployments are affected, and what the evidence supports. End with what is known, what is uncertain, and what should happen next.';

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
        const report = await runAgent({
          objective: typeof body.objective === 'string' ? body.objective : DEFAULT_OBJECTIVE,
          context: typeof body.context === 'string' ? body.context : undefined,
          tools: buildTools(env.incident_evidence as unknown as QueryableDb),
          maxSteps: Number.isInteger(body.maxSteps) ? body.maxSteps : maxSteps,
          infer: (messages, schemas) => workersAiInfer(env, messages, schemas),
        });
        return Response.json(report);
      } catch (error) {
        console.error(JSON.stringify({ event: 'investigate.failed', error: error instanceof Error ? error.message : String(error) }));
        return Response.json({ error: 'Investigation failed', detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }

    return Response.json({ error: 'Route not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
