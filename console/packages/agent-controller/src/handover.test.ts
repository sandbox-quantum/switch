import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from './errors';
import {
  adoptIdentity,
  readCredential,
  resolveSharedHostBundle,
  SHARED_HOST_BUNDLE_ENV,
} from './handover';
import { ControllerStore } from './store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-handover-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pipeOf(...chunks: string[]): PassThrough {
  const pipe = new PassThrough();
  for (const chunk of chunks) pipe.write(chunk);
  pipe.end();
  return pipe;
}

describe('readCredential', () => {
  it('reads the credential the parent wrote, to the end of the pipe', async () => {
    expect(await readCredential(pipeOf('swcc_abc', 'def\n'), 1_000)).toBe('swcc_abcdef');
  });

  it('refuses an empty pipe, a terminal, and more than one token', async () => {
    await expect(readCredential(pipeOf(''), 1_000)).rejects.toThrow(/without a credential/);
    const terminal = Object.assign(pipeOf('swcc_x'), { isTTY: true });
    await expect(readCredential(terminal, 1_000)).rejects.toThrow(/terminal/);
    await expect(readCredential(pipeOf('swcc_a swcc_b'), 1_000)).rejects.toThrow(/not one token/);
  });

  it('gives up on a parent that never closes the pipe', async () => {
    const open = new PassThrough();
    open.write('swcc_partial');
    await expect(readCredential(open, 20)).rejects.toThrow(/within/);
    open.destroy();
  });

  it('refuses every way as a configuration error, which a restart cannot fix', async () => {
    const open = new PassThrough();
    const broken = new PassThrough();
    const failures = [
      readCredential(pipeOf(''), 1_000),
      readCredential(Object.assign(pipeOf('swcc_x'), { isTTY: true }), 1_000),
      readCredential(pipeOf('swcc_a swcc_b'), 1_000),
      readCredential(open, 20),
      readCredential(broken, 1_000),
    ].map((failure) =>
      failure.then(
        () => null,
        (error: unknown) => error
      )
    );
    broken.destroy(new Error('EPIPE'));
    const errors = await Promise.all(failures);
    for (const error of errors) expect(error).toBeInstanceOf(ConfigurationError);
    expect((errors[4] as Error).message).toMatch(/could not be read from stdin: EPIPE/);
    open.destroy();
  });
});

describe('adoptIdentity', () => {
  it('seeds an empty store, keeps a matching one, moves it to a new server, and refuses another controller', () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    try {
      const input = {
        controllerId: 'controller-1',
        server: 'https://switch.example.com/',
        name: 'laptop',
        now: new Date('2026-01-01T00:00:00Z'),
      };
      expect(adoptIdentity(store, input, dir)).toBe('adopted');
      expect(store.identity()).toEqual({
        controllerId: 'controller-1',
        server: 'https://switch.example.com',
        name: 'laptop',
        enrolledAt: '2026-01-01T00:00:00.000Z',
      });
      expect(adoptIdentity(store, { ...input, name: 'renamed' }, dir)).toBe('unchanged');
      expect(store.identity()?.name).toBe('laptop');
      expect(() => adoptIdentity(store, { ...input, controllerId: 'controller-2' }, dir)).toThrow(
        /already belongs to controller controller-1/
      );
      expect(() => adoptIdentity(store, { ...input, controllerId: 'controller-2' }, dir)).toThrow(
        ConfigurationError
      );

      expect(
        adoptIdentity(
          store,
          { ...input, server: 'https://moved.example.com/', name: 'renamed' },
          dir
        )
      ).toBe('server_changed');
      expect(store.identity()).toEqual({
        controllerId: 'controller-1',
        server: 'https://moved.example.com',
        name: 'laptop',
        enrolledAt: '2026-01-01T00:00:00.000Z',
      });
      expect(adoptIdentity(store, { ...input, server: 'https://moved.example.com' }, dir)).toBe(
        'unchanged'
      );
      // Another controller is refused whatever server it names.
      expect(() =>
        adoptIdentity(
          store,
          { ...input, controllerId: 'controller-2', server: 'https://moved.example.com' },
          dir
        )
      ).toThrow(/already belongs to controller controller-1/);
    } finally {
      store.close();
    }
  });

  it('refuses a plain-http server that is not loopback', () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    try {
      expect(() =>
        adoptIdentity(
          store,
          { controllerId: 'c', server: 'http://switch.example.com', name: 'n', now: new Date() },
          dir
        )
      ).toThrow(ConfigurationError);
      expect(store.identity()).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('resolveSharedHostBundle', () => {
  it('takes the flag, then the environment, then the workspace build', () => {
    const flagged = join(dir, 'flagged.mjs');
    const env = join(dir, 'env.mjs');
    const workspace = join(dir, 'workspace.mjs');
    for (const path of [flagged, env, workspace]) writeFileSync(path, '');
    const fromWorkspace = () => workspace;
    expect(resolveSharedHostBundle(flagged, { [SHARED_HOST_BUNDLE_ENV]: env }, fromWorkspace)).toBe(
      flagged
    );
    expect(
      resolveSharedHostBundle(undefined, { [SHARED_HOST_BUNDLE_ENV]: env }, fromWorkspace)
    ).toBe(env);
    expect(resolveSharedHostBundle(undefined, {}, fromWorkspace)).toBe(workspace);
  });

  it('fails loud, as a configuration error, on a bundle that is not there', () => {
    expect(() => resolveSharedHostBundle(join(dir, 'missing.mjs'), {}, () => '')).toThrow(
      /does not exist/
    );
    expect(() => resolveSharedHostBundle(undefined, {}, () => join(dir, 'none.mjs'))).toThrow(
      /does not exist\. Build the workspace packages first/
    );
    expect(() => resolveSharedHostBundle(join(dir, 'missing.mjs'), {}, () => '')).toThrow(
      ConfigurationError
    );
    const unresolvable = () => {
      throw new Error("Cannot find package '@switch-console/agent-providers'");
    };
    expect(() => resolveSharedHostBundle(undefined, {}, unresolvable)).toThrow(ConfigurationError);
    expect(() => resolveSharedHostBundle(undefined, {}, unresolvable)).toThrow(
      /none is installed beside the CLI or built in the workspace: Cannot find package/
    );
  });

  it('refuses a bundle that is a directory, or that cannot be read', () => {
    const directory = join(dir, 'bundle-dir');
    mkdirSync(directory);
    expect(() => resolveSharedHostBundle(directory, {}, () => '')).toThrow(/is not a file/);
    if (process.getuid?.() === 0) return;
    const unreadable = join(dir, 'unreadable.mjs');
    writeFileSync(unreadable, '');
    chmodSync(unreadable, 0o000);
    expect(() => resolveSharedHostBundle(unreadable, {}, () => '')).toThrow(ConfigurationError);
    expect(() => resolveSharedHostBundle(unreadable, {}, () => '')).toThrow(/cannot be read/);
  });
});
