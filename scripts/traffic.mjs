// Send the same mix on every cycle: three standard orders and two priority orders.
const baseUrl = process.argv[2];
const cycles = Number(process.argv[3] ?? 30);
const intervalMs = Number(process.argv[4] ?? 1000);

const recordPath = process.argv[5];

if (!baseUrl || !Number.isInteger(cycles) || cycles < 1 || !Number.isInteger(intervalMs) || intervalMs < 0) {
  console.error('Usage: node scripts/traffic.mjs SERVICE_URL [cycles=30] [intervalMs=1000] [record.sql]');
  process.exit(1);
}

const types = ['standard', 'priority', 'standard', 'priority', 'standard'];
const counts = { success: 0, http5xx: 0, otherHttp: 0, transportErrors: 0 };
const rows = [];
let consecutiveHighErrorCycles = 0;
let alerted = false;

const sqlString = (value) => value === null || value === undefined
  ? 'NULL'
  : `'${String(value).replaceAll("'", "''")}'`;

for (let cycle = 1; cycle <= cycles; cycle++) {
  let received = 0;
  let serverErrors = 0;
  for (const type of types) {
    try {
      const url = new URL('/quote', baseUrl);
      url.search = new URLSearchParams({ type, quantity: '2' }).toString();
      const occurredAt = new Date().toISOString();
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      received++;
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const row = {
        occurred_at: occurredAt,
        request_id: body !== null && typeof body.requestId === 'string' ? body.requestId : null,
        order_type: type,
        quantity: 2,
        http_status: response.status,
        release_label: body !== null && typeof body.release === 'string' ? body.release : null,
        error_text: body !== null && typeof body.error === 'string' ? body.error : null,
        transport_error: null,
      };
      rows.push(row);
      if (response.status >= 500) {
        counts.http5xx++;
        serverErrors++;
      } else if (response.ok) {
        counts.success++;
      } else {
        counts.otherHttp++;
      }
      console.log(JSON.stringify({ cycle, type, status: response.status }));
    } catch (error) {
      counts.transportErrors++;
      rows.push({
        occurred_at: new Date().toISOString(),
        request_id: null,
        order_type: type,
        quantity: 2,
        http_status: null,
        release_label: null,
        error_text: null,
        transport_error: String(error),
      });
      console.error(JSON.stringify({
        cycle, type, error: String(error),
        cause: error instanceof Error && error.cause ? String(error.cause) : undefined,
      }));
    }
  }
  const errorRate = received === 0 ? null : serverErrors / received;
  consecutiveHighErrorCycles = errorRate !== null && received === types.length && errorRate >= 0.2
    ? consecutiveHighErrorCycles + 1
    : 0;
  console.log(JSON.stringify({ event: 'traffic.cycle', cycle, received, serverErrors, errorRate }));
  if (!alerted && consecutiveHighErrorCycles >= 2) {
    alerted = true;
    console.log(JSON.stringify({
      event: 'synthetic.alert', reason: 'HTTP 5xx rate >= 20% for two complete traffic cycles',
      cycle, errorRate,
    }));
  }
  if (cycle < cycles) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

console.log(JSON.stringify({ event: 'traffic.finished', ...counts }));

if (recordPath) {
  const { writeFileSync } = await import('node:fs');
  const statements = rows.map((row) => (
    `INSERT INTO quote_events (occurred_at, request_id, order_type, quantity, http_status, release_label, error_text, transport_error) VALUES (${sqlString(row.occurred_at)}, ${sqlString(row.request_id)}, ${sqlString(row.order_type)}, 2, ${row.http_status ?? 'NULL'}, ${sqlString(row.release_label)}, ${sqlString(row.error_text)}, ${sqlString(row.transport_error)});`
  ));
  writeFileSync(recordPath, `${statements.join('\n')}\n`);
  console.log(JSON.stringify({ event: 'traffic.recorded', path: recordPath, rows: rows.length }));
}
