import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerHost } from './host/types';
import { readPersistedPorts, rememberPorts, resolvePorts } from './ports';

let stateDir: string;
const pickFreePorts = vi.fn();

function host(): ServerHost {
  return { stateDir, pickFreePorts } as unknown as ServerHost;
}

beforeEach(() => {
  stateDir = join(mkdtempSync(join(tmpdir(), 'ports-')), 'remote', 'vm-1');
  pickFreePorts.mockReset();
});

afterEach(() => {
  rmSync(join(stateDir, '..', '..'), { recursive: true, force: true });
});

const theirs = { gateway: 41000, api: 41001, mattermost: 41002, postgres: 41003 };

it('keeps the ports a shared stack publishes as this desktop’s copy, so a later start reuses them', async () => {
  // Picking new ones would move the stack off the ports everyone else reaches it on.
  await rememberPorts(host(), theirs);

  expect(await readPersistedPorts(host())).toEqual(theirs);
  expect(await resolvePorts(host())).toEqual(theirs);
  expect(pickFreePorts).not.toHaveBeenCalled();
});

it('replaces an earlier copy with the ports the host holds now', async () => {
  await rememberPorts(host(), { gateway: 3300, api: 8000, mattermost: 8065, postgres: 5432 });

  await rememberPorts(host(), theirs);

  expect(await readPersistedPorts(host())).toEqual(theirs);
});
