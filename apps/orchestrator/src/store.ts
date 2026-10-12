// State keeper. Every fact about an investigation — which incident, which
// run, which agents, what state each is in, what tools they called — goes
// through this interface. Production uses the D1 version. Tests use the
// memory version. Same rules, no database needed.

export type AgentState = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
export type RunState = 'running' | 'succeeded' | 'partial' | 'failed';

export interface IncidentRow {
  incident_id: string;
  dedupe_key: string;
  objective: string;
  status: string;
}

export interface AgentRow {
  agent_id: string;
  run_id: string;
  task_id: string | null;
  role: 'parent' | 'worker';
  task: string;
  status: AgentState;
  parent_agent_id: string | null;
  steps_used: number | null;
  conclusion: string | null;
}

export interface TaskRow {
  task_id: string;
  run_id: string;
  task_key: string;
  description: string;
  status: AgentState;
}

export interface ToolCallRow {
  agent_id: string;
  step: number;
  tool_name: string;
  args_json: string;
  ok: boolean;
  output_json: string | null;
  error_text: string | null;
}

export interface IncidentStore {
  findIncidentByDedupe(dedupeKey: string): Promise<IncidentRow | null>;
  createIncident(incidentId: string, dedupeKey: string, objective: string, now: string): Promise<void>;
  createRun(runId: string, incidentId: string, now: string): Promise<void>;
  finishRun(runId: string, status: RunState, now: string): Promise<void>;
  createTask(task: Omit<TaskRow, 'status'>, now: string): Promise<void>;
  setTaskState(taskId: string, status: AgentState, now: string): Promise<void>;
  finishTask(taskId: string, status: AgentState, now: string): Promise<void>;
  createAgent(agent: Omit<AgentRow, 'status' | 'steps_used' | 'conclusion'>, now: string): Promise<void>;
  setAgentState(agentId: string, status: AgentState, now: string): Promise<void>;
  finishAgent(agentId: string, status: AgentState, stepsUsed: number | null, conclusion: string | null, now: string): Promise<void>;
  recordToolCall(call: ToolCallRow, now: string): Promise<void>;
  listTasks(runId: string): Promise<TaskRow[]>;
  listAgents(runId: string): Promise<AgentRow[]>;
}

// D1 version. Only INSERT, UPDATE, and SELECT — state moves forward by
// writing new facts, never by editing history.
export interface DbExecutor {
  prepare(query: string): {
    bind(...params: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

export class D1IncidentStore implements IncidentStore {
  constructor(private db: DbExecutor) {}

  async findIncidentByDedupe(dedupeKey: string): Promise<IncidentRow | null> {
    const { results } = await this.db
      .prepare('SELECT incident_id, dedupe_key, objective, status FROM incidents WHERE dedupe_key = ?')
      .bind(dedupeKey)
      .all<IncidentRow>();
    return results[0] ?? null;
  }

  async createIncident(incidentId: string, dedupeKey: string, objective: string, now: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO incidents (incident_id, dedupe_key, objective, status, created_at, updated_at) VALUES (?, ?, ?, 'investigating', ?, ?)")
      .bind(incidentId, dedupeKey, objective, now, now)
      .run();
  }

  async createRun(runId: string, incidentId: string, now: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO runs (run_id, incident_id, kind, status, created_at) VALUES (?, ?, 'investigation', 'running', ?)")
      .bind(runId, incidentId, now)
      .run();
  }

  async finishRun(runId: string, status: RunState, now: string): Promise<void> {
    await this.db
      .prepare('UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ?')
      .bind(status, now, runId)
      .run();
  }

  async createTask(task: Omit<TaskRow, 'status'>, now: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO tasks (task_id, run_id, task_key, description, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
      .bind(task.task_id, task.run_id, task.task_key, task.description, now)
      .run();
  }

  async setTaskState(taskId: string, status: AgentState, now: string): Promise<void> {
    await this.db
      .prepare('UPDATE tasks SET status = ?, started_at = COALESCE(started_at, ?) WHERE task_id = ?')
      .bind(status, now, taskId)
      .run();
  }

  async finishTask(taskId: string, status: AgentState, now: string): Promise<void> {
    await this.db
      .prepare('UPDATE tasks SET status = ?, finished_at = ? WHERE task_id = ?')
      .bind(status, now, taskId)
      .run();
  }

  async createAgent(agent: Omit<AgentRow, 'status' | 'steps_used' | 'conclusion'>, now: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO agents (agent_id, run_id, task_id, role, task, status, parent_agent_id, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)")
      .bind(agent.agent_id, agent.run_id, agent.task_id, agent.role, agent.task, agent.parent_agent_id, now)
      .run();
  }

  async setAgentState(agentId: string, status: AgentState, now: string): Promise<void> {
    await this.db
      .prepare('UPDATE agents SET status = ? WHERE agent_id = ?')
      .bind(status, agentId)
      .run();
    void now;
  }

  async finishAgent(agentId: string, status: AgentState, stepsUsed: number | null, conclusion: string | null, now: string): Promise<void> {
    await this.db
      .prepare('UPDATE agents SET status = ?, steps_used = ?, conclusion = ?, finished_at = ? WHERE agent_id = ?')
      .bind(status, stepsUsed, conclusion, now, agentId)
      .run();
  }

  async recordToolCall(call: ToolCallRow, now: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO agent_tool_calls (agent_id, step, tool_name, args_json, ok, output_json, error_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(call.agent_id, call.step, call.tool_name, call.args_json, call.ok ? 1 : 0, call.output_json, call.error_text, now)
      .run();
  }

  async listAgents(runId: string): Promise<AgentRow[]> {
    const { results } = await this.db
      .prepare('SELECT agent_id, run_id, task_id, role, task, status, parent_agent_id, steps_used, conclusion FROM agents WHERE run_id = ?')
      .bind(runId)
      .all<AgentRow>();
    return results;
  }

  async listTasks(runId: string): Promise<TaskRow[]> {
    const { results } = await this.db
      .prepare('SELECT task_id, run_id, task_key, description, status FROM tasks WHERE run_id = ?')
      .bind(runId)
      .all<TaskRow>();
    return results;
  }
}

// Memory version for tests. Same rules, no database.
export class MemoryIncidentStore implements IncidentStore {
  incidents = new Map<string, IncidentRow>();
  runs = new Map<string, { run_id: string; incident_id: string; status: RunState }>();
  tasks = new Map<string, TaskRow>();
  agents = new Map<string, AgentRow>();
  toolCalls: Array<ToolCallRow & { created_at: string }> = [];

  async findIncidentByDedupe(dedupeKey: string): Promise<IncidentRow | null> {
    for (const incident of this.incidents.values()) {
      if (incident.dedupe_key === dedupeKey) return incident;
    }
    return null;
  }

  async createIncident(incidentId: string, dedupeKey: string, objective: string): Promise<void> {
    this.incidents.set(incidentId, { incident_id: incidentId, dedupe_key: dedupeKey, objective, status: 'investigating' });
  }

  async createRun(runId: string, incidentId: string): Promise<void> {
    this.runs.set(runId, { run_id: runId, incident_id: incidentId, status: 'running' });
  }

  async finishRun(runId: string, status: RunState): Promise<void> {
    const run = this.runs.get(runId);
    if (run) run.status = status;
  }

  async createTask(task: Omit<TaskRow, 'status'>): Promise<void> {
    this.tasks.set(task.task_id, { ...task, status: 'queued' });
  }

  async setTaskState(taskId: string, status: AgentState): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) task.status = status;
  }

  async finishTask(taskId: string, status: AgentState): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) task.status = status;
  }

  async createAgent(agent: Omit<AgentRow, 'status' | 'steps_used' | 'conclusion'>): Promise<void> {
    this.agents.set(agent.agent_id, { ...agent, status: 'queued', steps_used: null, conclusion: null });
  }

  async setAgentState(agentId: string, status: AgentState): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) agent.status = status;
  }

  async finishAgent(agentId: string, status: AgentState, stepsUsed: number | null, conclusion: string | null): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.status = status;
      agent.steps_used = stepsUsed;
      agent.conclusion = conclusion;
    }
  }

  async recordToolCall(call: ToolCallRow, now: string): Promise<void> {
    this.toolCalls.push({ ...call, created_at: now });
  }

  async listAgents(runId: string): Promise<AgentRow[]> {
    return [...this.agents.values()].filter((agent) => agent.run_id === runId);
  }

  async listTasks(runId: string): Promise<TaskRow[]> {
    return [...this.tasks.values()].filter((task) => task.run_id === runId);
  }
}
