import { err, ok } from '@switchdash/shared';
import { fsEvents } from '@main/core/fs/fs-events';
import { events } from '@main/lib/events';
import { fsWatchEventChannel } from '@shared/core/fs/fsEvents';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { resolveWorkspace } from '../projects/utils';
import { type FileWatcher } from './types';

// One watcher per (projectId, workspaceId) pair, shared across all consumers via labels.
// Local: single recursive @parcel/watcher subscription — update() is a no-op.
// SSH:   poll-based — update() receives the union of all labels' paths to poll.
const watcherRegistry = new Map<string, FileWatcher>();
// Per-label path groups, keyed by `${projectId}::${workspaceId}` → label → paths.
// Paths are forwarded to update() for SSH compatibility; local ignores them.
const watcherLabeledPaths = new Map<string, Map<string, string[]>>();

export const filesController = createRPCController({
  watchSetPaths: async (
    projectId: string,
    workspaceId: string,
    paths: string[],
    label = 'default'
  ) => {
    const env = resolveWorkspace(projectId, workspaceId);
    if (!env) {
      return err({ type: 'not_found' as const, entity: 'filesystem' as const, detail: undefined });
    }

    if (!env.fs.watch) {
      return ok({ supported: false as const });
    }

    const key = `${projectId}::${workspaceId}`;
    const groups = watcherLabeledPaths.get(key) ?? new Map<string, string[]>();
    groups.set(label, paths);
    watcherLabeledPaths.set(key, groups);
    const union = [...new Set([...groups.values()].flat())];

    const existing = watcherRegistry.get(key);
    if (existing) {
      existing.update(union);
    } else {
      const watcher = env.fs.watch((evts) => {
        const event = { projectId, workspaceId, events: evts };
        events.emit(fsWatchEventChannel, event);
        fsEvents.emitWatchEvent(event);
      });
      watcher.update(union);
      watcherRegistry.set(key, watcher);
    }
    return ok({ supported: true as const });
  },

  watchStop: async (projectId: string, workspaceId: string, label = 'default') => {
    const key = `${projectId}::${workspaceId}`;
    const groups = watcherLabeledPaths.get(key);
    groups?.delete(label);

    if (!groups?.size) {
      watcherLabeledPaths.delete(key);
      watcherRegistry.get(key)?.close();
      watcherRegistry.delete(key);
    } else {
      const union = [...new Set([...groups.values()].flat())];
      watcherRegistry.get(key)?.update(union);
    }
    return ok({});
  },
});
