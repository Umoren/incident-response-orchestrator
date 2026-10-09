-- Evidence store for the incident response orchestrator (Day 2 groundwork).
-- quote_events holds one row per attempted quote request from the traffic script.
-- deployments holds one row per Worker deployment, recorded by hand after each deploy.
-- Agent tools read these tables. Workers Logs remain the human cross-check.

CREATE TABLE IF NOT EXISTS deployments (
  version_id TEXT PRIMARY KEY,
  release_label TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('healthy', 'broken')),
  deployed_at TEXT NOT NULL,
  traffic_percent INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS quote_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  request_id TEXT,
  order_type TEXT NOT NULL CHECK (order_type IN ('standard', 'priority')),
  quantity INTEGER NOT NULL,
  http_status INTEGER,
  release_label TEXT,
  error_text TEXT,
  transport_error TEXT,
  source TEXT NOT NULL DEFAULT 'traffic-script'
);

CREATE INDEX IF NOT EXISTS idx_quote_events_occurred_at ON quote_events (occurred_at);
CREATE INDEX IF NOT EXISTS idx_quote_events_status ON quote_events (http_status);
