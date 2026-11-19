import { providerRuntimeIds } from '@switch-console/agent-providers-box';
import { pluginRegistry } from '@switch-console/plugins/agents';
import { expect, it } from 'vitest';
import { LEFT_OUT_PROVIDERS, PROVIDERS, registeredProviders } from './providers';

const byName = (a: string, b: string) => a.localeCompare(b);

it('runs every provider that has both a plugin and a runtime, and none it leaves out', () => {
  expect([...PROVIDERS].sort(byName)).toEqual([...providerRuntimeIds()].sort(byName));
  expect([...PROVIDERS, ...LEFT_OUT_PROVIDERS].sort(byName)).toEqual(
    [...pluginRegistry.ids()].sort(byName)
  );
});

it('drops the plugin of a provider it lists as left out', () => {
  expect(registeredProviders(['claude', 'newcli'], ['claude'], ['newcli'])).toEqual(['claude']);
});

it('refuses a provider registered on only one side, naming the missing half', () => {
  expect(() => registeredProviders(['claude', 'newcli'], ['claude'], [])).toThrow(
    'No runtime in agent-providers for: newcli.'
  );
  expect(() => registeredProviders(['newcli'], ['claude', 'newcli'], [])).toThrow(
    'No plugin for: claude.'
  );
  // A box runtime lost by mistake refuses, rather than the box quietly offering less.
  expect(() => registeredProviders(['claude', 'codex'], ['codex'])).toThrow(
    'No runtime in agent-providers for: claude.'
  );
});

it('refuses a provider listed as left out that has a runtime after all', () => {
  expect(() => registeredProviders(['claude', 'newcli'], ['claude', 'newcli'], ['newcli'])).toThrow(
    'Listed as left out of the box, but has a runtime: newcli.'
  );
});
