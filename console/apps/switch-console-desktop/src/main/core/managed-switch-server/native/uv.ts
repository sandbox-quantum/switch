import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getWindowsEnvValue } from '@switch-console/core/exec';
import { findExecutableOnPath } from '@main/core/utils/resolve-executable';
import { log } from '@main/lib/logger';
import { installPinnedArchive } from './download';
import { exe, type NativeLayout } from './native-paths';
import { currentNativePlatform, UV_VERSION, uvArchive } from './toolchain-pins';

const execFileAsync = promisify(execFile);

export type UvBinary = { path: string; version: string; source: 'installed' | 'downloaded' };

/** `uv 0.11.33 (x86_64-unknown-linux-gnu)` → `0.11.33`. */
export function parseUvVersion(output: string): string | null {
  const match = /^uv\s+(\d+\.\d+\.\d+\S*)/m.exec(output.trim());
  return match ? match[1] : null;
}

async function probeUv(file: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, ['--version'], {
      timeout: 15_000,
      windowsHide: true,
    });
    return parseUvVersion(stdout);
  } catch {
    return null;
  }
}

/** The oldest uv the install relies on: `uv sync --frozen` honouring
 * `UV_PROJECT_ENVIRONMENT` and managed Python downloads. */
const MIN_UV = [0, 5, 0] as const;

function atLeastMinimum(version: string): boolean {
  const parts = version.split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== MIN_UV[i]) return (parts[i] ?? 0) > MIN_UV[i];
  }
  return true;
}

function installedCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = os.homedir();
  const candidates = [
    findExecutableOnPath('uv', env),
    path.join(home, '.local', 'bin', exe('uv')),
    path.join(home, '.cargo', 'bin', exe('uv')),
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
  ];
  const localAppData = getWindowsEnvValue(env, 'LOCALAPPDATA');
  if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'uv', 'uv.exe'));
  return [...new Set(candidates.filter((c): c is string => c !== null))];
}

/**
 * The uv to install switch-core with: an installed one when it is recent
 * enough, otherwise the pinned release, downloaded into the local server's
 * toolchain directory (and reused from there on later starts).
 */
export async function resolveUv(
  layout: NativeLayout,
  onMessage: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<UvBinary> {
  for (const candidate of installedCandidates(env)) {
    const version = await probeUv(candidate);
    if (version === null) continue;
    if (!atLeastMinimum(version)) {
      log.info(`local-switch-server: skipping uv ${version} at ${candidate} (too old)`);
      continue;
    }
    return { path: candidate, version, source: 'installed' };
  }

  const platform = currentNativePlatform();
  if (!platform) {
    throw new Error(
      `uv is not installed, and there is no build of it to download for ` +
        `${process.platform}-${process.arch}. Install uv (https://docs.astral.sh/uv/), then start again.`
    );
  }
  const dir = path.join(layout.toolchain, `uv-${UV_VERSION}`);
  const binary = path.join(dir, exe('uv'));
  let version = await probeUv(binary);
  if (version === null) {
    onMessage(`Downloading uv ${UV_VERSION}…`);
    await installPinnedArchive(uvArchive(platform), layout.downloads, dir);
    version = await probeUv(binary);
    if (version === null) throw new Error(`The downloaded uv in ${dir} does not run.`);
  }
  return { path: binary, version, source: 'downloaded' };
}
