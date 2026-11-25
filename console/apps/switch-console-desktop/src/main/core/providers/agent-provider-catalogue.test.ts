import { describe, expect, it } from 'vitest';
import { buildAgentProviderCatalogue } from './agent-provider-catalogue';

const plugin = (metadata: {
  id: string;
  cliLabel?: string;
  shortName?: string;
  knownAgentType?: string;
  supportsAutoMode?: boolean;
}) => ({
  metadata: {
    name: `${metadata.id} name`,
    description: `${metadata.id} description`,
    websiteUrl: `https://${metadata.id}.example.com`,
    ...metadata,
  },
});

const runtime = (id: string, newAgentAutoMode = true) => ({
  id,
  loginCommand: `${id} login`,
  newAgentAutoMode,
});

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
        shortName: 'beta name',
        loginCommand: 'beta login',
        knownAgentType: 'beta',
        supportsAutoMode: true,
        newAgentAutoMode: true,
      },
      expect.objectContaining({ id: 'alpha', loginCommand: 'alpha login' }),
    ]);
  });

  it('takes the CLI label, short name and gateway type from the plugin when it names them', () => {
    const [entry] = buildAgentProviderCatalogue(
      [
        plugin({
          id: 'acme',
          cliLabel: 'Acme CLI',
          shortName: 'Acme',
          knownAgentType: 'acme-code',
        }),
      ],
      [runtime('acme')]
    );

    expect(entry).toMatchObject({
      cliLabel: 'Acme CLI',
      shortName: 'Acme',
      knownAgentType: 'acme-code',
    });
  });

  it('preserves a provider runtime without Auto mode', () => {
    const [entry] = buildAgentProviderCatalogue(
      [plugin({ id: 'cursor', supportsAutoMode: false })],
      [runtime('cursor')]
    );
    expect(entry.supportsAutoMode).toBe(false);
  });

  it("takes whether a new agent starts in auto mode from the provider's runtime", () => {
    const [entry] = buildAgentProviderCatalogue([plugin({ id: 'acme' })], [runtime('acme', false)]);

    expect(entry?.newAgentAutoMode).toBe(false);
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
