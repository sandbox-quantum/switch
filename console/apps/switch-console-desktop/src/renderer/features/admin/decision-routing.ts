import type {
  DecisionBackend,
  DecisionSettings,
  DecisionSettingsInput,
  DecisionTestInput,
  DecisionTestOutcome,
} from '@shared/core/switch-servers/switch-servers';

/** What the form offers: the server's default, or one of the backends a
 * workspace can save as its own. */
export type DecisionChoice = 'server_default' | DecisionBackend;

export type DecisionForm = {
  choice: DecisionChoice;
  endpoint: string;
  /** A new key; blank keeps whatever key is stored. */
  apiKey: string;
  /** Remove the stored key on save. */
  clearApiKey: boolean;
  /** As typed; blank leaves it to the decision service. */
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

/**
 * The choices the form offers, in order. Haiku runs inside the server's
 * decision service, so neither Haiku choice is offered without one; Bedrock
 * spends the server's AWS credentials, so it is offered only where the
 * operator allows it. A workspace already saved on a choice the server no
 * longer offers still sees it, so the form shows what is stored.
 */
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

/** Why a Haiku choice is missing, or null when both are offered. */
export function haikuNote(settings: DecisionSettings): string | null {
  if (!settings.options.haikuAnthropic) {
    return 'Haiku isn’t offered: it runs inside this server’s decision service, and this server has none configured. Its operator can add one.';
  }
  if (!settings.options.haikuBedrock) {
    return 'Haiku on Bedrock isn’t offered: it uses this server’s own AWS credentials, so its operator has to turn it on.';
  }
  return null;
}

/** The server's default in words. */
export function serverDefaultText(settings: DecisionSettings): string {
  const { serverDefault } = settings;
  if (!serverDefault.configured) return 'none — this server has no decision service configured';
  return serverDefault.endpoint
    ? `self-hosted decision service (${serverDefault.endpoint})`
    : 'self-hosted decision service';
}

/** Which setting applies to the workspace's rooms, and what it comes to. */
export function appliesText(settings: DecisionSettings): string {
  if (settings.source === 'server_default') {
    return `This workspace uses the server default: ${serverDefaultText(settings)}.`;
  }
  const own = settings.workspace;
  const backend = own?.backend ?? settings.effective.backend;
  const where = backend === 'endpoint' && own?.endpoint ? ` (${own.endpoint})` : '';
  return `This workspace’s own setting applies: ${CHOICE_LABELS[backend]}${where}. The server default is ${serverDefaultText(settings)}.`;
}

/** The stored key, in words: never the key itself. */
export function storedKeyText(settings: DecisionSettings): string | null {
  const own = settings.workspace;
  if (!own?.hasApiKey) return null;
  if (own.apiKeyUnreadable || !own.apiKeyLast4) {
    return 'set but unreadable — enter a new key to replace it';
  }
  return `set, ending in ${own.apiKeyLast4}`;
}

/** Whether a choice takes a key, an endpoint and a threshold. */
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

/** The threshold as typed: null when blank, NaN when it isn't a number. */
function parsedThreshold(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return Number(trimmed);
}

/** What stops the form being saved or tested, in a sentence; null when nothing does. */
export function formProblem(form: DecisionForm, settings: DecisionSettings): string | null {
  const fields = choiceFields(form.choice);
  if (fields.endpoint && form.endpoint.trim() === '') return 'Enter the endpoint’s URL.';
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

/**
 * The body a save or a test sends for the form; null for the server default,
 * which is not saved but returned to (`DELETE`). A blank key is left out, so
 * the stored one is kept.
 */
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

/**
 * What Test sends for the form, or why it can't run. The server default is
 * tested as `default`, which the server runs with its own endpoint and key,
 * so it can be tested whatever the workspace has saved.
 */
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

/** "0.42 s" */
export function latencyText(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

/** A test's result in a sentence: the pick, confidence and latency, or why it failed. */
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
