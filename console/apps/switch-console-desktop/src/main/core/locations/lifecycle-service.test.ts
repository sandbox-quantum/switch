import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { LifecycleScriptService } from './lifecycle-service';

function service(exec: IExecutionContext['exec']) {
  const ctx = { exec, dispose: vi.fn() } as unknown as IExecutionContext;
  return new LifecycleScriptService({
    ctx,
    sessionEnvVars: { SESSION_NAME: 'a; b' },
    windows: false,
  });
}

describe('lifecycle commands', () => {
  it('passes environment as literal arguments and runs setup before the command', async () => {
    const exec = vi.fn(async () => ({ stdout: 'done', stderr: '' }));
    const scripts = service(exec);
    expect(
      await scripts.runLifecycleScript({ type: 'setup', script: 'build', shellSetup: 'configure' })
    ).toEqual({ kind: 'exited', exitCode: 0, outputTail: 'done' });
    expect(exec).toHaveBeenCalledWith(
      'env',
      ['SESSION_NAME=a; b', 'sh', '-c', 'configure && build'],
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
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
