import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import {
  allFeatureFlagsOff,
  type FeatureFlagKey,
  type FeatureFlags,
  FLAGS_NOT_READ_YET,
  type ServerFeatureFlags,
} from '@shared/core/feature-flags/feature-flags';
import { featureFlagsChangedChannel } from '@shared/events/featureFlagEvents';

/**
 * Each server's flags as this window learned them: read before the window is
 * first drawn (`preloadFeatureFlags`), then kept up to date by the main
 * process's change events. Read by the hook's first render, so a component
 * drawn after the flags are known is drawn with them, rather than with every
 * flag off and then again — the flicker of a sidebar or a page laid out for
 * the wrong flags.
 */
const known = new Map<string, FeatureFlags>();

function remember(serverId: string, flags: FeatureFlags): FeatureFlags {
  known.set(serverId, flags);
  return flags;
}

/**
 * Reads each server's flags now, those never read before from its gateway,
 * so the window can wait for them before drawing what they decide. Gives up
 * after `timeoutMs`: a server that does not answer is drawn with its flags
 * off, as before, rather than holding the window.
 */
export async function preloadFeatureFlags(serverIds: string[], timeoutMs: number): Promise<void> {
  const reads = Promise.all(
    serverIds.map(async (serverId) => {
      const res = await rpc.featureFlags.current(serverId);
      if (res?.success) remember(serverId, res.data.flags);
    })
  );
  await Promise.race([reads, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

/**
 * A Switch server's feature flags, kept current: the hook re-renders when the
 * main process sees the server's flags change, so a redeploy that turns one on
 * or off applies without restarting Console. Every flag is off until the flags
 * have been read, and stays off for a server whose flags never could be.
 */
export function useFeatureFlags(serverId: string | null | undefined): FeatureFlags {
  const [flags, setFlags] = useState<FeatureFlags>(
    () => (serverId ? known.get(serverId) : undefined) ?? allFeatureFlagsOff()
  );

  useEffect(() => {
    setFlags((serverId ? known.get(serverId) : undefined) ?? allFeatureFlagsOff());
    if (!serverId) return;
    let current = true;
    const off = events.on(featureFlagsChangedChannel, (state) => {
      if (state.serverId === serverId) setFlags(remember(serverId, state.flags));
    });
    void rpc.featureFlags.get(serverId).then((res) => {
      if (current && res?.success && res.data.fetchedAt !== null) setFlags(res.data.flags);
    });
    return () => {
      current = false;
      off();
    };
  }, [serverId]);

  return flags;
}

/** Whether a server's flags say anything yet: read once, or tried and failed (then they stay off). */
export function flagsSettled(state: Pick<ServerFeatureFlags, 'fetchedAt' | 'error'>): boolean {
  return state.fetchedAt !== null || (state.error !== null && state.error !== FLAGS_NOT_READ_YET);
}

/**
 * Whether a server's flags are known yet, kept current. Before they are, what
 * they decide is unknown, and a view that would show the wrong thing either
 * way can wait for them.
 */
export function useFeatureFlagsKnown(serverId: string | null | undefined): boolean {
  const [settled, setSettled] = useState(() => (serverId ? known.has(serverId) : true));
  useEffect(() => {
    if (!serverId) {
      setSettled(true);
      return;
    }
    setSettled(known.has(serverId));
    let current = true;
    const off = events.on(featureFlagsChangedChannel, (state) => {
      if (state.serverId === serverId && flagsSettled(state)) setSettled(true);
    });
    void rpc.featureFlags.get(serverId).then((res) => {
      if (current && res?.success && flagsSettled(res.data)) setSettled(true);
    });
    return () => {
      current = false;
      off();
    };
  }, [serverId]);
  return settled;
}

/**
 * Whether any connected server turns `key` on, kept current. For what Console
 * shows outside any one server — a settings page about every server's agents —
 * and off until a server has been read that turns it on.
 */
export function useAnyServerFeatureFlag(key: FeatureFlagKey): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let current = true;
    const read = () =>
      void rpc.featureFlags.anyEnabled(key).then((res) => {
        if (current && res?.success) setEnabled(res.data);
      });
    const off = events.on(featureFlagsChangedChannel, read);
    read();
    return () => {
      current = false;
      off();
    };
  }, [key]);

  return enabled;
}
