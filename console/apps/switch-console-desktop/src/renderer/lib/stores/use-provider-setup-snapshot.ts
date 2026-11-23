import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import type { ProviderSetupSnapshot } from '@shared/core/provider-setup/provider-setup';
import { providerSetupChannel } from '@shared/events/appEvents';

/**
 * A provider's setup on this computer: as it stands when asked for, which
 * checks it where it is not current, then each change as it comes. Null
 * until the first answer.
 */
export function useProviderSetupSnapshot(provider: string): ProviderSetupSnapshot | null {
  const [snapshot, setSnapshot] = useState<ProviderSetupSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A change that arrives while asking is newer than the answer.
    let changed = false;
    setSnapshot(null);
    const stop = events.on(providerSetupChannel, (next: ProviderSetupSnapshot) => {
      if (next.provider !== provider) return;
      changed = true;
      setSnapshot(next);
    });
    void (rpc.providerSetup.get(provider) as Promise<ProviderSetupSnapshot>).then((first) => {
      if (!cancelled && !changed) setSnapshot(first);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [provider]);

  return snapshot;
}
