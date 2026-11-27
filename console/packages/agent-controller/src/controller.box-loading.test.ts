import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ControllerDeps, runController } from './controller';
import { ConfigurationError } from './errors';
import { silentLogger } from './log';
import { ControllerStore } from './store';

/** Set once anything loads the box controller. */
const loaded = vi.hoisted(() => ({ boxController: false }));

vi.mock('./box/controller-box', async (importOriginal) => {
  loaded.boxController = true;
  return importOriginal();
});

let dir: string;
let store: ControllerStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-box-loading-'));
  store = ControllerStore.open(join(dir, 'controller.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Just enough for `runController` to get as far as refusing a machine with no identity. */
function deps(box: boolean): ControllerDeps {
  return {
    store,
    dataDir: dir,
    log: silentLogger,
    now: Date.now,
    box,
  } as unknown as ControllerDeps;
}

describe('the box controller', () => {
  it('is never loaded by a controller that is not in box mode, and is loaded in box mode', async () => {
    await expect(runController(deps(false), new AbortController().signal)).rejects.toBeInstanceOf(
      ConfigurationError
    );
    expect(loaded.boxController).toBe(false);
    await expect(runController(deps(true), new AbortController().signal)).rejects.toBeInstanceOf(
      ConfigurationError
    );
    expect(loaded.boxController).toBe(true);
  });
});
