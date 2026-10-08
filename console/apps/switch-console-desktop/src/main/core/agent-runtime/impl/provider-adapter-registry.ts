import { type ProviderAdapter, providerRuntime } from '@switch-console/agent-providers';
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
    if (!this.supports(providerId))
      throw new Error(`No provider adapter for '${providerId}': this build has no such provider.`);
    // No executable is configured, so each adapter takes the CLI on the
    // session's own PATH — the one the user signed in with.
    return providerRuntime(providerId).createAdapter({ binaryPath: undefined, logger, skill: '' });
  }
}

export const providerAdapterRegistry = new ProviderAdapterRegistry();
