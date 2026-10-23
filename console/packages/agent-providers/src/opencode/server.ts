import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { ProviderUnavailableError } from '../adapter';
import { killProcessTree } from '../host/process-fence';
import { spawnProvider, stopProvider } from '../provider-process';
import type { OpencodeConfigFile } from './config';
import { prepareOpencodeHome } from './home';

const READY_PREFIX = 'opencode server listening';

export interface OpencodeServerHandle {
  url: string;
  /** HTTP Basic, username `opencode`, password from `OPENCODE_SERVER_PASSWORD`. */
  authorization: string;
  process: ChildProcess;
  configHome: string;
}

/**
 * A skill to place in the session's isolated config home.
 *
 * `name` has to be the skill's own frontmatter name: OpenCode discovers
 * `skills/<name>/SKILL.md` and rejects a skill whose folder disagrees with it.
 */
export interface OpencodeSkill {
  name: string;
  content: string;
}

export interface StartServerInput {
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
  config: OpencodeConfigFile;
  startupTimeoutMs: number;
  /**
   * Managed skills to load in addition to the execution host's native skills.
   */
  skills: OpencodeSkill[];
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('could not determine a free port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export async function startOpencodeServer(input: StartServerInput): Promise<OpencodeServerHandle> {
  const password = randomBytes(24).toString('base64url');
  const port = await findFreePort();
  const configHome = await prepareOpencodeHome(input.config, input.skills, input.env);
  let child: ChildProcess | undefined;

  try {
    child = spawnProvider(input.binaryPath, ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
      cwd: input.cwd,
      env: {
        ...input.env,
        XDG_CONFIG_HOME: configHome,
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const activeChild = child;
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      let settled = false;
      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run();
      };
      const timer = setTimeout(() => {
        finish(() => {
          stopProvider(activeChild, 'SIGKILL');
          reject(
            new ProviderUnavailableError(
              'opencode',
              `server did not start within ${input.startupTimeoutMs}ms: ${output.trim()}`
            )
          );
        });
      }, input.startupTimeoutMs);

      activeChild.stdout?.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);
        for (const line of output.split('\n')) {
          if (!line.startsWith(READY_PREFIX)) continue;
          const match = line.match(/on\s+(https?:\/\/\S+)/);
          if (!match?.[1]) continue;
          finish(() => resolve(match[1] as string));
          return;
        }
      });
      activeChild.stderr?.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);
      });
      activeChild.on('error', (error) => {
        finish(() =>
          reject(new ProviderUnavailableError('opencode', 'could not spawn', { cause: error }))
        );
      });
      activeChild.on('exit', (code) => {
        finish(() =>
          reject(
            new ProviderUnavailableError(
              'opencode',
              `server exited with code ${code}: ${output.trim()}`
            )
          )
        );
      });
    });

    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    await waitForHealth(url, authorization, input.startupTimeoutMs);
    return { url, authorization, process: child, configHome };
  } catch (error) {
    if (child) {
      await stopOpencodeServer({ process: child, configHome });
    } else {
      await rm(configHome, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function stopOpencodeServer(
  server: Pick<OpencodeServerHandle, 'process' | 'configHome'>
): Promise<void> {
  const child = server.process;
  const pid = child.pid;
  if (pid) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const kill = setTimeout(() => stopProvider(child, 'SIGKILL'), 2000);
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('OpenCode process did not exit after termination.'));
        }, 5000);
        const cleanup = () => {
          clearTimeout(kill);
          clearTimeout(timeout);
          child.removeListener('exit', exited);
        };
        const exited = () => {
          cleanup();
          resolve();
        };
        child.once('exit', exited);
        stopProvider(child, 'SIGTERM');
      });
    }
    // Even if the root process exited (e.g. a wrapper script), ensure any
    // spawned descendants in its tree or process group are terminated.
    await killProcessTree(pid).catch((error: unknown) => {
      console.error(`Could not stop OpenCode process tree (pid ${pid}): ${String(error)}`);
    });
  }
  await rm(server.configHome, { recursive: true, force: true });
}

async function waitForHealth(url: string, authorization: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/global/health`, {
        headers: { authorization },
        signal: AbortSignal.timeout(Math.min(5000, Math.max(1, deadline - Date.now()))),
      });
      if (response.ok) {
        const body = (await response.json()) as { healthy?: boolean };
        if (body.healthy === true) return;
        lastError = `health reported ${JSON.stringify(body)}`;
      } else {
        lastError = `health returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new ProviderUnavailableError('opencode', `server never became healthy: ${lastError}`);
}
