import { describe, expect, it } from 'vitest';
import {
  appliesText,
  clockText,
  formFor,
  formProblem,
  haikuNote,
  inputFor,
  latencyText,
  machineOptionNote,
  machineSettling,
  machineStateLine,
  offeredChoices,
  offeredModelText,
  storedKeyText,
  testInputFor,
  testOutcomeText,
  withMachine,
} from '@renderer/features/admin/decision-routing';
import type {
  DecisionEffectiveMachine,
  DecisionMachineOption,
  DecisionSettings,
} from '@shared/core/switch-servers/switch-servers';

function settings(overrides: Partial<DecisionSettings> = {}): DecisionSettings {
  return {
    source: 'server_default',
    effective: {
      backend: 'endpoint',
      endpoint: 'http://decision:8230',
      threshold: null,
      available: true,
      reason: null,
      machine: null,
    },
    workspace: null,
    serverDefault: { configured: true, endpoint: 'http://decision:8230', hasApiKey: false },
    options: { haikuAnthropic: true, haikuBedrock: false, machines: null },
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
  machineId: null,
  model: null,
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
      offeredChoices(
        settings({ options: { haikuAnthropic: true, haikuBedrock: true, machines: null } })
      )
    ).toContain('haiku_bedrock');
    const noService = settings({
      options: { haikuAnthropic: false, haikuBedrock: false, machines: null },
    });
    expect(offeredChoices(noService)).toEqual(['server_default', 'none', 'endpoint']);
    expect(haikuNote(noService)).toContain('this server has none configured');
    expect(haikuNote(settings())).toContain('Bedrock');
  });

  it('keeps a saved choice the server no longer offers, so the form shows what is stored', () => {
    expect(
      offeredChoices(
        settings({
          workspace: OWN_HAIKU,
          options: { haikuAnthropic: false, haikuBedrock: false, machines: null },
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
      machineId: '',
      model: '',
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

const QWEN = {
  model: 'qwen3.5-4b-q4_k_m',
  label: 'Qwen3.5-4B',
  kind: 'llamacpp',
  runtime: 'llamacpp-metal',
  downloadBytes: 2_700_000_000,
  speed: 'fast' as const,
};

const MAC: DecisionMachineOption = {
  id: 'ctl-mac',
  name: 'Mac-Studio',
  connected: true,
  decision: {
    supported: true,
    hardware: {
      accelerator: 'apple_silicon',
      memoryBytes: 64_000_000_000,
      gpuName: null,
      vramBytes: null,
    },
    offered: [QWEN],
    reason: null,
  },
};

const OLD_BOX: DecisionMachineOption = {
  id: 'ctl-old',
  name: 'old-box',
  connected: false,
  decision: {
    supported: false,
    hardware: null,
    offered: [],
    reason: 'Update this machine’s controller',
  },
};

function onMachine(machine: Partial<DecisionEffectiveMachine> = {}): DecisionEffectiveMachine {
  return {
    id: 'ctl-mac',
    name: 'Mac-Studio',
    model: 'qwen3.5-4b-q4_k_m',
    state: 'running',
    progress: null,
    ready: true,
    reason: null,
    lastDecisionMs: null,
    connected: true,
    since: null,
    ...machine,
  };
}

function machineSettings(machine: DecisionEffectiveMachine | null): DecisionSettings {
  return settings({
    source: 'workspace',
    effective: {
      backend: 'machine',
      endpoint: null,
      threshold: null,
      available: machine?.ready ?? false,
      reason: null,
      machine,
    },
    workspace: {
      backend: 'machine',
      endpoint: null,
      threshold: null,
      hasApiKey: false,
      apiKeyLast4: null,
      apiKeyUnreadable: false,
      updatedAt: '2026-10-29T10:00:00Z',
      machineId: 'ctl-mac',
      model: 'qwen3.5-4b-q4_k_m',
    },
    options: { haikuAnthropic: true, haikuBedrock: false, machines: [MAC, OLD_BOX] },
  });
}

describe('running auto-route on one of my machines', () => {
  it('is offered by a server that lists machines, and not by one that predates them', () => {
    expect(offeredChoices(settings())).not.toContain('machine');
    expect(
      offeredChoices(
        settings({ options: { haikuAnthropic: true, haikuBedrock: false, machines: [] } })
      )
    ).toContain('machine');
  });

  it('says which machine and model apply', () => {
    expect(appliesText(machineSettings(onMachine()))).toBe(
      'This workspace’s own setting applies: Run on one of my machines (Mac-Studio, Qwen3.5-4B). The server default is self-hosted decision service (http://decision:8230).'
    );
  });

  it('starts the form from the saved machine and model, and saves them alone', () => {
    const form = formFor(machineSettings(onMachine()));
    expect(form).toMatchObject({
      choice: 'machine',
      machineId: 'ctl-mac',
      model: 'qwen3.5-4b-q4_k_m',
    });
    expect(inputFor(form)).toEqual({
      backend: 'machine',
      machineId: 'ctl-mac',
      model: 'qwen3.5-4b-q4_k_m',
    });
    expect(testInputFor(form, machineSettings(onMachine()))).toEqual({
      input: { backend: 'machine', machineId: 'ctl-mac', model: 'qwen3.5-4b-q4_k_m' },
    });
  });

  it('needs a machine of yours that can run the model, and a model it offers', () => {
    const current = machineSettings(onMachine());
    const blank = { ...formFor(settings()), choice: 'machine' as const };
    expect(formProblem(blank, current)).toBe('Choose one of your machines.');
    expect(formProblem({ ...blank, machineId: 'ctl-gone' }, current)).toBe(
      'That machine isn’t one of yours in this workspace any more.'
    );
    expect(formProblem({ ...blank, machineId: 'ctl-old' }, current)).toBe(
      'Update this machine’s controller'
    );
    expect(formProblem({ ...blank, machineId: 'ctl-mac' }, current)).toBe('Choose a model.');
    expect(formProblem({ ...blank, machineId: 'ctl-mac', model: 'llama-70b' }, current)).toBe(
      'That machine doesn’t offer this model. Choose one it offers.'
    );
    expect(
      formProblem({ ...blank, machineId: 'ctl-mac', model: 'qwen3.5-4b-q4_k_m' }, current)
    ).toBeNull();
  });

  it('picks the machine’s fast model when a machine is chosen', () => {
    const slow = { ...QWEN, model: 'qwen-cpu', label: 'Qwen CPU', speed: 'slow' as const };
    const machine = { ...MAC, decision: { ...MAC.decision, offered: [slow, QWEN] } };
    expect(withMachine({ ...formFor(settings()), choice: 'machine' }, machine)).toMatchObject({
      machineId: 'ctl-mac',
      model: 'qwen3.5-4b-q4_k_m',
    });
  });

  it('describes each machine in the picker and each model in the select', () => {
    expect(machineOptionNote(MAC)).toBe('Apple Silicon, 64.0 GB memory');
    expect(machineOptionNote(OLD_BOX)).toBe('Update this machine’s controller · Not connected now');
    expect(machineOptionNote({ ...MAC, connected: false })).toBe(
      'Apple Silicon, 64.0 GB memory · Not connected now'
    );
    expect(offeredModelText(QWEN)).toBe('Qwen3.5-4B · fast · 2.7 GB download');
    expect(offeredModelText({ ...QWEN, speed: 'slow' })).toBe(
      'Qwen3.5-4B · slow on this machine · 2.7 GB download'
    );
  });

  it('says where the model stands in a line', () => {
    const now = new Date('2026-10-29T15:00:00');
    const line = (machine: Partial<DecisionEffectiveMachine>) =>
      machineStateLine(onMachine(machine), MAC, now);
    expect(line({ state: 'off', ready: false })).toEqual({ text: 'Getting ready', tone: 'busy' });
    expect(
      line({
        state: 'downloading',
        progress: { doneBytes: 1_200_000_000, totalBytes: 2_700_000_000 },
      })
    ).toEqual({ text: 'Downloading 1.2 / 2.7 GB', tone: 'busy' });
    expect(line({ state: 'downloading' }).text).toBe('Downloading');
    expect(line({ state: 'starting' })).toEqual({ text: 'Starting', tone: 'busy' });
    expect(line({ state: 'running', lastDecisionMs: 480 })).toEqual({
      text: 'Running · Qwen3.5-4B · last decision 0.48 s',
      tone: 'ok',
    });
    expect(line({ state: 'running' }).text).toBe('Running · Qwen3.5-4B');
    const offline = line({ connected: false, since: '2026-10-29T14:05:00' });
    expect(offline.tone).toBe('problem');
    expect(offline.text).toBe(`Offline since ${clockText('2026-10-29T14:05:00', now)}`);
    expect(line({ connected: false }).text).toBe('Offline');
    expect(line({ state: 'off', reason: 'turned_off_on_machine' })).toEqual({
      text: 'Turned off on the machine',
      tone: 'idle',
    });
  });

  it('takes the picker’s connected flag when the state doesn’t say', () => {
    expect(
      machineStateLine(onMachine({ connected: null }), { ...MAC, connected: false }).text
    ).toBe('Offline');
  });

  it('words each reason the machine gives for failing', () => {
    const failed = (reason: string | null) =>
      machineStateLine(onMachine({ state: 'failed', reason }), MAC).text;
    expect(failed('not_enough_disk')).toBe(
      'Failed: not enough disk space (the model needs 2.7 GB)'
    );
    expect(failed('download_failed')).toBe('Failed: the model could not be downloaded');
    expect(failed('checksum_mismatch')).toBe(
      'Failed: the downloaded model didn’t match its checksum, so it was discarded'
    );
    expect(failed('model_server_crashed')).toBe('Failed: the model server kept crashing');
    expect(failed('out_of_memory')).toBe('Failed: not enough memory to run the model');
    expect(failed('unsupported_hardware')).toBe('Failed: this machine can’t run the model');
    expect(failed('gpu_on_fire')).toBe('Failed: gpu on fire');
    expect(failed(null)).toBe('Failed: the machine didn’t say why');
  });

  it('keeps asking while the model gets ready or the machine is offline', () => {
    expect(machineSettling(settings())).toBe(false);
    expect(machineSettling(machineSettings(null))).toBe(false);
    expect(machineSettling(machineSettings(onMachine({ state: 'downloading' })))).toBe(true);
    expect(machineSettling(machineSettings(onMachine({ state: 'starting' })))).toBe(true);
    expect(machineSettling(machineSettings(onMachine({ state: 'off' })))).toBe(true);
    expect(machineSettling(machineSettings(onMachine({ state: 'running' })))).toBe(false);
    expect(machineSettling(machineSettings(onMachine({ state: 'failed' })))).toBe(false);
    expect(machineSettling(machineSettings(onMachine({ connected: false })))).toBe(true);
  });

  it('shows the clock time of a moment today, and the date before', () => {
    const now = new Date('2026-10-29T15:00:00');
    expect(clockText('2026-10-29T14:05:00', now)).not.toMatch(/Oct/);
    expect(clockText('2026-10-28T14:05:00', now)).toMatch(/28/);
  });
});
