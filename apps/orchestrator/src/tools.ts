// Read-only investigation tools. Every function in this file runs SELECT and
// nothing else. A tool that needs to write belongs in a different file with a
// different review. Keep it that way: the agent must never gain the ability
// to change evidence through an edit here.

import type { AgentTool } from './agent.js';

// Structural interface, not a Cloudflare import, so unit tests can pass a
// fake database and production can pass the real D1 binding.
export interface DbStatement {
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface QueryableDb {
  prepare(query: string): { bind(...params: unknown[]): DbStatement };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

export function buildTools(db: QueryableDb): AgentTool[] {
  return [
    {
      schema: {
        name: 'queryQuoteEvents',
        description: 'List recorded quote attempts, newest first. Filter by time window, order type, or HTTP status.',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'ISO start time, inclusive' },
            to: { type: 'string', description: 'ISO end time, inclusive' },
            orderType: { type: 'string', description: 'standard or priority' },
            httpStatus: { type: 'number', description: 'Exact HTTP status to match' },
            limit: { type: 'number', description: 'Max rows, default 20, capped at 100' },
          },
        },
      },
      run: async (args: unknown) => {
        if (!isRecord(args)) throw new Error('queryQuoteEvents expects an object of arguments');
        const conditions: string[] = [];
        const params: unknown[] = [];
        const from = optionalString(args, 'from');
        const to = optionalString(args, 'to');
        const orderType = optionalString(args, 'orderType');
        if (from) {
          conditions.push('occurred_at >= ?');
          params.push(from);
        }
        if (to) {
          conditions.push('occurred_at <= ?');
          params.push(to);
        }
        if (orderType) {
          if (orderType !== 'standard' && orderType !== 'priority') {
            throw new Error('orderType must be standard or priority');
          }
          conditions.push('order_type = ?');
          params.push(orderType);
        }
        if (args.httpStatus !== undefined) {
          if (typeof args.httpStatus !== 'number') throw new Error('httpStatus must be a number');
          conditions.push('http_status = ?');
          params.push(args.httpStatus);
        }
        const rawLimit = typeof args.limit === 'number' ? Math.floor(args.limit) : 20;
        const limit = Math.min(Math.max(rawLimit, 1), 100);
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const { results } = await db
          .prepare(
            `SELECT occurred_at, request_id, order_type, quantity, http_status, release_label, error_text, transport_error FROM quote_events ${where} ORDER BY occurred_at DESC LIMIT ${limit}`,
          )
          .bind(...params)
          .all();
        return results;
      },
    },
    {
      schema: {
        name: 'getErrorRate',
        description: 'Count recorded requests in a time window and report the HTTP 5xx share. Transport failures (no HTTP response) are reported separately and excluded from the rate.',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'ISO start time, inclusive' },
            to: { type: 'string', description: 'ISO end time, inclusive' },
          },
        },
      },
      run: async (args: unknown) => {
        if (!isRecord(args)) throw new Error('getErrorRate expects an object of arguments');
        const conditions: string[] = [];
        const params: unknown[] = [];
        const from = optionalString(args, 'from');
        const to = optionalString(args, 'to');
        if (from) {
          conditions.push('occurred_at >= ?');
          params.push(from);
        }
        if (to) {
          conditions.push('occurred_at <= ?');
          params.push(to);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const { results } = await db
          .prepare(
            `SELECT COUNT(*) AS total, SUM(CASE WHEN http_status >= 500 THEN 1 ELSE 0 END) AS http5xx, SUM(CASE WHEN http_status IS NULL THEN 1 ELSE 0 END) AS transportUnknown FROM quote_events ${where}`,
          )
          .bind(...params)
          .all();
        const row = results[0] as { total: number; http5xx: number; transportUnknown: number } | undefined;
        if (!row) throw new Error('getErrorRate returned no rows');
        const completed = row.total - row.transportUnknown;
        return {
          total: row.total,
          completed,
          http5xx: row.http5xx,
          transportUnknown: row.transportUnknown,
          // NULL when no request completed: "no data" is not "zero errors".
          errorRate: completed > 0 ? row.http5xx / completed : null,
        };
      },
    },
    {
      schema: {
        name: 'listDeployments',
        description: 'List recorded Worker deployments, oldest first, with version, release label, variant, and time.',
        parameters: { type: 'object', properties: {} },
      },
      run: async () => {
        const { results } = await db
          .prepare(
            'SELECT version_id, release_label, variant, deployed_at, traffic_percent FROM deployments ORDER BY deployed_at ASC',
          )
          .bind()
          .all();
        return results;
      },
    },
  ];
}
