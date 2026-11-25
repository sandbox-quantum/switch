import { describe, expect, it } from 'vitest';
import {
  appliesText,
  choiceFields,
  choiceHint,
  choiceLabel,
  choicesNote,
  defaultThreshold,
  formFor,
  formProblem,
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
    serverDefault: {
      configured: true,
      endpoint: 'http://decision:8230',
      hasApiKey: false,
      info: null,
    },
    options: options(),
    ...overrides,
  };
}

/** What a server offers when its decision service lists no backends (one
 * older than offers from the service): Haiku with a key, Bedrock as given. */
function options(
  overrides: Partial<DecisionSettings['options']> = {}
): DecisionSettings['options'] {
  return {
    haikuAnthropic: true,
    haikuBedrock: false,
    selfHosted: false,
    gemini: false,
    details: {},
    source: 'configuration',
    note: null,
    ...overrides,
  };
}

const NO_SERVICE: Partial<DecisionSettings> = {
  serverDefault: { configured: false, endpoint: null, hasApiKey: false, info: null },
  options: options({ haikuAnthropic: false, source: 'none' }),
};

/** A server whose decision service lists every backend, as it describes them. */
const LISTED: Partial<DecisionSettings> = {
  serverDefault: {
    configured: true,
    endpoint: 'http://decision:8230',
    hasApiKey: false,
    info: { label: 'Qwen3 235B (Bedrock)', model: 'qwen3-235b', threshold: 0.89, fallback: null },
  },
  options: options({
    haikuBedrock: true,
    selfHosted: true,
    gemini: true,
    source: 'service',
    details: {
      self_hosted: {
        label: 'vllm-sr d3-mini (self-hosted)',
        model: 'vllm-sr/d3-mini',
        threshold: 0.56,
        fallback: null,
      },
      gemini: {
        label: 'Gemini (gemini-decision-1)',
        model: 'gemini-decision-1',
        threshold: 0.8,
        fallback: {
          backend: 'bedrock',
          model: 'claude-haiku',
          label: 'Claude Haiku (Bedrock)',
          afterS: 1.5,
        },
      },
      haiku_bedrock: {
        label: 'Claude Haiku (Bedrock)',
        model: 'claude-haiku',
        threshold: 0.65,
        fallback: null,
      },
      haiku_anthropic: {
        label: 'Claude Haiku (Anthropic)',
        model: 'claude-haiku',
        threshold: 0.65,
        fallback: null,
      },
    },
  }),
};

const OWN_HAIKU: DecisionSettings['workspace'] = {
  backend: 'haiku_anthropic',
  unrecognizedBackend: null,
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
      'This workspace uses the server default: this server’s decision service (http://decision:8230).'
    );
    expect(appliesText(settings(LISTED))).toBe(
      'This workspace uses the server default: Qwen3 235B (Bedrock).'
    );
    expect(appliesText(settings(NO_SERVICE))).toBe(
      'This workspace uses the server default: none — this server has no decision service configured.'
    );
  });

  it('says the workspace’s own setting applies, beside the server default', () => {
    expect(appliesText(settings({ source: 'workspace', workspace: OWN_HAIKU }))).toBe(
      'This workspace’s own setting applies: Claude Haiku with your Anthropic key. The server default is this server’s decision service (http://decision:8230).'
    );
    expect(
      appliesText(
        settings({
          ...LISTED,
          source: 'workspace',
          workspace: { ...OWN_HAIKU!, backend: 'gemini', hasApiKey: false, apiKeyLast4: null },
        })
      )
    ).toBe(
      'This workspace’s own setting applies: Gemini, with Claude Haiku if slow. The server default is Qwen3 235B (Bedrock).'
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
  it('offers what the decision service lists, in order, beside your own endpoint and none', () => {
    expect(offeredChoices(settings(LISTED))).toEqual([
      'server_default',
      'self_hosted',
      'gemini',
      'haiku_bedrock',
      'haiku_anthropic',
      'endpoint',
      'none',
    ]);
    expect(choicesNote(settings(LISTED))).toBeNull();
  });

  it('names each choice as the decision service does', () => {
    const listed = settings(LISTED);
    expect(choiceLabel('server_default', listed)).toBe('Server default: Qwen3 235B (Bedrock)');
    expect(choiceLabel('self_hosted', listed)).toBe('vllm-sr d3-mini (self-hosted)');
    expect(choiceLabel('gemini', listed)).toBe('Gemini, with Claude Haiku if slow');
    expect(choiceLabel('haiku_bedrock', listed)).toBe('Claude Haiku (Bedrock)');
    expect(choiceLabel('haiku_anthropic', listed)).toBe('Claude Haiku with your Anthropic key');
    expect(choiceLabel('endpoint', listed)).toBe('Your own endpoint');
    expect(choiceLabel('none', listed)).toBe('None');
    expect(choiceHint('gemini', listed)).toBe(
      'Google’s Gemini, through this server’s decision service. Room messages are sent to Google. Falls back to Claude Haiku (Bedrock) after 1.5 s. Model gemini-decision-1, threshold 0.8 by default.'
    );
    expect(choiceHint('server_default', listed)).toContain(
      'Model qwen3-235b, threshold 0.89 by default.'
    );
  });

  it('falls back to its own names where the service describes nothing', () => {
    expect(choiceLabel('server_default', settings())).toBe('Use server default');
    expect(choiceHint('server_default', settings())).toBe(
      'Currently this server’s decision service (http://decision:8230).'
    );
    expect(choiceLabel('haiku_bedrock', settings())).toBe('Claude Haiku (Bedrock)');
  });

  it('shows the threshold each choice uses by default', () => {
    const listed = settings(LISTED);
    expect(defaultThreshold('self_hosted', listed)).toBe(0.56);
    expect(defaultThreshold('gemini', listed)).toBe(0.8);
    expect(defaultThreshold('haiku_bedrock', listed)).toBe(0.65);
    expect(defaultThreshold('endpoint', listed)).toBeNull();
    expect(defaultThreshold('self_hosted', settings())).toBeNull();
    expect(choiceFields('self_hosted')).toEqual({ endpoint: false, key: false, threshold: true });
    expect(choiceFields('gemini')).toEqual({ endpoint: false, key: false, threshold: true });
  });

  it('offers Haiku only where the server runs a decision service, and Bedrock only where allowed', () => {
    expect(offeredChoices(settings())).toEqual([
      'server_default',
      'haiku_anthropic',
      'endpoint',
      'none',
    ]);
    expect(offeredChoices(settings({ options: options({ haikuBedrock: true }) }))).toContain(
      'haiku_bedrock'
    );
    const noService = settings(NO_SERVICE);
    expect(offeredChoices(noService)).toEqual(['server_default', 'endpoint', 'none']);
    expect(choicesNote(noService)).toContain('this server has none configured');
    expect(choicesNote(settings())).toContain('Bedrock');
  });

  it('keeps a saved choice the server no longer offers, so the form shows what is stored', () => {
    expect(
      offeredChoices(
        settings({
          workspace: OWN_HAIKU,
          options: options({ haikuAnthropic: false }),
        })
      )
    ).toContain('haiku_anthropic');
    const unreadable = settings({
      workspace: { ...OWN_HAIKU!, backend: 'self_hosted' },
      options: options({
        haikuAnthropic: false,
        source: 'unavailable',
        note: 'Switch couldn’t read which backends its decision service offers.',
      }),
    });
    expect(offeredChoices(unreadable)).toEqual([
      'server_default',
      'self_hosted',
      'endpoint',
      'none',
    ]);
    expect(choicesNote(unreadable)).toContain('couldn’t read');
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

  it('asks for a key when the saved endpoint moves to another URL', () => {
    const own: DecisionSettings['workspace'] = {
      ...OWN_HAIKU!,
      backend: 'endpoint',
      endpoint: 'https://d.example/decide',
    };
    const saved = settings({ workspace: own });
    const moved = {
      ...formFor(saved),
      choice: 'endpoint' as const,
      endpoint: 'https://e.example/decide',
    };

    expect(formProblem(moved, saved)).toBe(
      'The endpoint changed: enter its key, or remove the stored key to call it without one.'
    );
    expect(formProblem({ ...moved, apiKey: 'fake-key-NewA' }, saved)).toBeNull();
    expect(formProblem({ ...moved, clearApiKey: true }, saved)).toBeNull();
    expect(formProblem({ ...moved, endpoint: 'https://d.example/decide' }, saved)).toBeNull();
    expect(formProblem(moved, settings({ workspace: { ...own!, hasApiKey: false } }))).toBeNull();
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
    expect(
      inputFor({ ...base, choice: 'self_hosted', apiKey: 'ignored', threshold: '0.6' })
    ).toEqual({ backend: 'self_hosted', threshold: 0.6 });
    expect(inputFor({ ...base, choice: 'gemini' })).toEqual({ backend: 'gemini', threshold: null });
  });

  it('tests the server default as `default`, whatever the workspace has saved', () => {
    const base = formFor(settings());
    expect(testInputFor(base, settings())).toEqual({ input: { backend: 'default' } });
    expect(testInputFor(base, settings({ source: 'workspace', workspace: OWN_HAIKU }))).toEqual({
      input: { backend: 'default' },
    });
    expect(testInputFor(base, settings(NO_SERVICE))).toMatchObject({
      blocked: expect.stringContaining('no decision service'),
    });
    expect(testInputFor({ ...base, choice: 'none' }, settings())).toMatchObject({
      blocked: expect.any(String),
    });
    expect(
      testInputFor({ ...base, choice: 'endpoint', endpoint: 'https://d.example' }, settings())
    ).toEqual({ input: { backend: 'endpoint', endpoint: 'https://d.example', threshold: null } });
    expect(testInputFor({ ...base, choice: 'self_hosted' }, settings(LISTED))).toEqual({
      input: { backend: 'self_hosted', threshold: null },
    });
    expect(testInputFor({ ...base, choice: 'gemini' }, settings(LISTED))).toEqual({
      input: { backend: 'gemini', threshold: null },
    });
  });
});
