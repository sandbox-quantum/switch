import { describe, expect, it, vi } from 'vitest';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { LifecycleScriptService } from './lifecycle-service';

function service(exec: IExecutionContext['exec'], windows = false) {
  const ctx = { exec, dispose: vi.fn() } as unknown as IExecutionContext;
  return new LifecycleScriptService({
    ctx,
    sessionEnvVars: { SESSION_NAME: 'a; b' },
    windows,
  });
}

describe('lifecycle commands', () => {
  it('passes literal environment and runs setup before the command', async () => {
    const exec = vi.fn(async () => ({ stdout: 'done', stderr: '' }));
    const scripts = service(exec);
    expect(
      await scripts.runLifecycleScript({ type: 'setup', script: 'build', shellSetup: 'configure' })
    ).toEqual({ kind: 'exited', exitCode: 0, outputTail: 'done' });
    expect(exec).toHaveBeenCalledWith(
      'sh',
      ['-c', '{\nconfigure && build\n} < /dev/null'],
      expect.objectContaining({ signal: expect.any(AbortSignal), env: { SESSION_NAME: 'a; b' } })
    );
  });
  it('preserves session environment for Windows lifecycle commands', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await service(exec, true).runLifecycleScript({ type: 'setup', script: 'build' });
    expect(exec).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/s', '/c', '(build) < NUL'],
      expect.objectContaining({ env: { SESSION_NAME: 'a; b' } })
    );
  });
  it.skipIf(process.platform === 'win32')(
    'runs with literal environment and EOF on stdin',
    async () => {
      const scripts = new LifecycleScriptService({
        ctx: new LocalExecutionContext(),
        sessionEnvVars: { SESSION_NAME: 'literal $(exit 9); value' },
        windows: false,
      });
      try {
        expect(
          await scripts.runLifecycleScript({
            type: 'setup',
            script: `if read value; then exit 7; fi; printf '%s' "$SESSION_NAME"`,
          })
        ).toEqual({ kind: 'exited', exitCode: 0, outputTail: 'literal $(exit 9); value' });
      } finally {
        await scripts.dispose();
      }
    }
  );
  it('retains command exit status and output', async () => {
    const scripts = service(async () => {
      throw Object.assign(new Error('failed'), { code: 7, stderr: 'bad build' });
    });
    expect(await scripts.runLifecycleScript({ type: 'setup', script: 'build' })).toMatchObject({
      kind: 'exited',
      exitCode: 7,
      outputTail: 'bad build',
    });
  });
  it('deduplicates running scripts and aborts them on disposal', async () => {
    const scripts = service(
      (_command, _args, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
    );
    const script = { type: 'run' as const, script: 'serve' };
    const pending = scripts.runLifecycleScript(script);
    const rejected = expect(pending).rejects.toThrow('aborted');
    expect(await scripts.runLifecycleScript(script)).toEqual({ kind: 'already-running' });
    await scripts.dispose();
    await rejected;
    await expect(scripts.runLifecycleScript(script)).rejects.toThrow('disposed');
  });
});
