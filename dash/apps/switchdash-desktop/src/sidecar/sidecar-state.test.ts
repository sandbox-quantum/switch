import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sidecarAgentDir, sidecarStateRelPath } from './sidecar-paths';
import {
  loadSidecarState,
  type SidecarSessionEntry,
  SidecarStateStore,
  SidecarStateTooNewError,
} from './sidecar-state';

const SLUG = 'claude-code.repo.me';
const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(path.join(tmpdir(), 'sidecar-state-'));
  await mkdir(path.join(repoDir, sidecarAgentDir(SLUG)), { recursive: true });
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

const statePath = (): string => path.join(repoDir, sidecarStateRelPath(SLUG));

const writeState = (raw: string): Promise<void> => writeFile(statePath(), raw);

const entry = (over: Partial<SidecarSessionEntry> = {}): SidecarSessionEntry => ({
  sessionId: 'session-a',
  roomId: 'room-1',
  providerId: 'claude',
  tmuxTarget: 'switchdash-abc',
  ...over,
});

describe('loadSidecarState', () => {
  it('returns empty state on first run', async () => {
    const state = await loadSidecarState(repoDir, SLUG, silentLog);
    expect(state).toEqual({ version: '1', epoch: 0, sessions: [] });
  });

  it('reads back a persisted state file', async () => {
    await writeState(JSON.stringify({ version: '1', epoch: 4, sessions: [entry()] }));

    const state = await loadSidecarState(repoDir, SLUG, silentLog);

    expect(state.epoch).toBe(4);
    expect(state.sessions).toEqual([entry()]);
  });

  it('treats a corrupt file as empty rather than failing to start', async () => {
    await writeState('{ not json');

    const state = await loadSidecarState(repoDir, SLUG, silentLog);

    expect(state.sessions).toEqual([]);
    expect(silentLog.warn).toHaveBeenCalled();
  });

  it('refuses to start on state written by a NEWER sidecar', async () => {
    // Starting empty here would report zero sessions to every client, which
    // prunes rows for sessions that are alive — worse than not starting.
    await writeState(JSON.stringify({ version: '99', epoch: 1, sessions: [entry()] }));

    await expect(loadSidecarState(repoDir, SLUG, silentLog)).rejects.toBeInstanceOf(
      SidecarStateTooNewError
    );
  });
});

describe('SidecarStateStore', () => {
  const open = (isPaneAlive: (t: string) => Promise<boolean> = async () => true) =>
    SidecarStateStore.open({ repoDir, slug: SLUG, isPaneAlive, log: silentLog });

  it('restores sessions whose pane is still alive', async () => {
    await writeState(JSON.stringify({ version: '1', epoch: 1, sessions: [entry()] }));

    const store = await open();

    expect(store.entries()).toEqual([entry()]);
    expect(store.has('session-a')).toBe(true);
    expect(store.roomIdFor('session-a')).toBe('room-1');
    await store.close();
  });

  it('drops restored sessions whose pane is gone, so no ghost row is served', async () => {
    await writeState(
      JSON.stringify({
        version: '1',
        epoch: 1,
        sessions: [entry(), entry({ sessionId: 'session-dead', tmuxTarget: 'switchdash-dead' })],
      })
    );

    const store = await open(async (target) => target !== 'switchdash-dead');

    expect(store.entries().map((s) => s.sessionId)).toEqual(['session-a']);
    await store.close();
  });

  it('bumps the epoch on every open so a restarted stream is distinguishable', async () => {
    await writeState(JSON.stringify({ version: '1', epoch: 7, sessions: [] }));

    const store = await open();

    expect(store.epoch).toBe(8);
    await store.close();
  });

  it('persists recorded sessions across a restart', async () => {
    const first = await open();
    first.record(entry());
    await first.close();

    const second = await open();

    expect(second.entries()).toEqual([entry()]);
    await second.close();
  });

  it('keeps a known room when a later bare hook reports none', async () => {
    const store = await open();
    store.record(entry());
    store.record(entry({ roomId: null }));

    expect(store.roomIdFor('session-a')).toBe('room-1');
    await store.close();
  });

  it('clears a room on request, which a bare hook must not do (CHOO-1419)', async () => {
    const store = await open();
    store.record(entry());

    store.clearRoom('session-a');

    expect(store.roomIdFor('session-a')).toBeNull();
    expect(store.has('session-a')).toBe(true);
    await store.close();
  });

  it('does not resurrect a cleared room across a restart', async () => {
    // The restored entry is what /sessions reports for a pane with no live
    // connection, and what a restarted session reconnects to. A room that
    // outlived its connection would be re-claimed from whoever holds it now.
    const first = await open();
    first.record(entry());
    first.clearRoom('session-a');
    await first.close();

    const second = await open();

    expect(second.roomIdFor('session-a')).toBeNull();
    await second.close();
  });

  it('forgets a deleted session so it is not restored', async () => {
    const first = await open();
    first.record(entry());
    first.forget('session-a');
    await first.close();

    const second = await open();

    expect(second.entries()).toEqual([]);
    await second.close();
  });

  it('writes atomically, leaving no partial file behind', async () => {
    const store = await open();
    store.record(entry());
    await store.close();

    const written = JSON.parse(await readFile(statePath(), 'utf8')) as { version: string };
    expect(written.version).toBe('1');
    // The temp file the atomic write renames from must not survive.
    const stray = path.join(repoDir, sidecarAgentDir(SLUG));
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(stray)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
