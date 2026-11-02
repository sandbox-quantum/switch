import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RepairNotes } from './repair-notes';

let dir: string;
let path: string;
let notes: RepairNotes;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'repair-notes-'));
  path = join(dir, 'managed-agents', 'repair-notes.json');
  notes = new RepairNotes(() => path);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the notes Console keeps for Repair my cloud', () => {
  it('keeps the kind of login only, owner-only on disk', async () => {
    await notes.setSource('c1', 'codex', { source: 'this-computer', accountHash: 'a'.repeat(64) });
    expect(await notes.source('c1', 'codex')).toEqual({
      source: 'this-computer',
      accountHash: 'a'.repeat(64),
    });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses to hold anything but its fixed fields', async () => {
    const MARKER = 'sk-ant-api03-zebra-marker-7f3c';
    await notes.setSource('c1', 'claude', {
      source: 'typed',
      // A field the record has no place for is dropped on the next read, never kept.
      ...({ credential: MARKER } as object),
    });
    await notes.setPress('m1', {
      revokedControllerId: 'c1',
      revokedAt: null,
      pressedAt: 1,
      copiedControllerId: null,
    });
    expect(readFileSync(path, 'utf8')).not.toContain(MARKER);
  });

  it('lets only the first new controller take a press', async () => {
    await notes.setPress('m1', {
      revokedControllerId: 'old',
      revokedAt: '2026-10-29T17:50:00Z',
      pressedAt: 1,
      copiedControllerId: null,
    });
    expect(await notes.claimPress('m1', 'first')).toBe(true);
    expect(await notes.claimPress('m1', 'first')).toBe(true);
    expect(await notes.claimPress('m1', 'second')).toBe(false);
    expect(await notes.claimPress('no-press', 'first')).toBe(false);
  });

  it('drops old presses and the records no live controller or press needs', async () => {
    await notes.setSource('live', 'codex', { source: 'typed' });
    await notes.setSource('old', 'codex', { source: 'this-computer' });
    await notes.setSource('gone', 'codex', { source: 'typed' });
    await notes.setPress('m1', {
      revokedControllerId: 'old',
      revokedAt: null,
      pressedAt: 1000,
      copiedControllerId: null,
    });
    await notes.setPress('m2', {
      revokedControllerId: 'gone',
      revokedAt: null,
      pressedAt: 0,
      copiedControllerId: null,
    });
    await notes.prune(new Set(['live']), 1500, 1000);
    expect(await notes.press('m1')).not.toBeNull();
    expect(await notes.press('m2')).toBeNull();
    expect(await notes.source('live', 'codex')).not.toBeNull();
    expect(await notes.source('old', 'codex')).not.toBeNull();
    expect(await notes.source('gone', 'codex')).toBeNull();
  });

  it('reads an unreadable file as empty, which only ever costs an ask', async () => {
    await notes.setSource('c1', 'codex', { source: 'this-computer' });
    writeFileSync(path, '{not json');
    expect(await notes.source('c1', 'codex')).toBeNull();
  });
});

describe('the notes folder', () => {
  it('is brought down to 0700 when it already exists with looser rights', async () => {
    if (process.platform === 'win32') return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    await notes.setSource('c1', 'codex', { source: 'typed' });
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });
});
