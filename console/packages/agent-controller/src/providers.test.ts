import { providerRuntimeIds } from '@switch-console/agent-providers';
import { pluginRegistry } from '@switch-console/plugins/agents';
import { expect, it } from 'vitest';
import { PROVIDERS, registeredProviders } from './providers';

it('runs every provider that has both a plugin and a runtime', () => {
  expect([...PROVIDERS].sort()).toEqual([...pluginRegistry.ids()].sort());
  expect([...PROVIDERS].sort()).toEqual([...providerRuntimeIds()].sort());
});

it('refuses a provider registered on only one side, naming the missing half', () => {
  expect(() => registeredProviders(['claude', 'newcli'], ['claude'])).toThrow(
    'No runtime in agent-providers for: newcli.'
  );
  expect(() => registeredProviders(['claude'], ['claude', 'newcli'])).toThrow(
    'No plugin for: newcli.'
  );
});
