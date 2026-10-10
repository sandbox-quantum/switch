import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import {
  allFeatureFlagsOff,
  type FeatureFlagKey,
  type FeatureFlags,
} from '@shared/core/feature-flags/feature-flags';
import { featureFlagsChangedChannel } from '@shared/events/featureFlagEvents';

/**
 * A Switch server's feature flags, kept current: the hook re-renders when the
 * main process sees the server's flags change, so a redeploy that turns one on
 * or off applies without restarting Console. Every flag is off until the flags
 * have been read, and stays off for a server whose flags never could be.
 */
export function useFeatureFlags(serverId: string | null | undefined): FeatureFlags {
  const [flags, setFlags] = useState<FeatureFlags>(allFeatureFlagsOff);

  useEffect(() => {
    setFlags(allFeatureFlagsOff());
    if (!serverId) return;
    let current = true;
    const off = events.on(featureFlagsChangedChannel, (state) => {
      if (state.serverId === serverId) setFlags(state.flags);
    });
    void rpc.featureFlags.get(serverId).then((res) => {
      if (current && res?.success) setFlags(res.data.flags);
    });
    return () => {
      current = false;
      off();
    };
  }, [serverId]);

  return flags;
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
