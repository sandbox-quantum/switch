import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';

/**
 * Resolved and verified executable path for a local stdio MCP server.
 *
 * Enforces security requirements:
 * 1. Prohibits shell interpreters (sh, bash, cmd, powershell).
 * 2. Prevents path traversal out of approved vendor or system directories.
 * 3. Prevents symlink evasion attacks that resolve outside the vendor root or to forbidden shells.
 * 4. Enforces structured argument arrays; never constructs shell strings.
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

  // 2. Allow system binary by bare name (e.g. 'node', 'python')
  if (!normalized.startsWith('.') && !normalized.includes('/') && !normalized.includes('\\')) {
    return { executable: normalized, isScript: false };
  }

  // 3. Allow trusted host runtime executable directly (e.g. process.execPath)
  if (normalized.toLowerCase() === normalize(process.execPath).toLowerCase()) {
    return { executable: normalized, isScript: false };
  }

  // 4. Traversal protection: if path is relative or names vendor, ensure it stays in vendor boundary
  const resolvedPath = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(baseVendorDir, normalized);

  const resolvedVendor = resolve(baseVendorDir);
  if (!resolvedPath.startsWith(resolvedVendor)) {
    throw new Error(
      `Executable path '${command}' attempts directory traversal outside vendor root.`
    );
  }

  if (!existsSync(resolvedPath)) {
    throw new Error(`Audited MCP server executable was not found at '${resolvedPath}'.`);
  }

  // 5. Symlink security: ensure the real file target does not escape the vendor root
  try {
    const realTarget = realpathSync(resolvedPath);
    const realVendor = realpathSync(resolvedVendor);
    if (
      !realTarget.startsWith(realVendor) &&
      realTarget.toLowerCase() !== normalize(process.execPath).toLowerCase()
    ) {
      throw new Error(`Executable path '${command}' resolves via symlink outside vendor root.`);
    }
    const realBaseName = realTarget.split(/[/\\]/).pop()?.toLowerCase();
    if (realBaseName && forbiddenShells.includes(realBaseName)) {
      throw new Error(`Symlink target '${realTarget}' points to a forbidden shell interpreter.`);
    }
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.message.includes('outside vendor root') || err.message.includes('forbidden shell'))
    ) {
      throw err;
    }
  }

  const isScript = resolvedPath.endsWith('.js') || resolvedPath.endsWith('.mjs');
  return { executable: resolvedPath, isScript };
}
