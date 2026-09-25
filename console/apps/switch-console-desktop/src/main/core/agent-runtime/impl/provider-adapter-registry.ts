import {
  createClaudeAdapter,
  createCodexAdapter,
  createAntigravityAdapter,
  createCursorAdapter,
  createOpencodeAdapter,
  type ProviderAdapter,
} from '@switch-console/agent-providers';
import { log } from '@main/lib/logger';
import { supportsProviderRuntime } from '@shared/core/agents/agent-provider-config';

/**
 * One adapter per provider, shared by every session of that provider.
 *
 * That is the shape the adapters are written for — `ProviderAdapter` is keyed
 * by Switch's session id throughout — and it is what keeps one subscription per
 * provider rather than one per session. Adapters are constructed only when used.
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
      return createOpencodeAdapter({ logger });
    }
    if (providerId === 'claude') {
      // No executable is configured, so the adapter takes the `claude` on the
      // session's own PATH — the CLI the user logged in with. It falls back to
      // the one the SDK bundles, and says so on the transcript when it does.
      return createClaudeAdapter({ logger });
    }
    if (providerId === 'cursor') return createCursorAdapter({ logger });
    if (providerId === 'antigravity') return createAntigravityAdapter({ logger });
    if (providerId === 'codex') return createCodexAdapter({ logger });
    throw new Error(
      `No provider adapter for '${providerId}'. Supported providers are OpenCode, Claude Code, Codex, Cursor CLI and Antigravity CLI.`
    );
  }
}

export const providerAdapterRegistry = new ProviderAdapterRegistry();
