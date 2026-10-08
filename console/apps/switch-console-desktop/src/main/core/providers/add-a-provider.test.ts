import { acpProviderRuntime, cursorAcp, PROVIDER_RUNTIMES } from '@switch-console/agent-providers';
import { pluginRegistry } from '@switch-console/plugins/agents';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { machineProviderOptions } from '@renderer/features/locations/components/add-agent-modal/machine-provider-picker';
import { buildAgentGroups } from '@renderer/lib/components/agent-selector/agent-selector-options';
import {
  agentProviderIds,
  isValidProviderId,
  requireProvider,
  setAgentProviderCatalogue,
} from '@shared/core/providers/agent-provider-registry';
import { listRemoteAgentTypeAvailability } from '../agent-types/availability';
import { knownAgentTypeForProvider } from '../agents/known-agent-type';
import { buildAgentProviderCatalogue } from './agent-provider-catalogue';

const mocks = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('@main/core/dependencies/remote-dependency-manager', () => ({
  getRemoteDependencyManager: async () => ({ probe: mocks.probe }),
}));
vi.mock('@main/lib/logger', () => ({ log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));

/**
 * Registering a provider is a plugin plus a runtime. This registers a made-up
 * ACP CLI both ways — the plugin into the real registry, the runtime made from
 * its hooks — and checks that the desktop lists it, labels it and knows how to
 * sign it in, with no desktop code naming it.
 */
beforeAll(() => {
  const cursor = pluginRegistry.get('cursor')!;
  pluginRegistry.register({
    ...cursor,
    metadata: {
      id: 'dummy',
      name: 'Dummy',
      description: 'A made-up agent CLI.',
      websiteUrl: 'https://dummy.example.com',
      cliLabel: 'Dummy CLI',
    },
    capabilities: {
      ...cursor.capabilities,
      hostDependency: { ...cursor.capabilities.hostDependency, binaryNames: ['dummy-agent'] },
    },
  });
  const dummyRuntime = acpProviderRuntime({
    ...cursorAcp,
    provider: 'dummy',
    label: 'Dummy',
    defaultBinary: 'dummy-agent',
    loginCommand: 'dummy-agent login',
  });
  setAgentProviderCatalogue(
    buildAgentProviderCatalogue(pluginRegistry.getAll(), [...PROVIDER_RUNTIMES, dummyRuntime])
  );
});

describe('a provider added as a plugin and a runtime', () => {
  it('is in the catalogue, with its runtime login command and defaults from its plugin', () => {
    expect(agentProviderIds().at(-1)).toBe('dummy');
    expect(isValidProviderId('dummy')).toBe(true);
    expect(requireProvider('dummy')).toEqual({
      id: 'dummy',
      name: 'Dummy',
      description: 'A made-up agent CLI.',
      docUrl: 'https://dummy.example.com',
      cliLabel: 'Dummy CLI',
      loginCommand: 'dummy-agent login',
      knownAgentType: 'dummy',
    });
    expect(knownAgentTypeForProvider('dummy')).toBe('dummy');
  });

  it('is an agent type the create-agent form offers, and says what to install by its CLI label', async () => {
    mocks.probe.mockResolvedValue({ status: 'missing' });

    const types = await listRemoteAgentTypeAvailability('example-host');

    expect(types).toContainEqual({
      agentId: 'dummy',
      available: false,
      blockedReason: 'Install Dummy CLI on example-host.',
      blockedKind: 'not-installed',
    });
  });

  it('is listed by the agent selector', () => {
    const items = buildAgentGroups(['dummy']).flatMap((group) => group.items);

    expect(items).toContainEqual({
      value: 'dummy',
      label: 'Dummy',
      agentId: 'dummy',
      disabled: false,
    });
  });

  it('is listed among the providers a managed machine reports', () => {
    const options = machineProviderOptions({
      id: 'machine-1',
      name: 'Build box',
      kind: 'linux',
      state: 'online',
      providers: [{ provider: 'dummy', ready: true, problem: null }],
      workspacesDir: null,
      local: null,
    });

    expect(options).toContainEqual({ id: 'dummy', name: 'Dummy', ready: true, problem: null });
  });
});
