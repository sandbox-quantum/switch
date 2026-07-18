import { err, ok } from '@switchdash/shared';
import { fsEvents } from '@main/core/fs/fs-events';
import { resolveLocationRuntime } from '@main/core/locations/utils';
import { events } from '@main/lib/events';
import { fsWatchEventChannel } from '@shared/core/fs/fsEvents';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { type FileWatcher } from './types';

// One watcher per location, shared across all consumers via labels.
// Local: single recursive @parcel/watcher subscription — update() is a no-op.
// SSH:   poll-based — update() receives the union of all labels' paths to poll.
const watcherRegistry = new Map<string, FileWatcher>();
// Per-label path groups, keyed by location id → label → paths.
// Paths are forwarded to update() for SSH compatibility; local ignores them.
const watcherLabeledPaths = new Map<string, Map<string, string[]>>();

export const filesController = createRPCController({
  watchSetPaths: async (locationId: string, paths: string[], label = 'default') => {
    const env = resolveLocationRuntime(locationId);
    if (!env) {
      return err({ type: 'not_found' as const, entity: 'filesystem' as const, detail: undefined });
    }

    if (!env.fs.watch) {
      return ok({ supported: false as const });
    }

    const groups = watcherLabeledPaths.get(locationId) ?? new Map<string, string[]>();
    groups.set(label, paths);
    watcherLabeledPaths.set(locationId, groups);
    const union = [...new Set([...groups.values()].flat())];

    const existing = watcherRegistry.get(locationId);
    if (existing) {
      existing.update(union);
    } else {
      const watcher = env.fs.watch((evts) => {
        const event = { locationId, events: evts };
        events.emit(fsWatchEventChannel, event);
        fsEvents.emitWatchEvent(event);
      });
      watcher.update(union);
      watcherRegistry.set(locationId, watcher);
    }
    return ok({ supported: true as const });
  },

  watchStop: async (locationId: string, label = 'default') => {
    const groups = watcherLabeledPaths.get(locationId);
    groups?.delete(label);

    if (!groups?.size) {
      watcherLabeledPaths.delete(locationId);
      watcherRegistry.get(locationId)?.close();
      watcherRegistry.delete(locationId);
    } else {
      const union = [...new Set([...groups.values()].flat())];
      watcherRegistry.get(locationId)?.update(union);
    }
    return ok({});
  },
});
