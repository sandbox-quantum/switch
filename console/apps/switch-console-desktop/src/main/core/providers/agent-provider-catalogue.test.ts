import { describe, expect, it } from 'vitest';
import { buildAgentProviderCatalogue } from './agent-provider-catalogue';

const plugin = (metadata: { id: string; cliLabel?: string; knownAgentType?: string }) => ({
  metadata: {
    name: `${metadata.id} name`,
    description: `${metadata.id} description`,
    websiteUrl: `https://${metadata.id}.example.com`,
    ...metadata,
  },
});

const runtime = (id: string) => ({ id, loginCommand: `${id} login` });

describe('buildAgentProviderCatalogue', () => {
  it('makes one entry per plugin, in registration order, with its runtime login command', () => {
    const catalogue = buildAgentProviderCatalogue(
      [plugin({ id: 'beta' }), plugin({ id: 'alpha' })],
      [runtime('alpha'), runtime('beta')]
    );

    expect(catalogue).toEqual([
      {
        id: 'beta',
        name: 'beta name',
        description: 'beta description',
        docUrl: 'https://beta.example.com',
        cliLabel: 'beta name',
        loginCommand: 'beta login',
        knownAgentType: 'beta',
      },
      expect.objectContaining({ id: 'alpha', loginCommand: 'alpha login' }),
    ]);
  });

  it('takes the CLI label and gateway type from the plugin when it names them', () => {
    const [entry] = buildAgentProviderCatalogue(
      [plugin({ id: 'acme', cliLabel: 'Acme CLI', knownAgentType: 'acme-code' })],
      [runtime('acme')]
    );

    expect(entry).toMatchObject({ cliLabel: 'Acme CLI', knownAgentType: 'acme-code' });
  });

  it('refuses a plugin with no runtime, naming it', () => {
    expect(() =>
      buildAgentProviderCatalogue(
        [plugin({ id: 'acme' }), plugin({ id: 'beta' })],
        [runtime('beta')]
      )
    ).toThrow('No runtime in agent-providers for: acme.');
  });

  it('refuses a runtime with no plugin, naming it', () => {
    expect(() =>
      buildAgentProviderCatalogue([plugin({ id: 'beta' })], [runtime('beta'), runtime('acme')])
    ).toThrow('No plugin for: acme.');
  });
});
