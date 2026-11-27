import { useCallback, useEffect, useState } from 'react';
import type { AddressingPolicy } from '../contracts/switch-servers';
import { isThirdPartyAvatarUrl, randomAgentAvatarUrl } from './agent-avatar';

/** What the app knows that the form goes by: Switch's name rules and a new agent's defaults. */
export type NewAgentFormDeps = {
  /** Switch's agent-name charset. */
  namePattern: RegExp;
  /** A rejected name folded into the charset, or empty when nothing of it survives. */
  slugify: (value: string) => string;
  /** The provider chosen for the agent, null before one is. */
  providerId: string | null;
  /** The permissions a new agent of the chosen provider starts with, and its auto mode. */
  permissions: NewAgentPermissions;
  /** The addressing policy a new agent starts on. */
  initialPolicy: () => AddressingPolicy | null;
  /** The server's answer on third-party avatars; null while there is none. */
  thirdPartyAvatarsEnabled: boolean | null;
};

/** What a new agent of a provider starts with, and what its auto mode is. */
export type NewAgentPermissions = {
  autoApprove: boolean;
  autoMode: boolean;
  /** The provider has an auto mode to offer (Cursor has none). */
  supportsAutoMode: boolean;
  /** The provider's name where nothing reviews an action in its auto mode (OpenCode), else null. */
  unreviewedAutoMode: string | null;
};

/** Before a provider is chosen the permission switches read off; they are not on screen then. */
export const NO_PROVIDER_PERMISSIONS: NewAgentPermissions = {
  autoApprove: false,
  autoMode: false,
  supportsAutoMode: false,
  unreviewedAutoMode: null,
};

/** A permission switch the user set, and the provider it was set for. */
type ProviderChoice = { providerId: string | null; value: boolean };

function chosenFor(choice: ProviderChoice | null, providerId: string | null) {
  return choice !== null && choice.providerId === providerId ? choice.value : null;
}

/**
 * The display name a name suggests, for a display name the form filled in
 * rather than the user: an identifier written out ("mo-second-helper" reads
 * "Mo Second Helper"), or text the identifier cannot hold yet, as typed.
 */
export function displayNameFromName(value: string, namePattern: RegExp): string {
  const trimmed = value.trim();
  if (!namePattern.test(trimmed)) return trimmed;
  return trimmed
    .split(/[._-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Form state for creating a brand-new Switch agent. Collects the Switch agent
 * name and description (advanced definition attributes are gathered separately
 * in the Advanced section).
 *
 * Neither field is derived from the working directory. The name is how the
 * agent is addressed in rooms and the description is what other people read to
 * know what it is for; a directory basename answers neither question, and
 * rewriting both when the directory changed moved text the user had already
 * looked at and accepted.
 *
 * One instance serves every run location, so switching between them keeps the
 * name and description the user had typed.
 */
export function useNewAgentForm({
  namePattern,
  slugify,
  providerId,
  permissions,
  initialPolicy,
  thirdPartyAvatarsEnabled,
}: NewAgentFormDeps) {
  const [agentName, setAgentNameFolded] = useState('');
  // What was typed, before the identifier folded it to lowercase. The slug
  // offer hands this back as the display name, so the capitals in a typed
  // "Switch Dev" outlive an identifier that cannot hold them.
  const [typedName, setTypedName] = useState('');
  // The label chat platforms render the agent under. Optional: an agent with
  // none is shown under its identifier.
  const [displayName, setDisplayNameRaw] = useState('');
  const [displayNameTouched, setDisplayNameTouched] = useState(false);
  // The display name is one the slug offer filled in, not one the user wrote:
  // it follows the name from then on, so renaming the agent before creating it
  // does not leave it labelled as the name it no longer has.
  const [displayNameSuggested, setDisplayNameSuggested] = useState(false);
  const [description, setDescription] = useState('');
  // What the agent is for, in its own words. Optional: an agent with none runs
  // on its provider's defaults, and the description stands in where a provider
  // needs a prompt.
  const [instructions, setInstructions] = useState('');
  // The permission switches start on the chosen provider's defaults, and a
  // choice is kept only for the provider it was made for: switching from Claude
  // Code with auto mode on to OpenCode must not carry over an auto mode that
  // nothing reviews there.
  const [autoApproveChoice, setAutoApproveChoice] = useState<ProviderChoice | null>(null);
  const [autoModeChoice, setAutoModeChoice] = useState<ProviderChoice | null>(null);
  const autoApprove = chosenFor(autoApproveChoice, providerId) ?? permissions.autoApprove;
  const autoMode = chosenFor(autoModeChoice, providerId) ?? permissions.autoMode;
  const setAutoApprove = useCallback(
    (value: boolean) => setAutoApproveChoice({ providerId, value }),
    [providerId]
  );
  const setAutoMode = useCallback(
    (value: boolean) => setAutoModeChoice({ providerId, value }),
    [providerId]
  );
  // null = open; a new agent starts on the app's default. Applied after creation.
  const [addressingPolicy, setAddressingPolicy] = useState<AddressingPolicy | null>(initialPolicy);
  // A new agent opens on a random bot rather than one drawn from its name: the
  // name is empty at that point, so a name-derived seed is the same constant for
  // everybody, and two agents that end up sharing a name have no reason to share
  // a face. Null still means "whatever the name generates".
  const [initialIconUrl] = useState(randomAgentAvatarUrl);
  const [iconUrl, setIconUrl] = useState<string | null>(initialIconUrl);

  // The random bot above is drawn before anything is known about where the
  // agent will land, so a server that turns out to disable third-party avatars
  // has to lose it retroactively. Nothing changes while the server is still
  // unknown or allows them: this only fires once the answer is a confirmed no.
  useEffect(() => {
    if (thirdPartyAvatarsEnabled === false && iconUrl !== null && isThirdPartyAvatarUrl(iconUrl)) {
      setIconUrl(null);
    }
  }, [thirdPartyAvatarsEnabled, iconUrl]);

  const setDisplayName = useCallback((value: string) => {
    setDisplayNameRaw(value);
    setDisplayNameTouched(true);
    setDisplayNameSuggested(false);
  }, []);

  /**
   * Uppercase is the one thing the charset rejects that the reader never means,
   * so it is folded as they type rather than held against them. Everything else
   * the charset refuses is left alone for the rejection banner and its slug
   * offer to answer, because rewriting text under the cursor is worse than an
   * error.
   */
  const setAgentName = useCallback(
    (value: string) => {
      setTypedName(value);
      setAgentNameFolded(value.replace(/[A-Z]/g, (c) => c.toLowerCase()));
      if (displayNameSuggested) setDisplayNameRaw(displayNameFromName(value, namePattern));
    },
    [displayNameSuggested, namePattern]
  );

  const nameIsValid = namePattern.test(agentName);
  const nameIsRejected = agentName.length > 0 && !nameIsValid;
  // A rejected name the app can repair itself is an offer, not a dead end.
  // Empty when nothing of the name survives slugging.
  const suggestedName = nameIsRejected ? slugify(agentName) : '';
  const isValid = nameIsValid && description.trim().length > 0;

  /**
   * Take the offered slug as the name, keeping the text it was slugged from as
   * the display name. A display name the user wrote themselves stands; one
   * filled in here follows later changes of the name.
   */
  const acceptSuggestedName = useCallback(() => {
    if (suggestedName === '') return;
    if (!displayNameTouched) {
      setDisplayNameRaw(typedName);
      setDisplayNameSuggested(true);
    }
    setTypedName(suggestedName);
    setAgentNameFolded(suggestedName);
  }, [typedName, displayNameTouched, suggestedName]);

  return {
    agentName,
    setAgentName,
    nameIsValid,
    nameIsRejected,
    suggestedName,
    acceptSuggestedName,
    displayName,
    setDisplayName,
    description,
    setDescription,
    instructions,
    setInstructions,
    /** The provider the permission switches are for, null before one is chosen. */
    providerId,
    supportsAutoMode: permissions.supportsAutoMode,
    unreviewedAutoMode: permissions.unreviewedAutoMode,
    autoApprove,
    setAutoApprove,
    autoMode,
    setAutoMode,
    addressingPolicy,
    setAddressingPolicy,
    iconUrl,
    setIconUrl,
    /** Whether the icon on screen is still one this app drew, as opposed to one
     * the user went and chose. Only the caption cares; the value sent to the
     * server is `iconUrl` either way. */
    iconIsGenerated: iconUrl === null || iconUrl === initialIconUrl,
    thirdPartyAvatarsEnabled,
    isValid,
  };
}

export type NewAgentFormState = ReturnType<typeof useNewAgentForm>;
