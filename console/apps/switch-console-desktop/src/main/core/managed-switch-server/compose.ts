import { log } from '@main/lib/logger';
import {
  BUILD_OVERRIDE_FILE_NAME,
  COMPOSE_FILE_NAME,
  ENV_FILE_NAME,
  LOCAL_SERVER_PROFILES,
} from './constants';
import type { ServerHost } from './host/types';

/** Pulls can take minutes on a cold machine; give compose a generous ceiling. */
const COMPOSE_TIMEOUT_MS = 20 * 60 * 1000;

function profileArgs(): string[] {
  return LOCAL_SERVER_PROFILES.flatMap((p) => ['--profile', p]);
}

/** Base args that scope every invocation to the managed project + env file.
 * Relative file names resolve against the host working dir (the ctx root). */
function baseArgs(host: ServerHost, globalFlags: string[], extraFiles: string[] = []): string[] {
  return [
    'compose',
    ...globalFlags,
    '-f',
    COMPOSE_FILE_NAME,
    ...extraFiles.flatMap((file) => ['-f', file]),
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
 *
 * `fromCheckout` layers the dev-only build override on top of the compose file
 * and adds `--build`, so the stack's images come from the developer's working
 * tree instead of the registry (see checkout-build.ts). The override must
 * already be written to the host working dir.
 */
export function composeUp(
  host: ServerHost,
  onLog: (line: string) => void,
  fromCheckout: boolean
): Promise<void> {
  log.info(
    `local-switch-server: docker compose up (${host.label})${fromCheckout ? ' from local checkout' : ''}`
  );
  // Compose already falls back to plain, line-per-event output when it is not
  // attached to a TTY, which is how we always run it — so this pins the
  // behaviour we depend on rather than changing it. `--progress` belongs to
  // `compose`, not to `up`; after the subcommand it exits with "unknown flag".
  const overrides = fromCheckout ? [BUILD_OVERRIDE_FILE_NAME] : [];
  return host.streamCommand(
    host.dockerBin,
    [
      ...baseArgs(host, ['--progress', 'plain'], overrides),
      'up',
      '-d',
      ...(fromCheckout ? ['--build'] : []),
    ],
    onLog,
    { timeoutMs: COMPOSE_TIMEOUT_MS }
  );
}

/** Stop and remove the stack's containers. `removeVolumes` also destroys the
 * data volumes (the reset path) — irreversible. */
export async function composeDown(host: ServerHost, removeVolumes: boolean): Promise<void> {
  log.info(`local-switch-server: docker compose down${removeVolumes ? ' -v' : ''} (${host.label})`);
  await runCompose(
    host,
    [...baseArgs(host, []), 'down', ...(removeVolumes ? ['-v'] : [])],
    5 * 60 * 1000
  );
}

/** Service names currently in the `running` state for the managed project. */
export async function runningServices(host: ServerHost): Promise<string[]> {
  try {
    const stdout = await runCompose(
      host,
      [...baseArgs(host, []), 'ps', '--status', 'running', '--services'],
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

/**
 * Image reference of each running container, keyed by compose service name —
 * the ground truth for what the stack is actually running, as opposed to what
 * the `.env` last asked for.
 *
 * Unlike {@link runningServices} this does NOT swallow failures: a caller
 * deciding whether an upgrade or downgrade is in play must be able to tell
 * "nothing is running" from "could not ask".
 */
export async function runningImages(host: ServerHost): Promise<Map<string, string>> {
  const stdout = await runCompose(
    host,
    [...baseArgs(host, []), 'ps', '--status', 'running', '--format', 'json'],
    60_000
  );
  const images = new Map<string, string>();
  for (const entry of parseComposePs(stdout)) {
    if (entry.Service && entry.Image) images.set(entry.Service, entry.Image);
  }
  return images;
}

type ComposePsEntry = { Service?: string; Image?: string };

/** Compose emits `ps --format json` as a JSON array on some versions and as
 * one JSON object per line on others; accept both. */
function parseComposePs(stdout: string): ComposePsEntry[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as ComposePsEntry[]) : [];
  }
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as ComposePsEntry);
}
