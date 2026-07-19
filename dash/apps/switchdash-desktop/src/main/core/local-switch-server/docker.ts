import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { log } from '@main/lib/logger';
import type { DockerAvailability } from '@shared/core/local-switch-server/local-switch-server';

const execFileAsync = promisify(execFile);

function resolveDockerBin(): string {
  const candidates = [
    (process.env.DOCKER_PATH || '').trim(),
    '/opt/homebrew/bin/docker',
    '/usr/local/bin/docker',
    '/usr/bin/docker',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return 'docker';
}

/** Resolved path to the Docker CLI. */
export const DOCKER_EXECUTABLE = resolveDockerBin();

/**
 * Classify a failed `docker version` invocation into the DockerAvailability
 * "unavailable" shape. Pure so it can be unit-tested against the two failure
 * modes we care about: the binary is missing (ENOENT) vs the daemon is down
 * (the CLI runs but can't reach the socket).
 */
export function classifyDockerError(error: unknown): {
  reason: 'not-installed' | 'daemon-down';
  detail: string;
} {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT') {
    return { reason: 'not-installed', detail: 'The Docker CLI was not found on this system.' };
  }
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(message)) {
    return {
      reason: 'daemon-down',
      detail: 'Docker is installed but the daemon is not running. Start Docker Desktop and retry.',
    };
  }
  return { reason: 'daemon-down', detail: message };
}

/**
 * Detect whether Docker is usable: the CLI resolves AND the daemon answers.
 * `docker version --format {{.Server.Version}}` fails (non-zero exit) when the
 * daemon is unreachable, which is exactly the signal we want — a plain
 * `docker --version` would succeed even with the daemon down.
 */
export async function detectDocker(): Promise<DockerAvailability> {
  try {
    const { stdout } = await execFileAsync(
      DOCKER_EXECUTABLE,
      ['version', '--format', '{{.Server.Version}}'],
      { timeout: 15_000 }
    );
    const version = stdout.trim();
    if (!version) {
      return {
        available: false,
        reason: 'daemon-down',
        detail: 'Docker daemon reported no version.',
      };
    }
    return { available: true, version };
  } catch (error) {
    const { reason, detail } = classifyDockerError(error);
    log.info(`local-switch-server: docker unavailable (${reason})`);
    return { available: false, reason, detail };
  }
}
