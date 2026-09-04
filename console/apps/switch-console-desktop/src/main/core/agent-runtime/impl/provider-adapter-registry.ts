import {
  createOpencodeAdapter,
  type ProviderAdapter,
  type OpencodeSkill,
} from '@switch-console/agent-providers';
import { OPENCODE_SKILL_CONTENT } from '@switch-console/plugins/agents/opencode/skill';
import { log } from '@main/lib/logger';

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
    return providerId === 'opencode';
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.stopAll()));
    this.adapters.clear();
  }

  private create(providerId: string): ProviderAdapter {
    if (providerId !== 'opencode') {
      throw new Error(
        `No provider adapter for '${providerId}'. Only OpenCode can run a provider-backed session today.`
      );
    }
    return createOpencodeAdapter({
      skills: [SWITCH_SKILL],
      logger: {
        debug: (message, meta) => log.debug(message, meta),
        warn: (message, meta) => log.warn(message, meta),
        error: (message, meta) => log.error(message, meta),
      },
    });
  }
}

export const providerAdapterRegistry = new ProviderAdapterRegistry();
