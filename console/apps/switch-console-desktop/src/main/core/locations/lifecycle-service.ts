import type { IDisposable } from '@switch-console/shared';
import type { IExecutionContext } from '@main/core/execution-context/types';

type LifecycleScript = {
  type: 'setup' | 'run' | 'teardown';
  script: string;
  shellSetup?: string;
};

export type LifecycleScriptExecutionResult =
  | { kind: 'already-running' }
  | { kind: 'exited'; exitCode?: number; signal?: string | number; outputTail: string };

export class LifecycleScriptService implements IDisposable {
  private readonly active = new Map<string, AbortController>();
  private disposed = false;

  constructor(
    private readonly options: {
      ctx: IExecutionContext;
      sessionEnvVars: Record<string, string>;
      windows: boolean;
    }
  ) {}

  stop(type: LifecycleScript['type']): boolean {
    const controller = this.active.get(type);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async runLifecycleScript(script: LifecycleScript): Promise<LifecycleScriptExecutionResult> {
    if (this.disposed) throw new Error('Location execution has been disposed');
    if (this.active.has(script.type)) return { kind: 'already-running' };
    const controller = new AbortController();
    this.active.set(script.type, controller);
    const line = script.shellSetup ? `${script.shellSetup} && ${script.script}` : script.script;
    const { ctx, sessionEnvVars, windows } = this.options;
    try {
      // Redirect the whole script so commands reading stdin receive EOF.
      const result = await ctx.exec(
        windows ? 'cmd.exe' : 'sh',
        windows ? ['/d', '/s', '/c', `(${line}) < NUL`] : ['-c', `{\n${line}\n} < /dev/null`],
        { signal: controller.signal, env: sessionEnvVars, maxBuffer: 16 * 1024 * 1024 }
      );
      return {
        kind: 'exited',
        exitCode: 0,
        outputTail: (result.stdout + result.stderr).slice(-16384),
      };
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const failure = error as {
        code?: unknown;
        stdout?: string;
        stderr?: string;
        signal?: string;
      };
      if (typeof failure.code !== 'number') throw error;
      return {
        kind: 'exited',
        exitCode: failure.code,
        signal: failure.signal,
        outputTail: `${failure.stdout ?? ''}${failure.stderr ?? ''}`.slice(-16384),
      };
    } finally {
      this.active.delete(script.type);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active.values()) controller.abort();
    this.options.ctx.dispose();
  }
}
