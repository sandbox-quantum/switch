import type { ChildProcess, ExecFileOptions } from 'node:child_process';
import { execProvider } from '../provider-process';

/** What `execWithin` answers when the time it was given ran out first. */
export const OUT_OF_TIME = 'out of time';

/**
 * `execProvider` with its time as a hard limit: when `timeout` runs out, or
 * `budget` (a time it shares with other calls) is spent, the process is killed
 * (SIGKILL, which no process ignores) and `OUT_OF_TIME` is answered at once,
 * never waiting for the process to end. A budget already spent runs nothing.
 * Node signals only a process that has not exited, so nothing is signalled
 * after its exit. A failure within the time is thrown as `execProvider`
 * throws it.
 */
export async function execWithin(
  command: string,
  args: readonly string[],
  options: Omit<ExecFileOptions, 'timeout' | 'killSignal' | 'signal'> & {
    timeout: number;
    budget?: AbortSignal;
  }
): Promise<{ stdout: string; stderr: string } | typeof OUT_OF_TIME> {
  const { budget, ...execOptions } = options;
  if (budget?.aborted) return OUT_OF_TIME;
  // execFile's own `signal` would stop it with SIGTERM, whatever `killSignal`
  // says; the child execProvider's promise carries is killed here instead.
  const run: Promise<{ stdout: string; stderr: string }> & { child?: ChildProcess } = execProvider(
    command,
    args,
    { ...execOptions, killSignal: 'SIGKILL' }
  );
  let timer: NodeJS.Timeout | undefined;
  const done = new AbortController();
  const outOfTime = new Promise<typeof OUT_OF_TIME>((resolve) => {
    timer = setTimeout(() => resolve(OUT_OF_TIME), execOptions.timeout);
    budget?.addEventListener(
      'abort',
      () => {
        run.child?.kill('SIGKILL');
        resolve(OUT_OF_TIME);
      },
      { once: true, signal: done.signal }
    );
  });
  try {
    return await Promise.race([run, outOfTime]);
  } finally {
    clearTimeout(timer);
    // Drops the listener on `budget`, which outlives this call.
    done.abort();
  }
}
