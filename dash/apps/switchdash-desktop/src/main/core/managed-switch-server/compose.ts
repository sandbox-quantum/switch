import { log } from '@main/lib/logger';
import { COMPOSE_FILE_NAME, ENV_FILE_NAME, LOCAL_SERVER_PROFILES } from './constants';
import type { ServerHost } from './host/types';

/** Pulls can take minutes on a cold machine; give compose a generous ceiling. */
const COMPOSE_TIMEOUT_MS = 20 * 60 * 1000;

function profileArgs(): string[] {
  return LOCAL_SERVER_PROFILES.flatMap((p) => ['--profile', p]);
}

/** Base args that scope every invocation to the managed project + env file.
 * Relative file names resolve against the host working dir (the ctx root). */
function baseArgs(host: ServerHost): string[] {
  return [
    'compose',
    '-f',
    COMPOSE_FILE_NAME,
    '--env-file',
    ENV_FILE_NAME,
    '--project-name',
    host.composeProjectName,
    ...profileArgs(),
  ];
}

async function runCompose(host: ServerHost, args: string[], timeout: number): Promise<string> {
  const full = [host.dockerBin, ...args];
  try {
    const { stdout } = await host.ctx.exec(host.dockerBin, args, {
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string } | undefined)?.stderr;
    const message = stderr?.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`${full.join(' ')} failed: ${message}`);
  }
}

/**
 * Bring the stack up in the background (`up -d`), streaming each line of output
 * to `onLog` so the UI can show a live tail during the (slow) image pull.
 * Assumes the compose file and `.env` are written and GHCR login has run.
 */
export function composeUp(host: ServerHost, onLog: (line: string) => void): Promise<void> {
  log.info(`local-switch-server: docker compose up (${host.label})`);
  return host.streamCommand(host.dockerBin, [...baseArgs(host), 'up', '-d'], onLog, {
    timeoutMs: COMPOSE_TIMEOUT_MS,
  });
}

/** Stop and remove the stack's containers. `removeVolumes` also destroys the
 * data volumes (the reset path) — irreversible. */
export async function composeDown(host: ServerHost, removeVolumes: boolean): Promise<void> {
  log.info(`local-switch-server: docker compose down${removeVolumes ? ' -v' : ''} (${host.label})`);
  await runCompose(
    host,
    [...baseArgs(host), 'down', ...(removeVolumes ? ['-v'] : [])],
    5 * 60 * 1000
  );
}

/** Service names currently in the `running` state for the managed project. */
export async function runningServices(host: ServerHost): Promise<string[]> {
  try {
    const stdout = await runCompose(
      host,
      [...baseArgs(host), 'ps', '--status', 'running', '--services'],
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
export async function isStackRunning(host: ServerHost): Promise<boolean> {
  return (await runningServices(host)).includes('switch');
}
