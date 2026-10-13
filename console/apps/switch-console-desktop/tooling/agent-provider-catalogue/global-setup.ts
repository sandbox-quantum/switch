import { PROVIDER_RUNTIMES } from '@switch-console/agent-providers';
import { pluginRegistry } from '@switch-console/plugins/agents';
import type { TestProject } from 'vitest/node';
import { buildAgentProviderCatalogue } from '@main/core/providers/agent-provider-catalogue';
import type { AgentProviderDefinition } from '@shared/core/providers/agent-provider-registry';

declare module 'vitest' {
  export interface ProvidedContext {
    agentProviderCatalogue: AgentProviderDefinition[];
  }
}

/**
 * Builds the real provider catalogue once, in Node, and hands it to every test
 * file — browser ones included, which cannot load the plugin or runtime
 * registries themselves.
 */
export default function setup(project: TestProject): void {
  project.provide(
    'agentProviderCatalogue',
    buildAgentProviderCatalogue(pluginRegistry.getAll(), PROVIDER_RUNTIMES)
  );
}
