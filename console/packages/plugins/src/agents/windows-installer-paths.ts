/**
 * Folders under `%LOCALAPPDATA%` that Windows provider installers put a CLI in
 * and add to the user's PATH, which an app or controller started before the
 * install does not see:
 * - Cursor's `install?win32=true` script: `cursor-agent\` (`agent.cmd`, `cursor-agent.cmd`)
 * - Kiro's MSI, run by `install.ps1`: `Kiro-Cli\` (`kiro-cli.exe`)
 */
const WINDOWS_INSTALLER_DIRS = ['cursor-agent', 'Kiro-Cli'] as const;

/**
 * A Windows PATH value with each of those folders added after its entries when
 * missing, and `path` unchanged otherwise. They go last, as they do in a
 * terminal opened since, so a CLI already on PATH still wins and Switch
 * Console and the agent controller resolve the same one.
 */
export function withWindowsInstallerBinDirs(
  path: string,
  localAppData: string | undefined
): string {
  if (!localAppData) return path;
  const base = localAppData.replace(/[\\/]+$/, '');
  const entries = path.split(';').filter(Boolean);
  const normalized = new Set(entries.map((entry) => entry.replace(/[\\/]+$/, '').toLowerCase()));
  const missing = WINDOWS_INSTALLER_DIRS.map((dir) => `${base}\\${dir}`).filter(
    (dir) => !normalized.has(dir.toLowerCase())
  );
  return missing.length === 0 ? path : [...entries, ...missing].join(';');
}
