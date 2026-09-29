import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
vi.mock('@main/core/agent-runtime/impl/resolve-sidecar-bundle', () => ({
  resolveSharedHostBundlePath: vi.fn(),
}));
const ssh = vi.hoisted(() => ({
  ensureSshConnected: vi.fn(async () => ({ proxy: true })),
  exec: vi.fn(async () => ({
    stdout: '/home/alice/.local/state/switch/sdk-watchers/abc\n',
    stderr: '',
  })),
  contexts: [] as unknown[][],
}));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: ssh.ensureSshConnected,
}));
vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: class {
    exec = ssh.exec;
    constructor(...args: unknown[]) {
      ssh.contexts.push(args);
    }
  },
}));
const { resolveWatcherRoot, runSharedHostCommand } = await import('./shared-host-deployment');
it.each([false, true])(
  'keeps configuration out of launch arguments and cleans files on failure=%s',
  async (fail) => {
    let path = '';
    const config = { environment: { PRIVATE_TEST_VALUE: 'synthetic-sensitive-value' } };
    const exec = vi.fn(async (_command: string, args: string[]) => {
      expect(JSON.stringify(args)).not.toContain('synthetic-sensitive-value');
      path = args[2];
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(config);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      if (fail) throw new Error('Launch failed');
      return { stdout: '{"created":true}', stderr: '', exitCode: 0 };
    });
    const launched = runSharedHostCommand(
      { kind: 'local' },
      {
        ctx: { exec } as unknown as IExecutionContext,
        root: '/tmp/session',
        entrypoint: '/tmp/host.mjs',
      },
      config,
      '--ensure',
      false
    );
    if (fail) await expect(launched).rejects.toThrow('Launch failed');
    else await expect(launched).resolves.toMatchObject({ stdout: '{"created":true}' });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  }
);

it('finds a watcher’s state root on a host without deploying anything there', async () => {
  const { root } = await resolveWatcherRoot(
    { kind: 'ssh', connectionId: 'conn-1', host: 'vm-1', dir: '/work' } as never,
    '/work',
    'switch-agent-1'
  );

  expect(root).toBe('/home/alice/.local/state/switch/sdk-watchers/abc');
  expect(ssh.ensureSshConnected).toHaveBeenCalledWith('conn-1', 'vm-1');
  expect(ssh.exec).toHaveBeenCalledOnce();
  const [command, args] = ssh.exec.mock.calls[0] as unknown as [string, string[]];
  expect(command).toBe('node');
  expect(args.slice(2)).toEqual([
    createHash('sha256').update('switch-agent-1').digest('hex'),
    'sdk-watchers',
    'switch-agent-1',
  ]);
});
