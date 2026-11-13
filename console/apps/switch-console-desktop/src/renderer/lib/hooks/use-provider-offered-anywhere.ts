import { useCallback } from 'react';
import { useAnyServerFeatureFlag } from '@renderer/lib/hooks/useFeatureFlags';
import {
  type AgentProviderId,
  PROVIDER_FLAGS,
} from '@shared/core/providers/agent-provider-registry';

/**
 * Whether any connected server offers a provider, kept current: for what
 * Console shows about this computer rather than about one server (its
 * settings pages). A provider no flag gates always is.
 */
export function useProviderOfferedAnywhere(): (id: AgentProviderId) => boolean {
  const additional = useAnyServerFeatureFlag('additional_agent_providers');
  return useCallback(
    (id: AgentProviderId) => {
      const flag = PROVIDER_FLAGS[id];
      if (flag === undefined) return true;
      if (flag === 'additional_agent_providers') return additional;
      throw new Error(`no hook reads the '${flag}' flag that gates the '${id}' provider`);
    },
    [additional]
  );
}
