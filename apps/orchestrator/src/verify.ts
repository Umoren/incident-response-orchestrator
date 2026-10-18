// The critic's rule-based half. Mechanical claims — request rows, counts,
// timeline entries — are exact database lookups, so code checks them, not a
// model. A verifier that could hallucinate would defeat its own purpose.
//
// What it checks:
// - Every request ID quoted in a telemetry conclusion: does the row exist,
//   and do the order type / status claimed near it match the store?
// - Aggregate numbers (total requests, HTTP 5xx count, error rate) when the
//   conclusion states them in a recognizable form. Absent numbers are skipped,
//   never penalized: only stated claims are checked.
// - Every version ID quoted in a deployment conclusion: does it exist, and
//   does a nearby release label match?
//
// Confidence = verified / checked. Uncheckable prose is excluded, not scored.

import type { QueryableDb } from './tools.js';

export type VerdictStatus = 'verified' | 'contradicted' | 'not_found' | 'uncheckable';

export type ClaimKind = 'request_row' | 'aggregate' | 'deployment';

export interface ClaimVerdict {
  claim: string;
  kind: ClaimKind;
  status: VerdictStatus;
  detail: string;
}

export interface EvidenceRow {
  request_id: string;
  order_type: string;
  http_status: number | null;
  release_label: string | null;
}

export interface DeploymentRow {
  version_id: string;
  release_label: string;
  variant: string;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Models sometimes emit lookalike hyphens (U+2010, U+2011, U+2212).
 *  Normalize them 1:1 so IDs stay matchable without shifting offsets. */
export function normalizeText(text: string): string {
  // eslint-disable-next-line no-misleading-character-class
  return text.replace(/[\u2010\u2011\u2212\uFE58\uFE63\uFF0D]/g, '-');
}

export function extractIds(text: string): string[] {
  const found = text.match(UUID_RE) ?? [];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of found) {
    const lower = id.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      unique.push(lower);
    }
  }
  return unique;
}

/** The ~200 characters around the ID: where a worker states its attributes.
 *  Clamped to the clause containing the ID (text between neighboring IDs),
 *  so one row's labels never leak into another row's verdict. */
function windowAround(text: string, id: string, allIds: string[], radius = 200): string {
  const lower = text.toLowerCase();
  const positions = allIds
    .map((other) => ({ id: other, index: lower.indexOf(other) }))
    .filter((entry) => entry.index !== -1)
    .sort((a, b) => a.index - b.index);
  const current = positions.find((entry) => entry.id === id);
  const at = current ? current.index : lower.indexOf(id);
  if (at === -1) return '';
  const prevEnd = positions
    .filter((entry) => entry.index < at)
    .reduce((end, entry) => Math.max(end, entry.index + entry.id.length), 0);
  const nextStart = positions
    .filter((entry) => entry.index > at)
    .reduce((start, entry) => Math.min(start, entry.index), text.length);
  const start = Math.max(prevEnd, at - radius);
  const end = Math.min(nextStart, at + id.length + radius);
  return text.slice(start, end).toLowerCase();
}

async function lookupRequest(db: QueryableDb, requestId: string): Promise<EvidenceRow | null> {
  const { results } = await db
    .prepare('SELECT request_id, order_type, http_status, release_label FROM quote_events WHERE request_id = ?')
    .bind(requestId)
    .all<EvidenceRow>();
  return results[0] ?? null;
}

async function lookupDeployment(db: QueryableDb, versionId: string): Promise<DeploymentRow | null> {
  const { results } = await db
    .prepare('SELECT version_id, release_label, variant FROM deployments WHERE version_id = ?')
    .bind(versionId)
    .all<DeploymentRow>();
  return results[0] ?? null;
}

function checkRequestRow(id: string, row: EvidenceRow | null, window: string): ClaimVerdict {
  const short = id.slice(0, 8);
  if (!row) {
    return {
      claim: `request ${short} failed`,
      kind: 'request_row',
      status: 'not_found',
      detail: `Request ${id} appears in the conclusion but has no row in quote_events. Treat this row as unsupported.`,
    };
  }
  const claimedOrder = window.includes('standard') ? 'standard' : window.includes('priority') ? 'priority' : null;
  if (claimedOrder && claimedOrder !== row.order_type) {
    return {
      claim: `request ${short} is ${claimedOrder}`,
      kind: 'request_row',
      status: 'contradicted',
      detail: `Conclusion says ${claimedOrder}, store says ${row.order_type} (status ${row.http_status}, release ${row.release_label}).`,
    };
  }
  const claims500 = window.includes('500') || window.includes('5xx') || window.includes('fail');
  if (claims500 && row.http_status !== null && row.http_status < 500) {
    return {
      claim: `request ${short} failed`,
      kind: 'request_row',
      status: 'contradicted',
      detail: `Conclusion presents it as a failure, store says status ${row.http_status}.`,
    };
  }
  return {
    claim: `request ${short} ${row.order_type} ${row.http_status} on ${row.release_label}`,
    kind: 'request_row',
    status: 'verified',
    detail: `Row exists: order_type=${row.order_type}, http_status=${row.http_status}, release=${row.release_label}.`,
  };
}

interface AggregateActual {
  total: number;
  http5xx: number;
  errorRate: number | null;
}

async function actualAggregates(db: QueryableDb): Promise<AggregateActual> {
  const { results } = await db
    .prepare(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN http_status >= 500 THEN 1 ELSE 0 END) AS http5xx, SUM(CASE WHEN http_status IS NULL THEN 1 ELSE 0 END) AS transportUnknown FROM quote_events',
    )
    .bind()
    .all<{ total: number; http5xx: number; transportUnknown: number }>();
  const row = results[0] ?? { total: 0, http5xx: 0, transportUnknown: 0 };
  const completed = row.total - row.transportUnknown;
  return { total: row.total, http5xx: row.http5xx, errorRate: completed > 0 ? row.http5xx / completed : null };
}

function numberNear(pattern: RegExp, text: string): number | null {
  const match = text.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function checkAggregates(text: string, actual: AggregateActual): ClaimVerdict[] {
  const verdicts: ClaimVerdict[] = [];
  const lower = text.toLowerCase();
  const claimedTotal = numberNear(/\|\s*\*{0,2}total requests\*{0,2}\s*\|\s*\*{0,2}(\d+)/, lower);
  if (claimedTotal !== null) {
    verdicts.push(
      claimedTotal === actual.total
        ? { claim: `total requests = ${claimedTotal}`, kind: 'aggregate', status: 'verified', detail: `Matches store count of ${actual.total}.` }
        : { claim: `total requests = ${claimedTotal}`, kind: 'aggregate', status: 'contradicted', detail: `Conclusion says ${claimedTotal}, store holds ${actual.total}.` },
    );
  }
  const claimed5xx =
    numberNear(/\|\s*\*{0,2}http\s*5xx errors\*{0,2}\s*\|\s*\*{0,2}(\d+)/, lower) ??
    numberNear(/\|\s*\*{0,2}http\s*5xx\*{0,2}\s*\|\s*\*{0,2}(\d+)/, lower) ??
    numberNear(/\|\s*\*{0,2}5xx errors\*{0,2}\s*\|\s*\*{0,2}(\d+)/, lower);
  if (claimed5xx !== null) {
    verdicts.push(
      claimed5xx === actual.http5xx
        ? { claim: `HTTP 5xx errors = ${claimed5xx}`, kind: 'aggregate', status: 'verified', detail: `Matches store count of ${actual.http5xx}.` }
        : { claim: `HTTP 5xx errors = ${claimed5xx}`, kind: 'aggregate', status: 'contradicted', detail: `Conclusion says ${claimed5xx}, store holds ${actual.http5xx}.` },
    );
  }
  const claimedRate = numberNear(/error rate\D{0,40}([\d.]+)/, lower);
  if (claimedRate !== null && actual.errorRate !== null) {
    const normalized = claimedRate > 1 ? claimedRate / 100 : claimedRate;
    const close = Math.abs(normalized - actual.errorRate) <= 0.02;
    verdicts.push(
      close
        ? { claim: `error rate ≈ ${claimedRate}`, kind: 'aggregate', status: 'verified', detail: `Within tolerance of store rate ${actual.errorRate.toFixed(3)}.` }
        : { claim: `error rate ≈ ${claimedRate}`, kind: 'aggregate', status: 'contradicted', detail: `Conclusion implies ${normalized.toFixed(3)}, store rate is ${actual.errorRate.toFixed(3)}.` },
    );
  }
  return verdicts;
}

/** Check every mechanical claim in a telemetry conclusion. */
export async function verifyTelemetry(db: QueryableDb, conclusion: string): Promise<ClaimVerdict[]> {
  const text = normalizeText(conclusion);
  const verdicts: ClaimVerdict[] = [];
  const ids = extractIds(text);
  for (const id of ids) {
    const row = await lookupRequest(db, id);
    verdicts.push(checkRequestRow(id, row, windowAround(text, id, ids)));
  }
  verdicts.push(...checkAggregates(text, await actualAggregates(db)));
  return verdicts;
}

/** Check every version quoted in a deployment conclusion. */
export async function verifyDeployment(db: QueryableDb, conclusion: string): Promise<ClaimVerdict[]> {
  const text = normalizeText(conclusion);
  const verdicts: ClaimVerdict[] = [];
  const ids = extractIds(text);
  for (const id of ids) {
    const row = await lookupDeployment(db, id);
    const short = id.slice(0, 8);
    if (!row) {
      verdicts.push({
        claim: `version ${short} deployed`,
        kind: 'deployment',
        status: 'not_found',
        detail: `Version ${id} appears in the conclusion but has no row in deployments.`,
      });
      continue;
    }
    const window = windowAround(text, id, ids);
    const labels = [row.release_label.toLowerCase()];
    const mentionsLabel = labels.some((label) => window.includes(label));
    // A wrong label nearby contradicts; no label nearby means nothing claimed.
    const labelLike = window.match(/healthy-\d+|broken-\d+/);
    if (labelLike && !mentionsLabel) {
      verdicts.push({
        claim: `version ${short} is ${labelLike[0]}`,
        kind: 'deployment',
        status: 'contradicted',
        detail: `Conclusion places it near ${labelLike[0]}, store says ${row.release_label}.`,
      });
    } else {
      verdicts.push({
        claim: `version ${short} (${row.release_label}) deployed`,
        kind: 'deployment',
        status: 'verified',
        detail: `Version exists: release=${row.release_label}, variant=${row.variant}.`,
      });
    }
  }
  return verdicts;
}

/** Share of checked claims that verified. Null when nothing was checkable. */
export function confidenceOf(verdicts: ClaimVerdict[]): number | null {
  const checked = verdicts.filter((v) => v.status !== 'uncheckable');
  if (checked.length === 0) return null;
  const verified = checked.filter((v) => v.status === 'verified').length;
  return verified / checked.length;
}

export interface Assessment {
  known: string[];
  uncertain: string[];
  next: string[];
}

export interface WorkerVerdicts {
  workerKey: string;
  taskId: string;
  agentId: string;
  verdicts: ClaimVerdict[];
  confidence: number | null;
}

/** Merge per-worker verdicts into one assessment. Uncertain claims are kept
 *  and labeled, never silently dropped. */
export function buildAssessment(workers: WorkerVerdicts[]): Assessment {
  const known: string[] = [];
  const uncertain: string[] = [];
  for (const worker of workers) {
    for (const verdict of worker.verdicts) {
      if (verdict.status === 'verified') {
        known.push(`[${worker.workerKey}] ${verdict.claim}.`);
      } else if (verdict.status === 'contradicted' || verdict.status === 'not_found') {
        uncertain.push(`[${worker.workerKey}] UNCERTAIN: ${verdict.claim} — ${verdict.detail}`);
      }
    }
  }
  const next: string[] = [];
  const unsupported = workers.reduce(
    (count, worker) => count + worker.verdicts.filter((v) => v.status !== 'verified' && v.status !== 'uncheckable').length,
    0,
  );
  if (unsupported > 0) {
    next.push(
      `Treat ${unsupported} worker claim${unsupported === 1 ? '' : 's'} as unsupported and re-query the evidence tables before acting on ${unsupported === 1 ? 'it' : 'them'}.`,
    );
  }
  const failingVerified = workers.some((worker) =>
    worker.verdicts.some((v) => v.status === 'verified' && v.kind === 'request_row'),
  );
  if (failingVerified) {
    next.push('Correlate the verified failing requests with the deployment timeline to identify the responsible release.');
  }
  const checkedAny = workers.some((worker) => worker.verdicts.length > 0);
  const checkedRows = workers.some((worker) => worker.verdicts.some((v) => v.kind === 'request_row'));
  if (checkedAny && !checkedRows) {
    next.push('No request-level IDs were extractable from the conclusions; confirm failing request rows manually against quote_events.');
  }
  if (known.length === 0 && uncertain.length === 0) {
    next.push('No mechanical claims were checkable; verify the conclusions manually against the evidence tables.');
  }
  return { known, uncertain, next };
}
