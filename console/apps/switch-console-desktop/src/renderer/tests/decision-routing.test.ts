import { describe, expect, it } from 'vitest';
import {
  appliesText,
  formFor,
  formProblem,
  haikuNote,
  inputFor,
  latencyText,
  offeredChoices,
  storedKeyText,
  testInputFor,
  testOutcomeText,
} from '@renderer/features/admin/decision-routing';
import type { DecisionSettings } from '@shared/core/switch-servers/switch-servers';

function settings(overrides: Partial<DecisionSettings> = {}): DecisionSettings {
  return {
    source: 'server_default',
    effective: {
      backend: 'endpoint',
      endpoint: 'http://decision:8230',
      threshold: null,
      available: true,
      reason: null,
    },
    workspace: null,
    serverDefault: { configured: true, endpoint: 'http://decision:8230', hasApiKey: false },
    options: { haikuAnthropic: true, haikuBedrock: false },
    ...overrides,
  };
}

const OWN_HAIKU: DecisionSettings['workspace'] = {
  backend: 'haiku_anthropic',
  endpoint: null,
  threshold: 0.4,
  hasApiKey: true,
  apiKeyLast4: 'AwcA',
  apiKeyUnreadable: false,
  updatedAt: '2026-10-27T10:00:00Z',
};

describe('decision routing settings in words', () => {
  it('says the server default applies, and what it is', () => {
    expect(appliesText(settings())).toBe(
      'This workspace uses the server default: self-hosted decision service (http://decision:8230).'
    );
    expect(
      appliesText(
        settings({ serverDefault: { configured: false, endpoint: null, hasApiKey: false } })
      )
    ).toBe(
      'This workspace uses the server default: none — this server has no decision service configured.'
    );
  });

  it('says the workspace’s own setting applies, beside the server default', () => {
    expect(appliesText(settings({ source: 'workspace', workspace: OWN_HAIKU }))).toBe(
      'This workspace’s own setting applies: Haiku (Anthropic API). The server default is self-hosted decision service (http://decision:8230).'
    );
  });

  it('shows a stored key only by its last four characters, or as unreadable', () => {
    expect(storedKeyText(settings())).toBeNull();
    expect(storedKeyText(settings({ workspace: OWN_HAIKU }))).toBe('set, ending in AwcA');
    expect(
      storedKeyText(
        settings({ workspace: { ...OWN_HAIKU!, apiKeyLast4: null, apiKeyUnreadable: true } })
      )
    ).toBe('set but unreadable — enter a new key to replace it');
  });

  it('formats a latency in seconds and a test’s outcome', () => {
    expect(latencyText(420)).toBe('0.42 s');
    expect(
      testOutcomeText({
        ok: true,
        agent: 'deploy-bot',
        modelChoice: 'deploy-bot',
        confidence: 0.912,
        latencyMs: 420,
        backend: 'endpoint',
        error: null,
      })
    ).toBe('Picked deploy-bot · confidence 0.91 · 0.42 s');
    expect(
      testOutcomeText({
        ok: true,
        agent: null,
        modelChoice: 'none',
        confidence: 0.3,
        latencyMs: 1500,
        backend: 'endpoint',
        error: null,
      })
    ).toBe('Picked nobody (none) · confidence 0.30 · 1.50 s');
    expect(
      testOutcomeText({
        ok: false,
        agent: null,
        modelChoice: null,
        confidence: null,
        latencyMs: null,
        backend: 'endpoint',
        error: { code: 'unreachable', message: 'The endpoint could not be reached within 5 s.' },
      })
    ).toBe('The endpoint could not be reached within 5 s.');
  });
});

describe('the backends offered', () => {
  it('offers Haiku only where the server runs a decision service, and Bedrock only where allowed', () => {
    expect(offeredChoices(settings())).toEqual([
      'server_default',
      'none',
      'endpoint',
      'haiku_anthropic',
    ]);
    expect(
      offeredChoices(settings({ options: { haikuAnthropic: true, haikuBedrock: true } }))
    ).toContain('haiku_bedrock');
    const noService = settings({ options: { haikuAnthropic: false, haikuBedrock: false } });
    expect(offeredChoices(noService)).toEqual(['server_default', 'none', 'endpoint']);
    expect(haikuNote(noService)).toContain('this server has none configured');
    expect(haikuNote(settings())).toContain('Bedrock');
  });

  it('keeps a saved choice the server no longer offers, so the form shows what is stored', () => {
    expect(
      offeredChoices(
        settings({
          workspace: OWN_HAIKU,
          options: { haikuAnthropic: false, haikuBedrock: false },
        })
      )
    ).toContain('haiku_anthropic');
  });
});

describe('the form', () => {
  it('starts from the stored setting, never the key', () => {
    expect(formFor(settings())).toEqual({
      choice: 'server_default',
      endpoint: '',
      apiKey: '',
      clearApiKey: false,
      threshold: '',
    });
    expect(formFor(settings({ source: 'workspace', workspace: OWN_HAIKU }))).toMatchObject({
      choice: 'haiku_anthropic',
      apiKey: '',
      threshold: '0.4',
    });
  });

  it('refuses a threshold outside 0 to 1, a missing endpoint, and Haiku with no key', () => {
    const base = formFor(settings());
    expect(formProblem({ ...base, choice: 'endpoint', endpoint: '' }, settings())).toBe(
      'Enter the endpoint’s URL.'
    );
    expect(
      formProblem(
        { ...base, choice: 'endpoint', endpoint: 'https://d.example', threshold: '1.5' },
        settings()
      )
    ).toBe('The threshold must be between 0 and 1.');
    expect(
      formProblem(
        { ...base, choice: 'endpoint', endpoint: 'https://d.example', threshold: 'abc' },
        settings()
      )
    ).toBe('The threshold must be between 0 and 1.');
    expect(formProblem({ ...base, choice: 'haiku_anthropic' }, settings())).toBe(
      'Enter an Anthropic API key.'
    );
    expect(
      formProblem({ ...base, choice: 'haiku_anthropic' }, settings({ workspace: OWN_HAIKU }))
    ).toBeNull();
    expect(formProblem({ ...base, choice: 'none' }, settings())).toBeNull();
  });

  it('sends only the fields a backend takes, keeping the stored key when none is typed', () => {
    const base = formFor(settings());
    expect(inputFor(base)).toBeNull();
    expect(inputFor({ ...base, choice: 'none', endpoint: 'x', threshold: '0.3' })).toEqual({
      backend: 'none',
    });
    expect(
      inputFor({ ...base, choice: 'endpoint', endpoint: ' https://d.example ', threshold: '0.5' })
    ).toEqual({ backend: 'endpoint', endpoint: 'https://d.example', threshold: 0.5 });
    expect(inputFor({ ...base, choice: 'haiku_anthropic', apiKey: ' fake-key ' })).toEqual({
      backend: 'haiku_anthropic',
      apiKey: 'fake-key',
      threshold: null,
    });
    expect(
      inputFor({ ...base, choice: 'endpoint', endpoint: 'https://d.example', clearApiKey: true })
    ).toMatchObject({ clearApiKey: true });
    expect(inputFor({ ...base, choice: 'haiku_bedrock', apiKey: 'ignored' })).toEqual({
      backend: 'haiku_bedrock',
      threshold: null,
    });
  });

  it('tests the server default as `default`, whatever the workspace has saved', () => {
    const base = formFor(settings());
    expect(testInputFor(base, settings())).toEqual({ input: { backend: 'default' } });
    expect(testInputFor(base, settings({ source: 'workspace', workspace: OWN_HAIKU }))).toEqual({
      input: { backend: 'default' },
    });
    expect(
      testInputFor(
        base,
        settings({ serverDefault: { configured: false, endpoint: null, hasApiKey: false } })
      )
    ).toMatchObject({ blocked: expect.stringContaining('no decision service') });
    expect(testInputFor({ ...base, choice: 'none' }, settings())).toMatchObject({
      blocked: expect.any(String),
    });
    expect(
      testInputFor({ ...base, choice: 'endpoint', endpoint: 'https://d.example' }, settings())
    ).toEqual({ input: { backend: 'endpoint', endpoint: 'https://d.example', threshold: null } });
  });
});
