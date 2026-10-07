import type * as Sqlite from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { ConfigurationError } from './errors';
import { errorMessage } from './log';
import { type Assignment, assignmentSchema, type ReasonCode } from './schemas';

/**
 * The controller's local state, in one SQLite file: who it is, the last
 * assignment it pulled, what it applied for each agent, where each agent's
 * events resume, the relay's port, and the status sequence. Everything except
 * the identity can be rebuilt from the server; the credential itself is in
 * the secret store, never here.
 */

export type Identity = {
  controllerId: string;
  server: string;
  name: string;
  enrolledAt: string;
};

export type CachedAssignment =
  | { kind: 'none' }
  | { kind: 'saved'; assignment: Assignment; etag: string | null }
  | { kind: 'unreadable'; detail: string };

export type AgentRow = {
  agentId: string;
  appliedRevision: number | null;
  /** When the controller last started, restarted or stopped it. */
  changedAt: string;
  /** A failure applying a revision locally, before any process ran. */
  failure: { revision: number; reason: ReasonCode; detail: string } | null;
};

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE assignment (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     revision INTEGER NOT NULL,
     etag TEXT,
     body TEXT NOT NULL,
     fetched_at TEXT NOT NULL
   );
   CREATE TABLE agents (
     agent_id TEXT PRIMARY KEY,
     applied_revision INTEGER,
     changed_at TEXT NOT NULL,
     failure_revision INTEGER,
     failure_reason TEXT,
     failure_detail TEXT,
     credentials_stale INTEGER NOT NULL DEFAULT 0,
     credentials_refetched_at TEXT
   );
   CREATE TABLE restarts (agent_id TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX restarts_by_agent ON restarts (agent_id, at);`,
  // Agents hold no Switch key, so nothing tracks fetching one; where each
  // agent's events resume is kept instead.
  `ALTER TABLE agents DROP COLUMN credentials_stale;
   ALTER TABLE agents DROP COLUMN credentials_refetched_at;
   CREATE TABLE agent_cursors (
     agent_id TEXT PRIMARY KEY,
     cursor INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   );`,
];

export const STORE_SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Node 22 announces node:sqlite as experimental on first load. That one
 * warning is dropped here, where the module is loaded; every other warning
 * passes through untouched.
 */
function loadSqlite(): typeof Sqlite {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string })?.type;
    if (type === 'ExperimentalWarning' && text.startsWith('SQLite is an experimental feature'))
      return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule('node:sqlite') as typeof Sqlite;
  } finally {
    process.emitWarning = emitWarning;
  }
}

type Row = Record<string, unknown>;

export class ControllerStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): ControllerStore {
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      migrate(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return new ControllerStore(db);
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
  }

  identity(): Identity | null {
    const controllerId = this.meta('controller_id');
    if (!controllerId) return null;
    return {
      controllerId,
      server: this.requireMeta('server'),
      name: this.requireMeta('name'),
      enrolledAt: this.requireMeta('enrolled_at'),
    };
  }

  saveIdentity(identity: Identity): void {
    this.transaction(() => {
      this.setMeta('controller_id', identity.controllerId);
      this.setMeta('server', identity.server);
      this.setMeta('name', identity.name);
      this.setMeta('enrolled_at', identity.enrolledAt);
      this.db.prepare("DELETE FROM meta WHERE key = 'revoked_at'").run();
    });
  }

  /** Records the name the server now has for this controller. */
  saveName(name: string): void {
    if (!this.meta('controller_id'))
      throw new Error('There is no identity whose name could be changed.');
    this.setMeta('name', name);
  }

  /** Moves the identity to another server URL, keeping everything else. */
  saveServer(server: string): void {
    if (!this.meta('controller_id'))
      throw new Error('There is no identity whose server could be changed.');
    this.setMeta('server', server);
  }

  revokedAt(): string | null {
    return this.meta('revoked_at');
  }

  markRevoked(at: string): void {
    this.setMeta('revoked_at', at);
  }

  /**
   * The assignment last pulled. One saved by an earlier version that this one
   * no longer reads (a definition field was added since) is `unreadable`, with
   * why; the caller discards it and pulls a fresh copy.
   */
  cachedAssignment(): CachedAssignment {
    const row = this.db.prepare('SELECT etag, body FROM assignment WHERE id = 1').get() as
      | Row
      | undefined;
    if (!row) return { kind: 'none' };
    let body: unknown;
    try {
      body = JSON.parse(String(row.body));
    } catch (error) {
      return { kind: 'unreadable', detail: errorMessage(error) };
    }
    const parsed = assignmentSchema.safeParse(body);
    if (!parsed.success) return { kind: 'unreadable', detail: parsed.error.message };
    return {
      kind: 'saved',
      assignment: parsed.data,
      etag: row.etag === null ? null : String(row.etag),
    };
  }

  discardAssignment(): void {
    this.db.prepare('DELETE FROM assignment WHERE id = 1').run();
  }

  saveAssignment(assignment: Assignment, etag: string | null, at: string): void {
    this.db
      .prepare(
        `INSERT INTO assignment (id, revision, etag, body, fetched_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, etag = excluded.etag,
           body = excluded.body, fetched_at = excluded.fetched_at`
      )
      .run(assignment.revision, etag, JSON.stringify(assignment), at);
  }

  agent(agentId: string): AgentRow | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as
      | Row
      | undefined;
    return row ? toAgentRow(row) : null;
  }

  agents(): AgentRow[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY agent_id').all() as Row[]).map(
      toAgentRow
    );
  }

  /** The revision is now what runs (or, for a stopped agent, what is stopped). */
  recordApplied(agentId: string, revision: number, at: string): void {
    this.db
      .prepare(
        `INSERT INTO agents (agent_id, applied_revision, changed_at) VALUES (?, ?, ?)
         ON CONFLICT (agent_id) DO UPDATE SET applied_revision = excluded.applied_revision,
           changed_at = excluded.changed_at, failure_revision = NULL, failure_reason = NULL,
           failure_detail = NULL`
      )
      .run(agentId, revision, at);
  }

  recordFailure(
    agentId: string,
    failure: { revision: number; reason: ReasonCode; detail: string },
    at: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO agents (agent_id, applied_revision, changed_at, failure_revision,
           failure_reason, failure_detail) VALUES (?, NULL, ?, ?, ?, ?)
         ON CONFLICT (agent_id) DO UPDATE SET changed_at = excluded.changed_at,
           failure_revision = excluded.failure_revision, failure_reason = excluded.failure_reason,
           failure_detail = excluded.failure_detail`
      )
      .run(agentId, at, failure.revision, failure.reason, failure.detail);
  }

  deleteAgent(agentId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM agents WHERE agent_id = ?').run(agentId);
      this.db.prepare('DELETE FROM restarts WHERE agent_id = ?').run(agentId);
      this.db.prepare('DELETE FROM agent_cursors WHERE agent_id = ?').run(agentId);
    });
  }

  /**
   * Where each agent's events resume on the controller stream: the last
   * sequence its watcher confirmed reading.
   */
  cursors(): Map<string, number> {
    const rows = this.db.prepare('SELECT agent_id, cursor FROM agent_cursors').all() as Row[];
    return new Map(rows.map((row) => [String(row.agent_id), Number(row.cursor)]));
  }

  saveCursor(agentId: string, cursor: number, at: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_cursors (agent_id, cursor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (agent_id) DO UPDATE SET cursor = excluded.cursor,
           updated_at = excluded.updated_at`
      )
      .run(agentId, cursor, at);
  }

  /** The loopback port the relay last listened on, which running watchers were given. */
  relayPort(): number | null {
    const value = this.meta('relay_port');
    return value === null ? null : Number(value);
  }

  saveRelayPort(port: number): void {
    this.setMeta('relay_port', String(port));
  }

  recordRestart(agentId: string, atMs: number): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO restarts (agent_id, at) VALUES (?, ?)').run(agentId, atMs);
      // Only the last ten minutes are ever asked about.
      this.db.prepare('DELETE FROM restarts WHERE at < ?').run(atMs - 60 * 60 * 1000);
    });
  }

  restartsSince(agentId: string, sinceMs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM restarts WHERE agent_id = ? AND at >= ?')
      .get(agentId, sinceMs) as Row;
    return Number(row.n);
  }

  /**
   * The next status `seq`. Never below the clock in milliseconds, so a data
   * directory rebuilt from scratch still sends numbers above the last one the
   * server accepted, rather than being ignored until it catches up.
   */
  nextStatusSeq(nowMs: number): number {
    return this.transaction(() => {
      const previous = Number(this.meta('status_seq') ?? '0');
      const next = Math.max(previous + 1, Math.floor(nowMs));
      this.setMeta('status_seq', String(next));
      return next;
    });
  }

  private meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  private requireMeta(key: string): string {
    const value = this.meta(key);
    if (value === null) throw new Error(`The controller store is missing '${key}'.`);
    return value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
  }

  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
  if (current > MIGRATIONS.length)
    throw new ConfigurationError(
      `The controller store is at schema version ${current}, newer than this controller understands (${MIGRATIONS.length}). Run a newer controller, or move the data directory aside to start again.`
    );
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function toAgentRow(row: Row): AgentRow {
  return {
    agentId: String(row.agent_id),
    appliedRevision: row.applied_revision === null ? null : Number(row.applied_revision),
    changedAt: String(row.changed_at),
    failure:
      row.failure_reason === null
        ? null
        : {
            revision: Number(row.failure_revision),
            reason: String(row.failure_reason) as ReasonCode,
            detail: String(row.failure_detail ?? ''),
          },
  };
}
