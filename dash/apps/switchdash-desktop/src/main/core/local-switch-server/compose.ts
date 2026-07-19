import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '@main/lib/logger';
import { LOCAL_SERVER_PROFILES, LOCAL_SERVER_PROJECT_NAME } from './constants';
import { DOCKER_EXECUTABLE } from './docker';
import { composeFilePath, envFilePath, localServerDir } from './paths';

const execFileAsync = promisify(execFile);

/** Pulls can take minutes on a cold machine; give compose a generous ceiling. */
const COMPOSE_TIMEOUT_MS = 20 * 60 * 1000;

function profileArgs(): string[] {
  return LOCAL_SERVER_PROFILES.flatMap((p) => ['--profile', p]);
}

/** Base args that scope every invocation to the managed project + env file. */
function baseArgs(): string[] {
  return [
    'compose',
    '-f',
    composeFilePath(),
    '--env-file',
    envFilePath(),
    '--project-name',
    LOCAL_SERVER_PROJECT_NAME,
    ...profileArgs(),
  ];
}

async function runCompose(args: string[], timeout: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(DOCKER_EXECUTABLE, args, {
      cwd: localServerDir(),
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string } | undefined)?.stderr;
    const message = stderr?.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`docker ${args.join(' ')} failed: ${message}`);
  }
}

/**
 * Bring the stack up in the background (`up -d`), streaming each line of output
 * to `onLog` so the UI can show a live tail during the (slow) image pull.
 * Assumes the compose file and `.env` are written and GHCR login has run. docker
 * compose emits pull/startup progress on stderr, so both streams are forwarded.
 */
export function composeUp(onLog: (line: string) => void): Promise<void> {
  log.info('local-switch-server: docker compose up');
  return new Promise((resolve, reject) => {
    const args = [...baseArgs(), 'up', '-d'];
    const child = spawn(DOCKER_EXECUTABLE, args, { cwd: localServerDir() });
    let stderrTail = '';

    const emitLines = (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.length > 0) onLog(line);
      }
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`docker compose up timed out after ${COMPOSE_TIMEOUT_MS}ms`));
    }, COMPOSE_TIMEOUT_MS);

    child.stdout.on('data', emitLines);
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
      emitLines(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`docker compose up failed (exit ${code}): ${stderrTail.trim()}`));
    });
  });
}

/** Stop and remove the stack's containers. `removeVolumes` also destroys the
 * data volumes (the reset path) — irreversible. */
export async function composeDown(removeVolumes: boolean): Promise<void> {
  log.info(`local-switch-server: docker compose down${removeVolumes ? ' -v' : ''}`);
  await runCompose([...baseArgs(), 'down', ...(removeVolumes ? ['-v'] : [])], 5 * 60 * 1000);
}

/** Service names currently in the `running` state for the managed project. */
export async function runningServices(): Promise<string[]> {
  try {
    const stdout = await runCompose(
      [...baseArgs(), 'ps', '--status', 'running', '--services'],
      60_000
    );
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (error) {
    log.warn('local-switch-server: `compose ps` failed; treating stack as down', { error });
    return [];
  }
}

/** Whether the core `switch` service is up — our proxy for "the stack is up". */
export async function isStackRunning(): Promise<boolean> {
  return (await runningServices()).includes('switch');
}
