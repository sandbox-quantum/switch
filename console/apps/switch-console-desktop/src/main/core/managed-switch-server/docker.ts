import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveExecutable, windowsInstallPath } from '@main/core/utils/resolve-executable';
import { log } from '@main/lib/logger';
import type { DockerAvailability } from '@shared/core/managed-switch-server/managed-switch-server';

const execFileAsync = promisify(execFile);

function dockerCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    '/opt/homebrew/bin/docker',
    '/usr/local/bin/docker',
    '/usr/bin/docker',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
    path.join(os.homedir(), '.rd', 'bin', 'docker'),
    windowsInstallPath(env, 'ProgramFiles', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
    windowsInstallPath(
      env,
      'LOCALAPPDATA',
      'Programs',
      'Docker',
      'Docker',
      'resources',
      'bin',
      'docker.exe'
    ),
    windowsInstallPath(
      env,
      'LOCALAPPDATA',
      'Programs',
      'Rancher Desktop',
      'resources',
      'resources',
      'win32',
      'bin',
      'docker.exe'
    ),
  ].filter((candidate): candidate is string => candidate !== null);
}

export function resolveDockerBin(env: NodeJS.ProcessEnv = process.env): string {
  return resolveExecutable('docker', {
    overridePath: env.DOCKER_PATH,
    candidates: dockerCandidates(env),
    env,
  });
}

let resolvedDockerExecutable: string | null = null;

/**
 * Path to the Docker CLI, memoized only once a real binary is found. A run that
 * had to fall back to the bare name is not cached, so installing Docker while
 * the app is open is picked up on the next call instead of after a restart.
 */
export function dockerExecutable(): string {
  if (resolvedDockerExecutable !== null) return resolvedDockerExecutable;
  const resolved = resolveDockerBin();
  if (resolved !== 'docker') resolvedDockerExecutable = resolved;
  return resolved;
}

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
  // EINVAL is what a shell-less spawn of a Windows .cmd/.bat shim raises, and
  // ENOTDIR what a stale directory component raises: neither is a live daemon.
  if (code === 'ENOENT' || code === 'EINVAL' || code === 'ENOTDIR') {
    return { reason: 'not-installed', detail: 'The Docker CLI was not found on this system.' };
  }
  if (
    /cannot connect to the docker daemon|is the docker daemon running|error during connect|open \/\/\.\/pipe\/|pipe[\\/]docker_engine|the system cannot find the file specified/i.test(
      message
    )
  ) {
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
      dockerExecutable(),
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
