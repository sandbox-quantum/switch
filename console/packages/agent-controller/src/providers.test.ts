import { providerRuntimeIds } from '@switch-console/agent-providers';
import { pluginRegistry } from '@switch-console/plugins/agents';
import { expect, it } from 'vitest';
import { PROVIDERS, registeredProviders } from './providers';

it('runs every provider that has both a plugin and a runtime', () => {
  const sortIds = (ids: readonly string[]) => [...ids].sort((a, b) => a.localeCompare(b));
  expect(sortIds(PROVIDERS)).toEqual(sortIds(pluginRegistry.ids()));
  expect(sortIds(PROVIDERS)).toEqual(sortIds(providerRuntimeIds()));
});

it('refuses a provider registered on only one side, naming the missing half', () => {
  expect(() => registeredProviders(['claude', 'newcli'], ['claude'])).toThrow(
    'No runtime in agent-providers for: newcli.'
  );
  expect(() => registeredProviders(['claude'], ['claude', 'newcli'])).toThrow(
    'No plugin for: newcli.'
  );
});
