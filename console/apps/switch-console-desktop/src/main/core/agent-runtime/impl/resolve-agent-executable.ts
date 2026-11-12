import type { DependencyId } from '@switch-console/core/deps/runtime';
import { resolveCommandPath } from '@switch-console/core/deps/runtime';
import type { IHostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { log } from '@main/lib/logger';

/**
 * Per-context cache: keyed by `${connectionId ?? 'local'}:${providerId}` → resolved absolute path.
 * Populated on first successful resolution; cleared when a new installation is triggered.
 */
const resolvedPathCache = new Map<string, string>();

export function clearResolvedPathCache(providerId: string, connectionId?: string): void {
  resolvedPathCache.delete(cacheKey(providerId, connectionId));
}

function cacheKey(providerId: string, connectionId?: string): string {
  return `${connectionId ?? 'local'}:${providerId}`;
}

/** The executable to run, and why the one chosen in Settings is not it, when it is not. */
export type ResolvedAgentExecutable = {
  path: string;
  /** Said for a person: the saved choice could not be used. Null when there was none, or it was. */
  selectionProblem: string | null;
};

/**
 * Resolve the absolute path of the agent binary to use for agent spawns.
 *
 * Resolution order:
 * 1. selection.kind === 'pinned': use selection.realpath if it exists on disk; otherwise fall through.
 * 2. selection.kind === 'path': use selection.path if it exists on disk; otherwise fall through.
 * 3. selection.kind === 'cli': return selection.command as-is (the execution host resolves PATH).
 * 4. selection.kind === 'method' or 'auto' (no override): fall through to cachedStatePath.
 * 5. auto:
 *    a. In-memory cached path from dependency probe (cachedStatePath).
 *    b. Probe via ctx (resolveCommandPath).
 *    c. Bare binaryName.
 *    d. providerId as last resort.
 */
export async function resolveAgentExecutable(
  params: Parameters<typeof resolveAgentExecutableWithReason>[0]
): Promise<string> {
  return (await resolveAgentExecutableWithReason(params)).path;
}

/**
 * As `resolveAgentExecutable`, and also says why a pinned or path selection
 * was passed over, so a check that then finds nothing can name the file the
 * person chose rather than report the CLI as simply not installed.
 */
export async function resolveAgentExecutableWithReason({
  providerId,
  binaryName,
  ctx,
  hostDependencyStore,
  cachedStatePath,
  connectionId,
}: {
  providerId: string;
  binaryName: string;
  ctx: IExecutionContext;
  /** Store for reading the persisted host-scoped installation selection. */
  hostDependencyStore: IHostDependencyStore;
  /** The absolute path the dependency manager resolved during its last probe, if available. */
  cachedStatePath?: string | null;
  connectionId?: string;
}): Promise<ResolvedAgentExecutable> {
  const hostId = connectionId ?? 'local';
  const selection = await hostDependencyStore.getSelection(hostId, providerId as DependencyId);
  let selectionProblem: string | null = null;

  if (selection?.kind === 'pinned' || selection?.kind === 'path') {
    const chosen = selection.kind === 'pinned' ? selection.realpath : selection.path;
    if (chosen) {
      if (await resolveCommandPath(chosen, ctx)) return { path: chosen, selectionProblem: null };
      log.warn(
        `[resolveAgentExecutable] ${selection.kind === 'pinned' ? 'Pinned realpath' : 'Saved path'} "${chosen}" for ${providerId} not found — falling back to auto-resolution`
      );
      selectionProblem = `The executable chosen in Settings, ${chosen}, was not found on this machine.`;
    } else {
      selectionProblem = 'A path override is selected in Settings, but no path was saved for it.';
    }
  }

  if (selection?.kind === 'cli') {
    return { path: selection.command, selectionProblem: null };
  }

  // Auto-resolution with in-memory cache
  const key = cacheKey(providerId, connectionId);
  const cached = resolvedPathCache.get(key);
  if (cached) return { path: cached, selectionProblem };

  // Use the dependency manager's in-memory probe result if available
  if (cachedStatePath) {
    resolvedPathCache.set(key, cachedStatePath);
    return { path: cachedStatePath, selectionProblem };
  }

  // Live resolution via execution context
  const resolved = await resolveCommandPath(binaryName, ctx);
  if (resolved) {
    resolvedPathCache.set(key, resolved);
    return { path: resolved, selectionProblem };
  }

  log.warn(
    `[resolveAgentExecutable] Could not resolve binary "${binaryName}" for ${providerId} — using bare name`
  );
  return { path: binaryName || providerId, selectionProblem };
}
