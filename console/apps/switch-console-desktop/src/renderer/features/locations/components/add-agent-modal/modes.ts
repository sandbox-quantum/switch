import {
  NO_PROVIDER_PERMISSIONS,
  useNewAgentForm,
} from '@switch-console/chat-ui/model/new-agent-form';
import { useState } from 'react';
import { useThirdPartyAvatarsEnabled } from '@renderer/lib/stores/use-avatar-settings';
import { AGENT_NAME_PATTERN, slugifyAgentNamePart } from '@shared/core/agents/agent-slug';
import { newAgentPermissions } from '@shared/core/agents/agents';
import {
  type AgentProviderId,
  autoModeIsUnreviewed,
  providerDisplayName,
  providerSupportsAutoMode,
} from '@shared/core/providers/agent-provider-registry';
import { defaultAgentPolicy } from '@shared/core/switch-servers/owner-policy';

export function usePickMode() {
  const [path, setPath] = useState('');
  const [serverId, setServerId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<AgentProviderId | null>(null);

  return {
    path,
    handlePathChange: setPath,
    serverId,
    setServerId,
    providerId,
    setProviderId,
  };
}

export type PickModeState = ReturnType<typeof usePickMode>;

/**
 * The new-agent form state, with Switch's name rules, the chosen provider's
 * permission defaults and the server's avatar setting as Console knows them.
 * Switch Console always registers the agent as a managed, session-addressable
 * identity — there is no run-mode or notify-handle choice (CHOO-1440).
 */
export function useConfigureAgentForm(serverId: string | null, providerId: AgentProviderId | null) {
  return useNewAgentForm({
    namePattern: AGENT_NAME_PATTERN,
    slugify: slugifyAgentNamePart,
    providerId,
    permissions:
      providerId === null
        ? NO_PROVIDER_PERMISSIONS
        : {
            ...newAgentPermissions(providerId),
            supportsAutoMode: providerSupportsAutoMode(providerId),
            unreviewedAutoMode: autoModeIsUnreviewed(providerId)
              ? providerDisplayName(providerId)
              : null,
          },
    initialPolicy: defaultAgentPolicy,
    thirdPartyAvatarsEnabled: useThirdPartyAvatarsEnabled(serverId),
  });
}

export type ConfigureAgentFormState = ReturnType<typeof useConfigureAgentForm>;
