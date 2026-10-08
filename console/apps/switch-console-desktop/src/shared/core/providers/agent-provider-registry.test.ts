import { describe, expect, it, vi } from 'vitest';

/** A fresh copy of the module, with no catalogue installed yet. */
async function freshRegistry() {
  vi.resetModules();
  return import('./agent-provider-registry');
}

const provider = (id: string, name: string) => ({
  id,
  name,
  description: `${name} description`,
  docUrl: `https://${id}.example.com`,
  cliLabel: name,
  loginCommand: `${id} login`,
  knownAgentType: id,
});

describe('agent provider catalogue', () => {
  it('refuses to answer before it is loaded', async () => {
    const registry = await freshRegistry();

    expect(() => registry.agentProviders()).toThrow('read before it was loaded');
    expect(() => registry.isValidProviderId('claude')).toThrow('read before it was loaded');
    expect(() => registry.providerDisplayName('claude')).toThrow('read before it was loaded');
  });

  it('answers from the providers it was given, in their order', async () => {
    const registry = await freshRegistry();
    registry.setAgentProviderCatalogue([provider('b', 'Bee'), provider('a', 'Ay')]);

    expect(registry.agentProviderIds()).toEqual(['b', 'a']);
    expect(registry.providerNamesSentence()).toBe('Bee and Ay');
    expect(registry.asAgentProviderId('a')).toBe('a');
    expect(() => registry.asAgentProviderId('c')).toThrow("unknown agent provider 'c'");
    expect(registry.providerDisplayName('c')).toBe('c');
  });

  it('refuses a catalogue that names a provider twice', async () => {
    const registry = await freshRegistry();

    expect(() =>
      registry.setAgentProviderCatalogue([provider('a', 'Ay'), provider('a', 'Ay again')])
    ).toThrow('names a provider twice');
  });
});
