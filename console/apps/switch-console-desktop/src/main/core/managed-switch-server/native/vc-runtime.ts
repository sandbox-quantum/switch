import { access } from 'node:fs/promises';
import path from 'node:path';
import { getWindowsEnvValue } from '@switch-console/core/exec';

/**
 * The portable PostgreSQL for Windows is built with MSVC and links the Visual
 * C++ runtime, which it does not ship: `postgres.exe`, `initdb.exe` and
 * `pg_ctl.exe` import `VCRUNTIME140.dll`. Windows 10 and 11 carry the
 * Universal CRT but not this, so on a clean machine they fail to load until
 * the Visual C++ Redistributable is installed. An installed PostgreSQL (the
 * EDB installer) brings the redistributable with it.
 */
export const VC_RUNTIME_DLL = 'vcruntime140.dll';
export const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

/** STATUS_DLL_NOT_FOUND, as Node reports a process that could not load. */
const STATUS_DLL_NOT_FOUND = 0xc0000135;

export function isDllNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' && code >>> 0 === STATUS_DLL_NOT_FOUND;
}

export class VcRuntimeMissingError extends Error {
  constructor() {
    super(
      'PostgreSQL needs the Microsoft Visual C++ Redistributable (x64), which this computer ' +
        `does not have. Install it from ${VC_REDIST_URL}, then start the server again.`
    );
    this.name = 'VcRuntimeMissingError';
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether PostgreSQL in `binDir` can find the Visual C++ runtime: beside the
 * binaries, which Windows searches first, or in System32, where the
 * redistributable puts it. Always true off Windows.
 */
export async function hasVcRuntime(
  binDir: string | null,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<boolean> {
  if (platform !== 'win32') return true;
  if (binDir !== null && (await exists(path.join(binDir, VC_RUNTIME_DLL)))) return true;
  const systemRoot = getWindowsEnvValue(env, 'SystemRoot') ?? 'C:\\Windows';
  return exists(path.join(systemRoot, 'System32', VC_RUNTIME_DLL));
}

/** Throw a clear error when the portable PostgreSQL in `binDir` cannot load
 * for want of the Visual C++ runtime. */
export async function assertVcRuntime(binDir: string | null): Promise<void> {
  if (!(await hasVcRuntime(binDir, process.env, process.platform))) {
    throw new VcRuntimeMissingError();
  }
}
