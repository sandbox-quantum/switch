import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { ProviderUnavailableError } from '../adapter';
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
  const configHome = await prepareOpencodeHome(input.config, input.skills, input.env);
  const port = await findFreePort();

  const child = spawn(input.binaryPath, ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
    cwd: input.cwd,
    env: {
      ...input.env,
      XDG_CONFIG_HOME: configHome,
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
        child.kill('SIGKILL');
        reject(
          new ProviderUnavailableError(
            'opencode',
            `server did not start within ${input.startupTimeoutMs}ms: ${output.trim()}`
          )
        );
      });
    }, input.startupTimeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (!line.startsWith(READY_PREFIX)) continue;
        const match = line.match(/on\s+(https?:\/\/\S+)/);
        if (!match?.[1]) continue;
        finish(() => resolve(match[1] as string));
        return;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      finish(() =>
        reject(new ProviderUnavailableError('opencode', 'could not spawn', { cause: error }))
      );
    });
    child.on('exit', (code) => {
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
}

async function waitForHealth(url: string, authorization: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/global/health`, { headers: { authorization } });
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
