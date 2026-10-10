// Delegation. The parent hands a bounded task to a sub-agent that owns its
// objective, its context, its tools, and its history — and nothing else.
//
// Three boundaries, all structural:
// - Fresh message history: the worker never sees the parent's conversation.
// - Explicit context string: the worker starts with what the parent passes.
// - Tool subset without `delegate`: depth stops at 1 by construction.
// The parent receives { status, stepsUsed, conclusion } — the result, never
// the worker's transcript.

import {
  runAgent,
  type AgentTool,
  type ChatMessage,
  type InferResult,
  type ToolSchema,
} from './agent.js';
import { isRecord } from './tools.js';

export interface DelegateOptions {
  infer: (messages: ChatMessage[], tools: ToolSchema[]) => Promise<InferResult>;
  allTools: AgentTool[];
  defaultMaxSteps?: number;
}

export function buildDelegateTool(options: DelegateOptions): AgentTool {
  return {
    schema: {
      name: 'delegate',
      description:
        'Hand a bounded task to a specialist sub-agent with its own conversation history. Give it a task, the context it needs, and the tool names it may use. It cannot delegate further. You receive its conclusion, not its transcript.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: "The worker's objective" },
          context: { type: 'string', description: 'Facts the worker starts with' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tool names the worker may use',
          },
          maxSteps: { type: 'number', description: 'Worker step budget, default 6' },
        },
        required: ['task'],
      },
    },
    run: async (args: unknown) => {
      if (!isRecord(args) || typeof args.task !== 'string') {
        throw new Error('delegate needs a task string');
      }
      const requested = Array.isArray(args.tools)
        ? args.tools.filter((name): name is string => typeof name === 'string')
        : options.allTools.map((tool) => tool.schema.name);
      const subset = options.allTools.filter((tool) => requested.includes(tool.schema.name));
      if (subset.length === 0) throw new Error('delegate: no valid tools selected');
      const report = await runAgent({
        objective: args.task,
        context: typeof args.context === 'string' ? args.context : undefined,
        tools: subset,
        maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : (options.defaultMaxSteps ?? 6),
        infer: options.infer,
      });
      return { status: report.status, stepsUsed: report.stepsUsed, conclusion: report.finalAnswer };
    },
  };
}
