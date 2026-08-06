import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import type { DockerAvailability } from '@shared/core/managed-switch-server/managed-switch-server';
import { LOCAL_SERVER_PROJECT_NAME } from '../constants';
import { DOCKER_EXECUTABLE, detectDocker } from '../docker';
import { type LocalServerPorts, pickFreePorts } from '../free-port';
import { ensureLocalGhcrLogin } from '../ghcr-auth';
import { localServerDir } from '../paths';
import type { ServerHost } from './types';

/**
 * The managed stack running on this machine's Docker daemon — the CHOO-1428
 * behaviour, now expressed through {@link ServerHost}. Commands run via a local
 * spawn rooted at the user-data working dir; the published ports are already on
 * loopback, so there is no networking to establish.
 */
export class LocalServerHost implements ServerHost {
  readonly kind = 'local' as const;
  readonly dockerBin = DOCKER_EXECUTABLE;
  readonly composeProjectName = LOCAL_SERVER_PROJECT_NAME;
  readonly workingDir = localServerDir();
  readonly stateDir = localServerDir();
  readonly secretsKey = 'local-switch-server:secrets';
  readonly label = 'this computer';
  readonly ctx: IExecutionContext = new LocalExecutionContext({ root: this.workingDir });

  async writeFile(relPath: string, content: string, mode?: number): Promise<void> {
    const path = join(this.workingDir, relPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8');
    // writeFile only applies `mode` when creating; enforce it on rewrite too.
    if (mode !== undefined) await chmod(path, mode);
  }

  async readFile(relPath: string): Promise<string | null> {
    try {
      return await readFile(join(this.workingDir, relPath), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  streamCommand(
    command: string,
    args: string[],
    onLine: (line: string) => void,
    opts: { timeoutMs?: number } = {}
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.workingDir });
      let stderrTail = '';

      const emitLines = (chunk: Buffer) => {
        for (const raw of chunk.toString('utf8').split('\n')) {
          const line = raw.replace(/\r$/, '');
          if (line.length > 0) onLine(line);
        }
      };

      const timer =
        opts.timeoutMs !== undefined
          ? setTimeout(() => {
              child.kill('SIGTERM');
              reject(new Error(`${command} timed out after ${opts.timeoutMs}ms`));
            }, opts.timeoutMs)
          : undefined;

      child.stdout.on('data', emitLines);
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
        emitLines(chunk);
      });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${command} failed (exit ${code}): ${stderrTail.trim()}`));
      });
    });
  }

  detectDocker(): Promise<DockerAvailability> {
    return detectDocker();
  }

  ensureGhcrLogin(): Promise<void> {
    return ensureLocalGhcrLogin();
  }

  pickFreePorts(): Promise<LocalServerPorts> {
    return pickFreePorts();
  }

  async establishNetworking(): Promise<void> {
    // Local ports are already published on 127.0.0.1 — nothing to forward.
  }

  async teardownNetworking(): Promise<void> {}

  dispose(): void {
    this.ctx.dispose();
  }
}
