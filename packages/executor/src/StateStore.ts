import Database from 'better-sqlite3';
import { prepareStatePath } from './statePath.js';
import type { AgentIdentity, AgentTask, AgentEvent } from './types.js';

type AgentRow = { id: string; name: string; role: string; address: string | null; parent_agent_id: string | null; created_at: number };
type TaskRow = { id: string; agent_id: string; description: string; status: AgentTask['status']; priority: number; created_at: number; started_at: number | null; ended_at: number | null; result: string | null; error: string | null };
type EventRow = { event_id: string; type: AgentEvent['type']; agent_id: string; task_id: string | null; timestamp: number; payload: string };

/**
 * Persistent state store using SQLite.
 * Survives process restarts via database tables.
 */
export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(prepareStatePath(dbPath));
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
  }

  private initializeSchema(): void {
    // Create tables with IF NOT EXISTS
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        address TEXT,
        parent_agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER DEFAULT 5,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        result TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        event_id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        task_id TEXT,
        timestamp INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS executor_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    `);
  }

  saveAgent(agent: AgentIdentity): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO agents (id, name, role, status, address, parent_agent_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        agent.agentId,
        agent.name,
        agent.role,
        'idle',
        agent.address ?? null,
        agent.parentAgentId ?? null,
        agent.createdAt,
        Date.now(),
      );
    } catch {
      console.error('[StateStore] Failed to save agent:');
    }
  }

  saveTask(task: AgentTask): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO tasks (id, agent_id, description, status, priority, created_at, started_at, ended_at, result, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        task.taskId,
        task.agentId,
        task.description,
        task.status,
        task.priority ?? 5,
        task.createdAt,
        task.startedAt ?? null,
        task.endedAt ?? null,
        task.result ?? null,
        task.error ?? null,
      );
    } catch {
      console.error('[StateStore] Failed to save task:');
    }
  }

  saveEvent(event: AgentEvent): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO events (id, event_id, type, agent_id, task_id, timestamp, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        `evt_${event.eventId}`,
        event.eventId,
        event.type,
        event.agentId,
        event.taskId ?? null,
        event.timestamp,
        JSON.stringify(event.payload),
      );
    } catch {
      console.error('[StateStore] Failed to save event:');
    }
  }

  loadActiveAgents(): AgentIdentity[] {
    try {
      const stmt = this.db.prepare<[], AgentRow>(`
        SELECT id, name, role, address, parent_agent_id, created_at
        FROM agents
        WHERE status != 'shutdown'
        ORDER BY created_at DESC
      `);
      const rows = stmt.all();
      return rows.map((row) => ({
        agentId: row.id,
        name: row.name,
        role: row.role,
        address: row.address || undefined,
        parentAgentId: row.parent_agent_id || undefined,
        createdAt: row.created_at,
      }));
    } catch {
      console.error('[StateStore] Failed to load active agents:');
      return [];
    }
  }

  loadActiveTasks(): AgentTask[] {
    try {
      const stmt = this.db.prepare<[], TaskRow>(`
        SELECT id, agent_id, description, status, priority, created_at, started_at, ended_at, result, error
        FROM tasks
        WHERE status IN ('queued', 'in-progress')
        ORDER BY priority ASC, created_at ASC
      `);
      const rows = stmt.all();
      return rows.map((row) => ({
        taskId: row.id,
        agentId: row.agent_id,
        description: row.description,
        status: row.status,
        priority: row.priority,
        createdAt: row.created_at,
        startedAt: row.started_at || undefined,
        endedAt: row.ended_at || undefined,
        result: row.result || undefined,
        error: row.error || undefined,
      }));
    } catch {
      console.error('[StateStore] Failed to load active tasks:');
      return [];
    }
  }

  loadRecentEvents(limit: number = 100): AgentEvent[] {
    try {
      const stmt = this.db.prepare<[number], EventRow>(`
        SELECT event_id, type, agent_id, task_id, timestamp, payload
        FROM events
        ORDER BY timestamp DESC
        LIMIT ?
      `);
      const rows = stmt.all(limit);
      return rows.reverse().map((row) => ({
        eventId: row.event_id,
        type: row.type,
        agentId: row.agent_id,
        taskId: row.task_id || undefined,
        timestamp: row.timestamp,
        payload: JSON.parse(row.payload) as AgentEvent['payload'],
      }));
    } catch {
      console.error('[StateStore] Failed to load recent events:');
      return [];
    }
  }

  getStats(): { totalTasks: number; totalEvents: number; uptime: number } {
    try {
      const taskCount = this.db.prepare<[], { count: number }>('SELECT COUNT(*) as count FROM tasks').get()?.count ?? 0;
      const eventCount = this.db.prepare<[], { count: number }>('SELECT COUNT(*) as count FROM events').get()?.count ?? 0;

      const startTime = this.getMeta('start_time');
      const uptime = startTime ? Date.now() - parseInt(startTime, 10) : 0;

      return { totalTasks: taskCount, totalEvents: eventCount, uptime };
    } catch {
      console.error('[StateStore] Failed to get stats:');
      return { totalTasks: 0, totalEvents: 0, uptime: 0 };
    }
  }

  setMeta(key: string, value: string): void {
    try {
      const stmt = this.db.prepare('INSERT OR REPLACE INTO executor_meta (key, value) VALUES (?, ?)');
      stmt.run(key, value);
    } catch {
      console.error('[StateStore] Failed to set meta:');
    }
  }

  getMeta(key: string): string | null {
    try {
      const stmt = this.db.prepare('SELECT value FROM executor_meta WHERE key = ?');
      const row = stmt.get(key) as { value: string } | undefined;
      return row ? row.value : null;
    } catch {
      console.error('[StateStore] Failed to get meta:');
      return null;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      console.error('[StateStore] Failed to close database:');
    }
  }
}
