-- Day 4 follow-up: make the assigned work separate from the agent attempt.
-- Apply once after migrate-day04.sql.

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  task_key TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (run_id, task_key)
);

ALTER TABLE agents ADD COLUMN task_id TEXT REFERENCES tasks(task_id);

CREATE INDEX idx_tasks_run ON tasks(run_id);
CREATE INDEX idx_agents_task ON agents(task_id);
