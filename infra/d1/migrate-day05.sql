-- Day 5: verification state. Apply once, after migrate-day04-task-ids.sql.

-- One row per checked claim: what was claimed, how it was checked, the verdict.
CREATE TABLE claim_verdicts (
  verdict_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  worker_key TEXT NOT NULL,
  claim TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request_row', 'aggregate', 'deployment')),
  status TEXT NOT NULL CHECK (status IN ('verified', 'contradicted', 'not_found', 'uncheckable')),
  detail TEXT,
  created_at TEXT NOT NULL
);

-- The merged result: confidence over checked claims, assessment as JSON.
ALTER TABLE runs ADD COLUMN confidence REAL;
ALTER TABLE runs ADD COLUMN assessment_json TEXT;

CREATE INDEX IF NOT EXISTS idx_verdicts_run ON claim_verdicts(run_id);
