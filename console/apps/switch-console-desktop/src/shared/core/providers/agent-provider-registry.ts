/**
 * A provider id: the id of a plugin in `packages/plugins/src/agents/impl/<id>/`.
 * Open rather than a union so that adding a provider changes no desktop code;
 * a value from storage is checked against the catalogue with
 * {@link isValidProviderId} or {@link asAgentProviderId}.
 */
export type AgentProviderId = string;

/**
 * What the desktop app shows and needs for one provider, built in the main
 * process from the provider's plugin metadata and its runtime entry in
 * `@switch-console/agent-providers`.
 */
export type AgentProviderDefinition = {
  id: AgentProviderId;
  name: string;
  /** Short one-liner shown in the agent info card. */
  description: string;
  docUrl: string;
  /** What to tell someone to install, where the product name alone would be ambiguous. */
  cliLabel: string;
  /** The command a person runs on the execution machine to sign the CLI in. */
  loginCommand: string;
  /** The Switch gateway's known-agent type, sent when an agent registers. */
  knownAgentType: string;
};

type Catalogue = {
  providers: readonly AgentProviderDefinition[];
  byId: ReadonlyMap<string, AgentProviderDefinition>;
};

let catalogue: Catalogue | null = null;

/**
 * Install the provider catalogue. The main process builds it from the plugin
 * and runtime registries before anything else loads; the renderer fetches it
 * over RPC before its first render.
 */
export function setAgentProviderCatalogue(providers: readonly AgentProviderDefinition[]): void {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  if (byId.size !== providers.length)
    throw new Error(
      `The agent provider catalogue names a provider twice: ${providers.map((p) => p.id).join(', ')}`
    );
  catalogue = { providers, byId };
}

function loaded(): Catalogue {
  if (!catalogue)
    throw new Error(
      'The agent provider catalogue was read before it was loaded. The main process sets it when its plugin registry loads, and the renderer before its first render.'
    );
  return catalogue;
}

/** Every provider, in the order the interface lists them. */
export function agentProviders(): readonly AgentProviderDefinition[] {
  return loaded().providers;
}

export function agentProviderIds(): AgentProviderId[] {
  return loaded().providers.map((provider) => provider.id);
}

/** Every provider's name as a sentence fragment: "Codex, Claude Code and OpenCode". */
export function providerNamesSentence(): string {
  const names = loaded().providers.map((provider) => provider.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
}

export function getProvider(id: string): AgentProviderDefinition | undefined {
  return loaded().byId.get(id);
}

/** A registered provider's definition; throws for an id the catalogue does not have. */
export function requireProvider(id: string): AgentProviderDefinition {
  const provider = getProvider(id);
  if (!provider) throw new Error(`unknown agent provider '${id}'`);
  return provider;
}

export function isValidProviderId(value: unknown): value is AgentProviderId {
  return typeof value === 'string' && loaded().byId.has(value);
}

/**
 * Narrow a provider id that arrived as an opaque string — from a database row
 * or a launch spec read off disk — to a registered one.
 *
 * Throws rather than passing it through: every consumer dispatches on this
 * value, so an unregistered id silently selects no behaviour at all.
 */
export function asAgentProviderId(value: string): AgentProviderId {
  if (isValidProviderId(value)) return value;
  throw new Error(`unknown agent provider '${value}'`);
}

/**
 * What a provider is called in the interface — "Claude Code", not the `claude`
 * we key it by. An id this build does not know is returned as it stands: it
 * came from a real agent row, and showing it is more use than showing nothing.
 */
export function providerDisplayName(id: string | null | undefined): string | null {
  if (!id) return null;
  return getProvider(id)?.name ?? id;
}

export function getDescriptionForProvider(id: AgentProviderId): string | null {
  return getProvider(id)?.description ?? null;
}

export function getDocUrlForProvider(id: AgentProviderId): string | null {
  return getProvider(id)?.docUrl ?? null;
}
