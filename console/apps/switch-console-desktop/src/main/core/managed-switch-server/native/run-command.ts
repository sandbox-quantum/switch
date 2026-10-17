import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

export type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Each line of merged stdout and stderr, for the UI's log tail. */
  onLine: (line: string) => void;
  timeoutMs: number;
  /** Text written to the child's stdin, which is then closed. */
  stdin?: string;
};

/**
 * Run a command to completion, streaming its output line by line. Rejects on a
 * non-zero exit or a timeout with the tail of its output in the message, so a
 * failure says what the tool itself said.
 */
export function runCommand(command: string, args: string[], opts: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let tail = '';
    const emit = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-4000);
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.length > 0) opts.onLine(line);
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);
    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (exit ${code}): ${tail.trim()}`));
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  });
}

/**
 * Run a command that leaves a process running behind it (`pg_ctl start`),
 * with its output appended to `logFile` rather than piped back.
 *
 * Pipes would hang the wait: the process left behind inherits them, so they
 * never close, and on Windows — where pg_ctl starts the server through
 * cmd.exe — a wait on the pipes closing never ends. A file handle can be
 * inherited without holding anything up, and the wait is on the command's own
 * exit.
 */
export function runLeavingProcess(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; logFile: string; timeoutMs: number }
): Promise<void> {
  const fd = openSync(opts.logFile, 'a', 0o600);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (exit ${code}); see ${opts.logFile}`));
    });
  }).finally(() => closeSync(fd));
}
