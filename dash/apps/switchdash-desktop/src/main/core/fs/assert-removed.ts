/**
 * Turn a {@link FileSystemProvider.remove} result into the `PluginFs.delete`
 * contract: absent is success, everything else throws.
 *
 * `remove` never throws — it reports through `{ success, error }` — so a caller
 * that ignores the result swallows permission denied, a non-recursive directory,
 * a failed `rm -rf`, and a dropped connection alike. `delete` is how an agent's
 * Switch token is revoked from disk, so a silent no-op there reports a credential
 * as destroyed while it is still readable on the host.
 *
 * The not-found case is matched on the message because the result carries no
 * error code; the literal is the one produced by `SshFileSystem.remove` when its
 * `stat` finds nothing. Prefer a structured code on the result if one is ever
 * added — message matching is the weakest part of this check.
 */
export function assertRemoved(path: string, result: { success: boolean; error?: string }): void {
  if (result.success) return;
  const error = result.error ?? 'unknown error';
  if (error.startsWith('File not found')) return;
  throw new Error(`remote plugin fs: failed to delete ${path}: ${error}`);
}
