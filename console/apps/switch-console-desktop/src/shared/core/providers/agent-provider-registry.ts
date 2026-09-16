export const AGENT_PROVIDER_IDS = ['codex', 'claude', 'antigravity', 'cursor', 'opencode'] as const;

export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];

/**
 * Narrow a provider id that arrived as an opaque string — from a database row
 * or a launch spec read off disk — to a registered one.
 *
 * Throws rather than passing it through: every consumer dispatches on this
 * value, so an unregistered id silently selects no behaviour at all.
 */
export function asAgentProviderId(value: string): AgentProviderId {
  if ((AGENT_PROVIDER_IDS as readonly string[]).includes(value)) return value as AgentProviderId;
  throw new Error(`unknown agent provider '${value}'`);
}

export type AgentProviderDefinition = {
  id: AgentProviderId;
  name: string;
  /** Short one-liner shown in the agent info card. */
  description?: string;
  docUrl?: string;
  installCommand?: string;
  commands?: string[];
  versionArgs?: string[];
  /** Skip running the CLI for dependency version detection. */
  skipVersionProbe?: boolean;
  detectable?: boolean;
  cli?: string;
  autoApproveFlag?: string;
  /** Auto-approval is provided by provider-specific environment variables instead of CLI args. */
  autoApproveViaEnv?: boolean;
  initialPromptFlag?: string;
  resumeFlag?: string;
  /**
   * CLI flag to assign a unique session ID per chat instance.
   * Used to isolate session state when multiple chats of the same provider
   * run in the same worktree. The flag receives a deterministic UUID
   * derived from the Switch Console session ID.
   * e.g. '--session-id' for Claude Code.
   */
  sessionIdFlag?: string;
  newSessionFlag?: string;
  sessionIdOnResumeOnly?: boolean;
  /** Resume flag used when sessionIdOnResumeOnly is set but no provider session id is stored yet. */
  resumeWithoutSessionFlag?: string;
  defaultArgs?: string[];
  planActivateCommand?: string;
  autoStartCommand?: string;
  icon?: string;
  iconDark?: string;
  /** Accessible alt text for the provider logo. */
  alt?: string;
  /** When true, the logo should be colour-inverted in dark mode. */
  invertInDark?: boolean;
  supportsHooks?: boolean;
};

/**
 * Provider ids and display metadata, plus a mirror of each provider's argv shape.
 *
 * The argv fields here are descriptive, not authoritative: nothing reads them at
 * spawn time. `packages/plugins/src/agents/impl/<id>/index.ts` builds the real
 * command, so change the plugin first and update the mirror to match.
 */
export const AGENT_PROVIDERS: AgentProviderDefinition[] = [
  {
    id: 'codex',
    name: 'Codex',
    description:
      'CLI that connects to OpenAI models for project-aware code assistance and terminal workflows.',
    docUrl: 'https://github.com/openai/codex',
    installCommand: 'npm install -g @openai/codex',
    commands: ['codex'],
    versionArgs: ['--version'],
    cli: 'codex',
    // Hook trust is a default arg, not an auto-approve one: Codex skips any hook
    // it has no persisted trust entry for, and Switch Console's status signals and
    // rollout-id capture are hooks. Kept in sync with the plugin by the parity
    // test in src/main/core/providers/provider-argv-parity.test.ts.
    defaultArgs: ['--dangerously-bypass-hook-trust'],
    autoApproveFlag: '-c approval_policy="never"',
    initialPromptFlag: '',
    resumeFlag: 'resume',
    sessionIdFlag: ' ',
    sessionIdOnResumeOnly: true,
    resumeWithoutSessionFlag: 'resume --last',
    icon: 'openai.svg',
    alt: 'Codex',
    supportsHooks: true,
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description:
      'CLI that uses Anthropic Claude for code edits, explanations, and structured refactors in the terminal.',
    docUrl: 'https://code.claude.com/docs/en/quickstart',
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
    commands: ['claude'],
    versionArgs: ['--version'],
    cli: 'claude',
    autoApproveFlag: '--dangerously-skip-permissions',
    initialPromptFlag: '',
    resumeFlag: '--resume',
    sessionIdFlag: '--session-id',
    planActivateCommand: '/plan',
    icon: 'claude.svg',
    alt: 'Claude Code',
    supportsHooks: true,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    description:
      "Cursor's agent CLI; provides editor-style, location-aware assistance from the shell.",
    docUrl: 'https://cursor.com/docs/cli/overview',
    installCommand: 'curl https://cursor.com/install -fsS | bash',
    commands: ['cursor-agent'],
    versionArgs: ['--version'],
    cli: 'cursor-agent',
    autoApproveFlag: '-f --approve-mcps',
    initialPromptFlag: '',
    resumeFlag: '--resume',
    icon: 'cursor.svg',
    alt: 'Cursor CLI',
    invertInDark: true,
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    description:
      'Google Antigravity ACP with native authentication, approvals and persistent conversations.',
    docUrl: 'https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp',
    commands: ['antigravity-acp'],
    versionArgs: ['--version'],
    cli: 'antigravity-acp',
    initialPromptFlag: '',
    planActivateCommand: '/plan',
    icon: 'antigravity.svg',
    alt: 'Antigravity ACP',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description:
      'OpenCode CLI that interfaces with models for code generation and edits from the shell.',
    docUrl: 'https://opencode.ai/docs/cli/',
    installCommand: 'npm install -g opencode-ai',
    commands: ['opencode'],
    versionArgs: ['--version'],
    cli: 'opencode',
    autoApproveViaEnv: true,
    initialPromptFlag: '--prompt',
    resumeFlag: '--session',
    sessionIdFlag: '--session',
    sessionIdOnResumeOnly: true,
    resumeWithoutSessionFlag: '--continue',
    icon: 'opencode.svg',
    iconDark: 'opencode-dark.svg',
    alt: 'OpenCode CLI',
    supportsHooks: true,
  },
];

const PROVIDER_MAP = new Map<string, AgentProviderDefinition>(
  AGENT_PROVIDERS.map((provider) => [provider.id, provider])
);

export function getProvider(id: AgentProviderId): AgentProviderDefinition | undefined {
  return PROVIDER_MAP.get(id);
}

export function getInstallCommandForProvider(id: AgentProviderId): string | null {
  return PROVIDER_MAP.get(id)?.installCommand ?? null;
}

/**
 * Validates if a string is a valid provider ID.
 * @param value - The value to validate
 * @returns true if the value is a valid provider ID, false otherwise
 */
export function isValidProviderId(value: unknown): value is AgentProviderId {
  return typeof value === 'string' && AGENT_PROVIDER_IDS.includes(value as AgentProviderId);
}

export function isValidProviderSessionId(providerId: string, providerSessionId: string): boolean {
  if (providerId === 'opencode') return providerSessionId.startsWith('ses');
  return true;
}

/**
 * What a provider is called in the interface — "Claude Code", not the `claude`
 * we key it by. An id this build does not know is returned as it stands: it
 * came from a real agent row, and showing it is more use than showing nothing.
 */
export function providerDisplayName(id: string | null | undefined): string | null {
  if (!id) return null;
  if (!isValidProviderId(id)) return id;
  return PROVIDER_MAP.get(id)?.name ?? id;
}

export function getDescriptionForProvider(id: AgentProviderId): string | null {
  return PROVIDER_MAP.get(id)?.description ?? null;
}

export function getDocUrlForProvider(id: AgentProviderId): string | null {
  return PROVIDER_MAP.get(id)?.docUrl ?? null;
}

export function listDetectableProviders(): AgentProviderDefinition[] {
  return AGENT_PROVIDERS.filter(
    (provider) => provider.detectable !== false && provider.commands?.length
  );
}
