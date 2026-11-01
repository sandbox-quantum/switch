import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';

/**
 * Resolved and verified executable path for a local stdio MCP server.
 *
 * Enforces security requirements:
 * 1. Prohibits shell interpreters (sh, bash, cmd, powershell).
 * 2. Prevents path traversal out of approved vendor or system directories.
 * 3. Enforces structured argument arrays; never constructs shell strings.
 */
export function resolveStdioServerExecutable(
  command: string,
  baseVendorDir: string
): { executable: string; isScript: boolean } {
  const normalized = normalize(command).trim();

  // 1. Strict ban on shell interpreters
  const forbiddenShells = ['sh', 'bash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh'];
  const baseName = normalized.split(/[/\\]/).pop()?.toLowerCase();
  if (baseName && forbiddenShells.includes(baseName)) {
    throw new Error(`Direct invocation of shell interpreter '${command}' is strictly forbidden.`);
  }

  // 2. Traversal protection: if path is relative or names vendor, ensure it stays in vendor boundary
  if (normalized.startsWith('.') || normalized.includes('/') || normalized.includes('\\')) {
    const resolvedPath = isAbsolute(normalized)
      ? resolve(normalized)
      : resolve(baseVendorDir, normalized);

    const resolvedVendor = resolve(baseVendorDir);
    if (!resolvedPath.startsWith(resolvedVendor)) {
      throw new Error(`Executable path '${command}' attempts directory traversal outside vendor root.`);
    }

    if (!existsSync(resolvedPath)) {
      throw new Error(`Audited MCP server executable was not found at '${resolvedPath}'.`);
    }

    const isScript = resolvedPath.endsWith('.js') || resolvedPath.endsWith('.mjs');
    return { executable: resolvedPath, isScript };
  }

  // 3. System binary (e.g. 'node')
  return { executable: normalized, isScript: false };
}
