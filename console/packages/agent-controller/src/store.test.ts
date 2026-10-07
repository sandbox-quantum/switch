import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Sqlite from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from './errors';
import { ControllerStore, STORE_SCHEMA_VERSION } from './store';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-store-'));
  path = join(dir, 'controller.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const assignment = {
  revision: 3,
  agents: [
    {
      agent_id: 'agent-1',
      revision: 2,
      desired_state: 'running' as const,
      definition: {
        name: 'scout',
        display_name: null,
        icon_url: null,
        provider: 'claude',
        model: null,
        advanced_config: {},
        instructions: '',
        auto_approve: false,
        directory: null,
        isolation: 'shared' as const,
      },
    },
  ],
};

describe('ControllerStore', () => {
  it('migrates a new file to the current schema version', () => {
    const store = ControllerStore.open(path);
    expect(store.schemaVersion()).toBe(STORE_SCHEMA_VERSION);
    store.close();
  });

  it('refuses a file written by a newer controller', () => {
    const store = ControllerStore.open(path);
    store.close();
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof Sqlite;
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => ControllerStore.open(path)).toThrow(/newer than this controller understands/);
    expect(() => ControllerStore.open(path)).toThrow(ConfigurationError);
  });

  it('keeps the identity across reopening, and clears a revocation on re-enrollment', () => {
    const store = ControllerStore.open(path);
    expect(store.identity()).toBeNull();
    const identity = {
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'build-box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    };
    store.saveIdentity(identity);
    store.markRevoked('2026-01-02T00:00:00.000Z');
    store.close();
    const reopened = ControllerStore.open(path);
    expect(reopened.identity()).toEqual(identity);
    expect(reopened.revokedAt()).toBe('2026-01-02T00:00:00.000Z');
    reopened.saveIdentity({ ...identity, controllerId: 'controller-2' });
    expect(reopened.revokedAt()).toBeNull();
    reopened.close();
  });

  it('moves the identity to another server URL and keeps the rest', () => {
    const store = ControllerStore.open(path);
    expect(() => store.saveServer('https://moved.example.com')).toThrow(/no identity/);
    const identity = {
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'build-box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    };
    store.saveIdentity(identity);
    store.saveAssignment(assignment, '"etag-1"', '2026-01-01T00:00:00.000Z');
    store.saveServer('https://moved.example.com');
    expect(store.identity()).toEqual({ ...identity, server: 'https://moved.example.com' });
    expect(store.cachedAssignment()).toMatchObject({ kind: 'saved', etag: '"etag-1"' });
    store.close();
  });

  it('records a new name for the identity and keeps the rest', () => {
    const store = ControllerStore.open(path);
    expect(() => store.saveName('renamed')).toThrow(/no identity/);
    const identity = {
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'build-box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    };
    store.saveIdentity(identity);
    store.saveName('renamed');
    expect(store.identity()).toEqual({ ...identity, name: 'renamed' });
    store.close();
  });

  it('caches the assignment with its ETag', () => {
    const store = ControllerStore.open(path);
    expect(store.cachedAssignment()).toEqual({ kind: 'none' });
    store.saveAssignment(assignment, '"3"', '2026-01-01T00:00:00.000Z');
    expect(store.cachedAssignment()).toEqual({ kind: 'saved', assignment, etag: '"3"' });
    store.saveAssignment({ revision: 4, agents: [] }, null, '2026-01-01T00:00:01.000Z');
    expect(store.cachedAssignment()).toEqual({
      kind: 'saved',
      assignment: { revision: 4, agents: [] },
      etag: null,
    });
    store.close();
  });

  it('says an assignment saved by an earlier version is unreadable, and discards it', () => {
    const store = ControllerStore.open(path);
    const [entry] = assignment.agents;
    const { advanced_config: _dropped, ...earlier } = entry!.definition;
    store.saveAssignment(
      { revision: 5, agents: [{ ...entry!, definition: earlier }] } as unknown as Parameters<
        typeof store.saveAssignment
      >[0],
      '"5"',
      '2026-01-01T00:00:00.000Z'
    );
    const cached = store.cachedAssignment();
    expect(cached.kind).toBe('unreadable');
    expect(cached.kind === 'unreadable' && cached.detail).toContain('advanced_config');
    store.discardAssignment();
    expect(store.cachedAssignment()).toEqual({ kind: 'none' });
    store.close();
  });

  it('records applied revisions and local failures per agent', () => {
    const store = ControllerStore.open(path);
    store.recordFailure(
      'agent-1',
      { revision: 1, reason: 'provider_not_installed', detail: 'no claude' },
      '2026-01-01T00:00:00.000Z'
    );
    expect(store.agent('agent-1')).toMatchObject({
      appliedRevision: null,
      failure: { revision: 1, reason: 'provider_not_installed', detail: 'no claude' },
    });
    store.recordApplied('agent-1', 1, '2026-01-01T00:00:01.000Z');
    expect(store.agent('agent-1')).toMatchObject({ appliedRevision: 1, failure: null });
    store.recordFailure(
      'agent-1',
      { revision: 2, reason: 'internal', detail: 'boom' },
      '2026-01-01T00:00:02.000Z'
    );
    expect(store.agent('agent-1')).toMatchObject({ appliedRevision: 1, failure: { revision: 2 } });
    expect(store.agents().map((row) => row.agentId)).toEqual(['agent-1']);
    store.deleteAgent('agent-1');
    expect(store.agent('agent-1')).toBeNull();
    store.close();
  });

  it('keeps each agent’s stream cursor and the relay port across a reopen', () => {
    const store = ControllerStore.open(path);
    expect(store.cursors()).toEqual(new Map());
    expect(store.relayPort()).toBeNull();
    store.saveCursor('agent-1', 7, '2026-01-01T00:00:00.000Z');
    store.saveCursor('agent-1', 9, '2026-01-01T00:00:01.000Z');
    store.saveCursor('agent-2', 3, '2026-01-01T00:00:01.000Z');
    store.saveRelayPort(43210);
    store.close();
    const reopened = ControllerStore.open(path);
    expect(reopened.cursors()).toEqual(
      new Map([
        ['agent-1', 9],
        ['agent-2', 3],
      ])
    );
    expect(reopened.relayPort()).toBe(43210);
    reopened.close();
  });

  it('migrates a v1 store: drops the key bookkeeping and keeps what was applied', () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof Sqlite;
    const v1 = new DatabaseSync(path);
    v1.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE assignment (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL,
        etag TEXT, body TEXT NOT NULL, fetched_at TEXT NOT NULL);
      CREATE TABLE agents (agent_id TEXT PRIMARY KEY, applied_revision INTEGER,
        changed_at TEXT NOT NULL, failure_revision INTEGER, failure_reason TEXT,
        failure_detail TEXT, credentials_stale INTEGER NOT NULL DEFAULT 0,
        credentials_refetched_at TEXT);
      CREATE TABLE restarts (agent_id TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX restarts_by_agent ON restarts (agent_id, at);
      INSERT INTO agents (agent_id, applied_revision, changed_at, credentials_stale)
        VALUES ('agent-1', 4, '2026-01-01T00:00:00.000Z', 1);
      PRAGMA user_version = 1;`);
    v1.close();
    const store = ControllerStore.open(path);
    expect(store.schemaVersion()).toBe(STORE_SCHEMA_VERSION);
    expect(store.agent('agent-1')).toEqual({
      agentId: 'agent-1',
      appliedRevision: 4,
      changedAt: '2026-01-01T00:00:00.000Z',
      failure: null,
    });
    store.close();
  });

  it('counts restarts in a window', () => {
    const store = ControllerStore.open(path);
    const now = 10_000_000;
    store.recordRestart('agent-1', now - 11 * 60 * 1000);
    store.recordRestart('agent-1', now - 5 * 60 * 1000);
    store.recordRestart('agent-1', now);
    store.recordRestart('agent-2', now);
    expect(store.restartsSince('agent-1', now - 10 * 60 * 1000)).toBe(2);
    store.deleteAgent('agent-1');
    expect(store.restartsSince('agent-1', 0)).toBe(0);
    store.close();
  });

  it('hands out a status seq that only grows, and never falls below the clock', () => {
    const store = ControllerStore.open(path);
    const first = store.nextStatusSeq(1_000);
    const second = store.nextStatusSeq(1_000);
    const third = store.nextStatusSeq(500);
    expect(first).toBe(1_000);
    expect(second).toBe(1_001);
    expect(third).toBe(1_002);
    store.close();
    const reopened = ControllerStore.open(path);
    expect(reopened.nextStatusSeq(0)).toBe(1_003);
    expect(reopened.nextStatusSeq(5_000)).toBe(5_000);
    reopened.close();
  });
});
