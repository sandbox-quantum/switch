import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type {
  AddressingPolicy,
  AgentProviderKind,
} from '@shared/core/switch-servers/switch-servers';
import { basenameFromAnyPath } from '@shared/path-name';

/** Switch agent-name charset, enforced server-side too: lowercase letters,
 * digits, `.`, `-`, `_`, starting with a letter or digit. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function usePickMode() {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [serverId, setServerId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<AgentProviderId | null>(null);
  const [nameIsTouched, setNameIsTouched] = useState<boolean>(false);

  const handlePathChange = (newPath: string) => {
    setPath(newPath);
    if (!nameIsTouched) {
      const dirName = basenameFromAnyPath(newPath);
      if (dirName && !nameIsTouched) setName(dirName);
    }
  };

  const handleNameChange = (newName: string) => {
    setName(newName);
    setNameIsTouched(true);
  };

  const isValid = name.trim().length > 0 && path.trim().length > 0 && !!serverId && !!providerId;

  return {
    path,
    name,
    serverId,
    setServerId,
    providerId,
    setProviderId,
    handlePathChange,
    handleNameChange,
    isValid,
  };
}

export type PickModeState = ReturnType<typeof usePickMode>;

/**
 * Form state for onboarding a brand-new Switch agent (a directory with no
 * `.claude/settings.local.json` yet). Collects the fields the `configure` skill
 * asks for — Switch agent name, description, provider kind (channels), and an
 * optional notify handle — seeding name/description from a server-derived
 * default until the user edits them.
 */
export function useConfigureAgentForm(dir: string, defaultAutoApprove: boolean) {
  const [agentName, setAgentNameRaw] = useState('');
  const [agentNameTouched, setAgentNameTouched] = useState(false);
  const [description, setDescriptionRaw] = useState('');
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  const [providerKind, setProviderKind] = useState<AgentProviderKind | null>(null);
  const [notifyUser, setNotifyUser] = useState('');
  const [autoSession, setAutoSession] = useState(true);
  const [autoApprove, setAutoApprove] = useState(defaultAutoApprove);
  // Scoped addressing policy (CHOO-1585). null = open (default); set to restrict
  // who can address the new agent. Applied via a follow-up PUT after creation.
  const [addressingPolicy, setAddressingPolicy] = useState<AddressingPolicy | null>(null);

  const trimmedDir = dir.trim();
  // suggestAgentDefaults derives name/description from the directory basename and
  // the local user — pure, no filesystem read — so it works identically for a
  // local path or a remote working dir, giving remote agents the same defaults.
  const defaultsQuery = useQuery({
    queryKey: ['agentDefaults', trimmedDir],
    queryFn: () => rpc.switchServers.suggestAgentDefaults({ dir: trimmedDir }),
    enabled: trimmedDir.length > 0,
  });

  const defaults = defaultsQuery.data;
  useEffect(() => {
    if (!defaults) return;
    if (!agentNameTouched) setAgentNameRaw(defaults.name);
    if (!descriptionTouched) setDescriptionRaw(defaults.description);
  }, [defaults, agentNameTouched, descriptionTouched]);

  const setAgentName = (value: string) => {
    setAgentNameRaw(value);
    setAgentNameTouched(true);
  };
  const setDescription = (value: string) => {
    setDescriptionRaw(value);
    setDescriptionTouched(true);
  };

  const nameIsValid = AGENT_NAME_PATTERN.test(agentName);
  const isValid = nameIsValid && description.trim().length > 0 && providerKind !== null;

  return {
    agentName,
    setAgentName,
    nameIsValid,
    description,
    setDescription,
    providerKind,
    setProviderKind,
    notifyUser,
    setNotifyUser,
    autoSession,
    setAutoSession,
    autoApprove,
    setAutoApprove,
    addressingPolicy,
    setAddressingPolicy,
    isValid,
  };
}

export type ConfigureAgentFormState = ReturnType<typeof useConfigureAgentForm>;
