import type { DependencyId, HostDependencySelection } from '@switch-console/core/deps/runtime';
import { normalizeSelection } from '@switch-console/core/deps/runtime';
import { KV } from '@main/db/kv';

const LOCAL_HOST_ID = 'local';

/**
 * Persistence for host-scoped installation selections. Owned entirely by the
 * desktop app; the shared HostDependencyManager only reads selections through
 * its injected `getSelection` option.
 *
 * Stores InstallOverride | null (null = auto). Legacy {usedId,path?,cli?} values
 * are normalized on read via normalizeSelection.
 */
export interface IHostDependencyStore {
  getSelection(hostId: string, depId: DependencyId): Promise<HostDependencySelection | null>;
  setSelection(
    hostId: string,
    depId: DependencyId,
    selection: HostDependencySelection
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local store (KV table)
// ---------------------------------------------------------------------------

type LocalHostDepKV = {
  selections: Record<string, unknown>;
};

class LocalHostDependencyStore implements IHostDependencyStore {
  private readonly kv = new KV<LocalHostDepKV>('host-dep');

  async getSelection(hostId: string, depId: DependencyId): Promise<HostDependencySelection | null> {
    if (hostId !== LOCAL_HOST_ID) return null;
    const all = await this.kv.get('selections');
    const raw = all?.[depId];
    // normalizeSelection handles both new discriminated-union and legacy {usedId,path?,cli?} format
    return normalizeSelection(raw);
  }

  async setSelection(
    hostId: string,
    depId: DependencyId,
    selection: HostDependencySelection
  ): Promise<void> {
    if (hostId !== LOCAL_HOST_ID) return;
    const all = (await this.kv.get('selections')) ?? {};
    if (selection === null) {
      // null = auto: remove the entry rather than storing {kind:'auto'}
      delete all[depId];
    } else {
      all[depId] = selection;
    }
    await this.kv.set('selections', all);
  }
}

export const hostDependencyStore: IHostDependencyStore = new LocalHostDependencyStore();
