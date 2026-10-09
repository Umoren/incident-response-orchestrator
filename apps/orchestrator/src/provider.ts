// Provider translation layer. The agent loop speaks InferResult; Workers AI
// models speak their own reply shapes. Everything provider-specific lives
// here, as pure functions, so it can be unit-tested without quota.
//
// Granite returns OpenAI-style replies: choices[0].message holds content and
// tool_calls, and tools must be sent as { type: 'function', function: {...} }.
// Older Hermes-style replies (top-level response / tool_calls) still parse.

import type { InferResult, ToolSchema } from './agent.js';

export function toAiTools(schemas: ToolSchema[]): Array<{ type: string; function: ToolSchema }> {
  return schemas.map((schema) => ({ type: 'function', function: schema }));
}

interface AiToolCallItem {
  name?: unknown;
  arguments?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

// Providers encode arguments as JSON strings, sometimes more than once (a
// string holding a string holding the object). Decode until the value stops
// being a string. Domain validation stays in the tools; this only normalizes
// transport encoding.
function normalizeArgs(raw: unknown): unknown {
  let value = raw;
  for (let i = 0; i < 3 && typeof value === 'string'; i++) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      break;
    }
  }
  return value;
}

interface AiRawResponse {
  response?: unknown;
  tool_calls?: AiToolCallItem[];
  choices?: Array<{ message?: { content?: unknown; tool_calls?: AiToolCallItem[] } }>;
}

export function parseAiReply(raw: unknown): InferResult {
  const response = (raw ?? {}) as AiRawResponse;
  const message = response.choices?.[0]?.message;
  const calls = message?.tool_calls ?? response.tool_calls ?? [];
  const call = calls[0];
  if (call) {
    const fn = call.function;
    const name = typeof fn?.name === 'string' ? fn.name : call.name;
    if (typeof name === 'string') return { kind: 'tool', name, args: normalizeArgs(fn?.arguments ?? call.arguments) };
  }
  const text = message?.content ?? response.response;
  return { kind: 'answer', text: typeof text === 'string' ? text : '(the model returned no text)' };
}
