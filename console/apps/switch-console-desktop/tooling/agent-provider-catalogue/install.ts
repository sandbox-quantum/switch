import { inject } from 'vitest';
import { setAgentProviderCatalogue } from '@shared/core/providers/agent-provider-registry';

/**
 * Installs the provider catalogue before a test file loads, as the main process
 * and the renderer each do before anything reads it.
 */
setAgentProviderCatalogue(inject('agentProviderCatalogue'));
