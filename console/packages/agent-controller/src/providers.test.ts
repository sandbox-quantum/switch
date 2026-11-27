import { providerRuntimeIds } from '@switch-console/agent-providers';
import { pluginRegistry } from '@switch-console/plugins/agents';
import { expect, it } from 'vitest';
import { BOX_PROVIDERS, PROVIDERS, providersFor, registeredProviders } from './providers';

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

it('offers every registered provider outside box mode', () => {
  expect(providersFor(false)).toEqual(PROVIDERS);
});

it('offers only the box providers in box mode, every one of them registered', () => {
  const offered = providersFor(true);
  expect([...offered].sort()).toEqual([...BOX_PROVIDERS].sort());
  expect(PROVIDERS.filter((id) => !offered.includes(id)).length).toBeGreaterThan(0);
});

it('refuses a box provider this build has no registration for', () => {
  expect(() => providersFor(true, ['claude'], ['claude', 'gone'])).toThrow(
    'Box providers with no registration: gone.'
  );
});
