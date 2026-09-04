import {
  createClaudeAdapter,
  createOpencodeAdapter,
  type ProviderAdapter,
  type OpencodeSkill,
} from '@switch-console/agent-providers';
import { OPENCODE_SKILL_CONTENT } from '@switch-console/plugins/agents/opencode/skill';
import { log } from '@main/lib/logger';
import { supportsProviderRuntime } from '@shared/core/agents/agent-provider-config';

/**
 * The Switch room-workflow skill, as the isolated session needs it.
 *
 * The adapter points OpenCode at a config home Switch Console writes, which is
 * what keeps the user's own MCP registrations out of the session — and takes
 * their `skills/` directory with it, including the `switch` skill the connector
 * installed. Supplying the same content back is what makes the tools the
 * session is given usable: forty room tools and no instructions for them is
 * the failure this avoids.
 *
 * The name must be the skill's own: OpenCode discovers `skills/<name>/SKILL.md`
 * and rejects one whose folder disagrees with its frontmatter.
 *
 * Claude Code needs no counterpart: its session loads the user's own settings
 * and installed plugins, so the connector plugin's copy of the same skill is
 * already there (see `ClaudeAdapter.startSession`).
 */
const SWITCH_SKILL: OpencodeSkill = { name: 'switch', content: OPENCODE_SKILL_CONTENT };

/**
 * One adapter per provider, shared by every session of that provider.
 *
 * That is the shape the adapters are written for — `ProviderAdapter` is keyed
 * by Switch's session id throughout — and it is what keeps one subscription per
 * provider rather than one per session. Created lazily so an install that never
 * opts a session in never constructs one.
 */
class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  get(providerId: string): ProviderAdapter {
    const existing = this.adapters.get(providerId);
    if (existing) return existing;
    const adapter = this.create(providerId);
    this.adapters.set(providerId, adapter);
    return adapter;
  }

  /** Whether a provider can be driven through an adapter at all. */
  supports(providerId: string): boolean {
    return supportsProviderRuntime(providerId);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.stopAll()));
    this.adapters.clear();
  }

  private create(providerId: string): ProviderAdapter {
    const logger = {
      debug: (message: string, meta?: Record<string, unknown>) => log.debug(message, meta),
      warn: (message: string, meta?: Record<string, unknown>) => log.warn(message, meta),
      error: (message: string, meta?: Record<string, unknown>) => log.error(message, meta),
    };
    if (providerId === 'opencode') {
      return createOpencodeAdapter({ skills: [SWITCH_SKILL], logger });
    }
    if (providerId === 'claude') {
      // No executable is configured, so the adapter takes the `claude` on the
      // session's own PATH — the CLI the user logged in with. It falls back to
      // the one the SDK bundles, and says so on the transcript when it does.
      return createClaudeAdapter({ logger });
    }
    throw new Error(
      `No provider adapter for '${providerId}'. Only OpenCode and Claude Code can run a provider-backed session today.`
    );
  }
}

export const providerAdapterRegistry = new ProviderAdapterRegistry();
