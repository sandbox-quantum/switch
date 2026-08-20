import { useCallback, useState } from 'react';
import { randomAgentAvatarUrl } from '@shared/core/agents/agent-avatar';
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
  // What the agent is for, in its own words (CHOO-2228). Optional: an agent
  // with none runs on its provider's defaults, and the description stands in
  // where a provider needs a prompt.
  const [instructions, setInstructions] = useState('');
  const [autoSession, setAutoSession] = useState(true);
  const [autoApprove, setAutoApproveRaw] = useState(false);
  const [autoApproveTouched, setAutoApproveTouched] = useState(false);
  // Scoped addressing policy (CHOO-1585). null = open; a new agent starts
  // owner-scoped (CHOO-2137). Applied via a follow-up PUT after creation.
  const [addressingPolicy, setAddressingPolicy] = useState<AddressingPolicy | null>(() =>
    ownerOnlyPolicy()
  );
  // The agent's icon (CHOO-2171). A new agent opens on a random bot rather than
  // one drawn from its name: the name is empty at that point, so a name-derived
  // seed is the same constant for everybody, and two agents that end up sharing
  // a name have no reason to share a face. Null still means "whatever the name
  // generates" — that is what the ✕ in the picker returns to.
  const [initialIconUrl] = useState(randomAgentAvatarUrl);
  const [iconUrl, setIconUrl] = useState<string | null>(initialIconUrl);

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
    instructions,
    setInstructions,
    autoSession,
    setAutoSession,
    autoApprove,
    setAutoApprove,
    suggestAutoApprove,
    addressingPolicy,
    setAddressingPolicy,
    iconUrl,
    setIconUrl,
    /** Whether the icon on screen is still one this app drew, as opposed to one
     * the user went and chose. Only the caption cares; the value sent to the
     * server is `iconUrl` either way. */
    iconIsGenerated: iconUrl === null || iconUrl === initialIconUrl,
    isValid,
  };
}

export type ConfigureAgentFormState = ReturnType<typeof useConfigureAgentForm>;
