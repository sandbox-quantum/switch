import { useCallback, useState } from 'react';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { ownerOnlyPolicy } from '@shared/core/switch-servers/owner-policy';
import type { AddressingPolicy } from '@shared/core/switch-servers/switch-servers';

/** Switch agent-name charset, enforced server-side too: lowercase letters,
 * digits, `.`, `-`, `_`, starting with a letter or digit. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

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
 * Form state for creating a brand-new Switch agent in a directory. Collects the
 * Switch agent name and description (advanced definition attributes are gathered
 * separately in the Advanced section). Switch Console always registers the agent
 * as a managed, session-addressable identity — there is no run-mode or
 * notify-handle choice (CHOO-1440).
 *
 * Neither field is derived from the working directory. The name is how the
 * agent is addressed in rooms and the description is what other people read to
 * know what it is for; a directory basename answers neither question, and
 * rewriting both when the directory changed moved text the user had already
 * looked at and accepted.
 *
 * One instance serves both run locations. There used to be two — one for a
 * local agent, one for a remote one — and switching between them swapped which
 * was on screen, so the name and description the user had typed vanished.
 */
export function useConfigureAgentForm() {
  const [agentName, setAgentName] = useState('');
  const [description, setDescription] = useState('');
  const [autoSession, setAutoSession] = useState(true);
  const [autoApprove, setAutoApproveRaw] = useState(false);
  const [autoApproveTouched, setAutoApproveTouched] = useState(false);
  // Scoped addressing policy (CHOO-1585). null = open; a new agent starts
  // owner-scoped (CHOO-2137). Applied via a follow-up PUT after creation.
  const [addressingPolicy, setAddressingPolicy] = useState<AddressingPolicy | null>(() =>
    ownerOnlyPolicy()
  );
  // The agent's icon (CHOO-2171). Null means "whatever the name generates",
  // which is also what the ✕ in the picker returns to — held as null rather
  // than as the resolved URL so the avatar keeps following the name while the
  // user is still typing it.
  const [iconUrl, setIconUrl] = useState<string | null>(null);

  const setAutoApprove = useCallback((value: boolean) => {
    setAutoApproveRaw(value);
    setAutoApproveTouched(true);
  }, []);

  /**
   * What the run location implies, for as long as the user has not answered
   * themselves: an agent on a host is put there to run unattended, and a
   * permission prompt nobody is watching stalls the session. Kept as a
   * suggestion rather than a reset so a deliberate answer survives a change of
   * mind about where the agent runs.
   */
  const suggestAutoApprove = useCallback(
    (value: boolean) => {
      setAutoApproveRaw((current) => (autoApproveTouched ? current : value));
    },
    [autoApproveTouched]
  );

  const nameIsValid = AGENT_NAME_PATTERN.test(agentName);
  const isValid = nameIsValid && description.trim().length > 0;

  return {
    agentName,
    setAgentName,
    nameIsValid,
    description,
    setDescription,
    autoSession,
    setAutoSession,
    autoApprove,
    setAutoApprove,
    suggestAutoApprove,
    addressingPolicy,
    setAddressingPolicy,
    iconUrl,
    setIconUrl,
    isValid,
  };
}

export type ConfigureAgentFormState = ReturnType<typeof useConfigureAgentForm>;
