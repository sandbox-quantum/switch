import type {
  DecisionBackend,
  DecisionSettings,
  DecisionSettingsInput,
  DecisionTestInput,
  DecisionTestOutcome,
} from '../contracts/decision-routing';

export type {
  DecisionBackend,
  DecisionSettings,
  DecisionSettingsInput,
  DecisionTestInput,
  DecisionTestOutcome,
};

export type DecisionChoice = 'server_default' | DecisionBackend;

export type DecisionForm = {
  choice: DecisionChoice;
  endpoint: string;
  apiKey: string;
  clearApiKey: boolean;
  threshold: string;
};

export const CHOICE_LABELS = {
  server_default: 'Use server default',
  none: 'None',
  endpoint: 'Self-hosted endpoint',
  haiku_anthropic: 'Haiku (Anthropic API)',
  haiku_bedrock: 'Haiku on Bedrock',
} as const satisfies Record<DecisionChoice, string>;

export function formFor(settings: DecisionSettings): DecisionForm {
  const own = settings.workspace;
  return {
    choice: own?.backend ?? 'server_default',
    endpoint: own?.endpoint ?? '',
    apiKey: '',
    clearApiKey: false,
    threshold: own?.threshold === null || own?.threshold === undefined ? '' : String(own.threshold),
  };
}

export function offeredChoices(settings: DecisionSettings): DecisionChoice[] {
  const saved = settings.workspace?.backend;
  return [
    'server_default',
    'none',
    'endpoint',
    ...(settings.options.haikuAnthropic || saved === 'haiku_anthropic'
      ? (['haiku_anthropic'] as const)
      : []),
    ...(settings.options.haikuBedrock || saved === 'haiku_bedrock'
      ? (['haiku_bedrock'] as const)
      : []),
  ];
}

export function haikuNote(settings: DecisionSettings): string | null {
  if (!settings.options.haikuAnthropic) {
    return "Haiku isn't offered: it runs inside this server's decision service, and this server has none configured. Its operator can add one.";
  }
  if (!settings.options.haikuBedrock) {
    return "Haiku on Bedrock isn't offered: it uses this server's own AWS credentials, so its operator has to turn it on.";
  }
  return null;
}

export function serverDefaultText(settings: DecisionSettings): string {
  const { serverDefault } = settings;
  if (!serverDefault.configured) return 'none — this server has no decision service configured';
  return serverDefault.endpoint
    ? `self-hosted decision service (${serverDefault.endpoint})`
    : 'self-hosted decision service';
}

export function appliesText(settings: DecisionSettings): string {
  if (settings.source === 'server_default') {
    return `This workspace uses the server default: ${serverDefaultText(settings)}.`;
  }
  const own = settings.workspace;
  const backend = own?.backend ?? settings.effective.backend;
  const where = backend === 'endpoint' && own?.endpoint ? ` (${own.endpoint})` : '';
  return `This workspace's own setting applies: ${CHOICE_LABELS[backend]}${where}. The server default is ${serverDefaultText(settings)}.`;
}

export function storedKeyText(settings: DecisionSettings): string | null {
  const own = settings.workspace;
  if (!own?.hasApiKey) return null;
  if (own.apiKeyUnreadable || !own.apiKeyLast4) {
    return 'set but unreadable — enter a new key to replace it';
  }
  return `set, ending in ${own.apiKeyLast4}`;
}

export function choiceFields(choice: DecisionChoice): {
  endpoint: boolean;
  key: boolean;
  threshold: boolean;
} {
  return {
    endpoint: choice === 'endpoint',
    key: choice === 'endpoint' || choice === 'haiku_anthropic',
    threshold: choice === 'endpoint' || choice === 'haiku_anthropic' || choice === 'haiku_bedrock',
  };
}

function parsedThreshold(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return Number(trimmed);
}

function endpointMovedWithoutKey(form: DecisionForm, settings: DecisionSettings): boolean {
  const own = settings.workspace;
  return (
    form.choice === 'endpoint' &&
    own?.backend === 'endpoint' &&
    own.hasApiKey &&
    own.endpoint !== form.endpoint.trim() &&
    form.apiKey.trim() === '' &&
    !form.clearApiKey
  );
}

export function formProblem(form: DecisionForm, settings: DecisionSettings): string | null {
  const fields = choiceFields(form.choice);
  if (fields.endpoint && form.endpoint.trim() === '') return "Enter the endpoint's URL.";
  if (endpointMovedWithoutKey(form, settings)) {
    return 'The endpoint changed: enter its key, or remove the stored key to call it without one.';
  }
  if (form.choice === 'haiku_anthropic' && form.apiKey.trim() === '') {
    const own = settings.workspace;
    const usableKey = own?.hasApiKey && !own.apiKeyUnreadable && !form.clearApiKey;
    if (!usableKey) return 'Enter an Anthropic API key.';
  }
  if (fields.threshold) {
    const threshold = parsedThreshold(form.threshold);
    if (threshold !== null && !(threshold >= 0 && threshold <= 1)) {
      return 'The threshold must be between 0 and 1.';
    }
  }
  return null;
}

export function inputFor(form: DecisionForm): DecisionSettingsInput | null {
  if (form.choice === 'server_default') return null;
  const fields = choiceFields(form.choice);
  const apiKey = form.apiKey.trim();
  return {
    backend: form.choice,
    ...(fields.endpoint ? { endpoint: form.endpoint.trim() } : {}),
    ...(fields.key && apiKey !== '' ? { apiKey } : {}),
    ...(fields.key && apiKey === '' && form.clearApiKey ? { clearApiKey: true } : {}),
    ...(fields.threshold ? { threshold: parsedThreshold(form.threshold) } : {}),
  };
}

export function testInputFor(
  form: DecisionForm,
  settings: DecisionSettings
): { input: DecisionTestInput } | { blocked: string } {
  if (form.choice === 'none') return { blocked: 'Nothing to test: auto-route is off.' };
  if (form.choice === 'server_default') {
    if (!settings.serverDefault.configured) {
      return { blocked: 'Nothing to test: this server has no decision service configured.' };
    }
    return { input: { backend: 'default' } };
  }
  const problem = formProblem(form, settings);
  if (problem !== null) return { blocked: problem };
  return { input: inputFor(form) as DecisionSettingsInput };
}

export function latencyText(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

export function testOutcomeText(outcome: DecisionTestOutcome): string {
  if (!outcome.ok) {
    return outcome.error?.message ?? 'The test failed without saying why.';
  }
  const pick = outcome.agent === null ? 'Picked nobody (none)' : `Picked ${outcome.agent}`;
  const parts = [pick];
  if (outcome.confidence !== null) parts.push(`confidence ${outcome.confidence.toFixed(2)}`);
  if (outcome.latencyMs !== null) parts.push(latencyText(outcome.latencyMs));
  return parts.join(' · ');
}
