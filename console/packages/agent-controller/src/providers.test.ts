import { providerRuntimeIds } from '@switch-console/agent-providers';
import { pluginRegistry } from '@switch-console/plugins/agents';
import { expect, it } from 'vitest';
import { PROVIDERS, registeredProviders } from './providers';

it('runs every provider that has both a plugin and a runtime', () => {
  expect([...PROVIDERS].sort((a, b) => a.localeCompare(b))).toEqual(
    [...pluginRegistry.ids()].sort((a, b) => a.localeCompare(b))
  );
  expect([...PROVIDERS].sort((a, b) => a.localeCompare(b))).toEqual(
    [...providerRuntimeIds()].sort((a, b) => a.localeCompare(b))
  );
});

it('refuses a provider registered on only one side, naming the missing half', () => {
  expect(() => registeredProviders(['claude', 'newcli'], ['claude'])).toThrow(
    'No runtime in agent-providers for: newcli.'
  );
  expect(() => registeredProviders(['claude'], ['claude', 'newcli'])).toThrow(
    'No plugin for: newcli.'
  );
});
