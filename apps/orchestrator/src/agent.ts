// The agent loop. The model thinks; this code acts and observes.
//
// Nothing in this file calls a model directly. Inference arrives through the
// injected `infer` function, so tests can drive the loop with a stub and spend
// no quota. Production passes a function that calls Workers AI.
//
// Three rules govern the loop:
// 1. A model mistake (unknown tool) becomes an observation, never a crash.
// 2. A tool failure becomes an observation, never a crash.
// 3. The loop always ends: on an answer, the step limit, or a repeated call.

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentTool {
  schema: ToolSchema;
  run: (args: unknown) => Promise<unknown>;
}

export type InferResult = { kind: 'answer'; text: string } | { kind: 'tool'; name: string; args: unknown };

export type AgentStatus = 'answered' | 'step_limit' | 'repeated_tool_call';

export interface AgentReport {
  status: AgentStatus;
  stepsUsed: number;
  finalAnswer: string | null;
  messages: ChatMessage[];
}

export interface ToolResultEvent {
  step: number;
  tool: string;
  args: unknown;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface RunAgentOptions {
  objective: string;
  context?: string;
  tools: AgentTool[];
  maxSteps?: number;
  infer: (messages: ChatMessage[], tools: ToolSchema[]) => Promise<InferResult>;
  // Called after every tool call. Lets the orchestrator write history down
  // without changing how the loop behaves.
  onToolResult?: (event: ToolResultEvent) => void | Promise<void>;
}

function callKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args ?? null)}`;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentReport> {
  const { objective, context, tools, infer } = options;
  const maxSteps = options.maxSteps ?? 8;
  const byName = new Map(tools.map((tool) => [tool.schema.name, tool]));
  const schemas = tools.map((tool) => tool.schema);

  const opening = context ? `${objective}\n\nContext:\n${context}` : objective;
  const messages: ChatMessage[] = [{ role: 'user', content: opening }];

  let lastCallKey: string | null = null;

  for (let step = 1; step <= maxSteps; step++) {
    const decision = await infer(messages, schemas);

    if (decision.kind === 'answer') {
      messages.push({ role: 'assistant', content: decision.text });
      return { status: 'answered', stepsUsed: step, finalAnswer: decision.text, messages };
    }

    const tool = byName.get(decision.name);
    if (!tool) {
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ toolCall: { name: decision.name, args: decision.args } }),
      });
      messages.push({
        role: 'tool',
        name: decision.name,
        content: JSON.stringify({
          ok: false,
          error: `Unknown tool: ${decision.name}. Available: ${[...byName.keys()].join(', ')}`,
        }),
      });
      lastCallKey = null;
      continue;
    }

    const key = callKey(decision.name, decision.args);
    if (key === lastCallKey) {
      // The model asked for exactly what it just received. Answering again
      // would burn quota without new information, so the loop stops here.
      return { status: 'repeated_tool_call', stepsUsed: step, finalAnswer: null, messages };
    }
    lastCallKey = key;

    messages.push({
      role: 'assistant',
      content: JSON.stringify({ toolCall: { name: decision.name, args: decision.args } }),
    });

    try {
      const output = await tool.run(decision.args);
      messages.push({ role: 'tool', name: decision.name, content: JSON.stringify({ ok: true, output }) });
      await options.onToolResult?.({ step, tool: decision.name, args: decision.args, ok: true, output });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      messages.push({
        role: 'tool',
        name: decision.name,
        content: JSON.stringify({ ok: false, error: message }),
      });
      await options.onToolResult?.({ step, tool: decision.name, args: decision.args, ok: false, error: message });
    }
  }

  return { status: 'step_limit', stepsUsed: maxSteps, finalAnswer: null, messages };
}
