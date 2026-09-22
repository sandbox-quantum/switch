import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionSelector } from './session-selector';

/**
 * What the runtime tells the server about which of its sessions is calling.
 *
 * The rule the server enforces is all three or none, so the interesting cases
 * are the ones between: no supervisor, a supervisor that has not published yet,
 * and a published file that is missing a field. The last must not be answered
 * with silence — silence resolves the call to the connection instead, which on
 * a shared connection is a different session's room.
 */

const roots: string[] = [];

function selectorFile(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'switch-selector-'));
  roots.push(root);
  const file = join(root, 'session-selector.json');
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('the session selector', () => {
  it('sends all three headers when the supervisor has published them', () => {
    const file = selectorFile(
      JSON.stringify({ session_id: 'session-a', host_id: 'host-a', epoch: 'epoch-1' })
    );
    expect(sessionSelector(file)).toEqual({
      'X-Switch-Session-Id': 'session-a',
      'X-Switch-Session-Host-Id': 'host-a',
      'X-Switch-Session-Epoch': 'epoch-1',
    });
  });

  it('sends nothing when no supervisor named a file', () => {
    expect(sessionSelector(null)).toEqual({});
  });

  it('sends nothing until the supervisor has published', () => {
    expect(sessionSelector(selectorFile())).toEqual({});
  });

  it('follows the epoch the supervisor last published rather than the first', () => {
    const file = selectorFile(
      JSON.stringify({ session_id: 'session-a', host_id: 'host-a', epoch: 'epoch-1' })
    );
    expect(sessionSelector(file)['X-Switch-Session-Epoch']).toBe('epoch-1');
    writeFileSync(file, JSON.stringify({ session_id: 'session-a', host_id: 'host-a', epoch: 'epoch-2' }));
    expect(sessionSelector(file)['X-Switch-Session-Epoch']).toBe('epoch-2');
  });

  it('refuses a selector missing a field rather than falling back to the connection', () => {
    const file = selectorFile(JSON.stringify({ session_id: 'session-a', host_id: 'host-a' }));
    expect(() => sessionSelector(file)).toThrow(/epoch/);
  });

  it('refuses a selector with an empty field', () => {
    const file = selectorFile(
      JSON.stringify({ session_id: '', host_id: 'host-a', epoch: 'epoch-1' })
    );
    expect(() => sessionSelector(file)).toThrow(/session_id/);
  });

  it('refuses a file that is not a selector at all', () => {
    expect(() => sessionSelector(selectorFile('not json'))).toThrow(/session selector/);
  });
});
