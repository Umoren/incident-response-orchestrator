-- Day 4: coordination state. Applied on top of schema.sql to the existing
-- incident-evidence database. Run it the same way:
-- npx wrangler d1 execute incident-evidence --remote --file=../../infra/d1/migrate-day04.sql

-- One row per incident. dedupe_key is unique: the same alert arriving twice
-- resolves to the same row instead of starting a second investigation.
CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'awaiting_approval', 'resolved', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per investigation attempt on an incident.
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
  kind TEXT NOT NULL DEFAULT 'investigation',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  created_at TEXT NOT NULL,
  finished_at TEXT
);

-- One row per agent: the parent and each worker. status follows
-- queued -> running -> succeeded | failed | timed_out | cancelled.
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  role TEXT NOT NULL CHECK (role IN ('parent', 'worker')),
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')),
  parent_agent_id TEXT REFERENCES agents(agent_id),
  steps_used INTEGER,
  conclusion TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

-- Every tool call any agent makes: what was asked, what came back.
-- This is the worker's method, kept outside the parent's conversation.
CREATE TABLE IF NOT EXISTS agent_tool_calls (
  call_id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  step INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  ok INTEGER NOT NULL,
  output_json TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_run ON agents(run_id);
CREATE INDEX IF NOT EXISTS idx_calls_agent ON agent_tool_calls(agent_id);
