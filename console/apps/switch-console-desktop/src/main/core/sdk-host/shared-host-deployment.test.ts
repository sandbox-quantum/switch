import { readFile, stat } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
vi.mock('@main/core/agent-runtime/impl/resolve-sidecar-bundle', () => ({
  resolveSharedHostBundlePath: vi.fn(),
}));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected: vi.fn() }));
const { runSharedHostCommand } = await import('./shared-host-deployment');
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
