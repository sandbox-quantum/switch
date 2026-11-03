import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { requireProvider } from '@shared/core/providers/agent-provider-registry';
import { providerLoginExitChannel, providerLoginLineChannel } from '@shared/events/appEvents';

/**
 * Runs a provider's own sign-in command on this computer, one attempt at a
 * time, relaying what it writes.
 *
 * It runs through the login shell, as the agent controller and its sessions
 * find the CLI, so the CLI signed in is the one they will use. Stdin is kept
 * open rather than closed: a command that waits for its browser round trip
 * would read a closed stdin as being cancelled.
 */
class ProviderLoginRunner {
  private current: { attemptId: string; child: ChildProcess } | null = null;

  start(providerId: string): { attemptId: string } {
    const provider = requireProvider(providerId);
    this.cancel();
    const attemptId = randomUUID();
    const windows = process.platform === 'win32';
    const shell = windows
      ? (process.env.ComSpec ?? 'cmd.exe')
      : (process.env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'));
    const child = spawn(
      shell,
      windows ? ['/c', provider.loginCommand] : ['-lc', provider.loginCommand],
      {
        cwd: homedir(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !windows,
        windowsHide: true,
      }
    );
    this.current = { attemptId, child };
    log.info('Running a provider sign-in command', { provider: providerId, attemptId });
    const relay = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
        if (line.trim()) events.emit(providerLoginLineChannel, { attemptId, line });
      });
    };
    relay(child.stdout);
    relay(child.stderr);
    let ended = false;
    const end = (exitCode: number | null, error: string | null) => {
      if (ended) return;
      ended = true;
      if (this.current?.attemptId === attemptId) this.current = null;
      if (error) log.warn('A provider sign-in command failed', { provider: providerId, error });
      events.emit(providerLoginExitChannel, { attemptId, exitCode, error });
    };
    child.once('error', (error) =>
      end(null, `Could not run ${provider.loginCommand}: ${error.message}`)
    );
    child.once('exit', (code, signal) =>
      end(code, signal ? `${provider.loginCommand} was stopped (${signal}).` : null)
    );
    return { attemptId };
  }

  /** Ends the attempt in progress, with everything it started. */
  cancel(): void {
    const running = this.current;
    if (!running) return;
    this.current = null;
    const { child } = running;
    try {
      if (process.platform !== 'win32' && child.pid !== undefined)
        process.kill(-child.pid, 'SIGTERM');
      else child.kill();
    } catch {
      // Already gone.
    }
  }
}

export const providerLoginRunner = new ProviderLoginRunner();
