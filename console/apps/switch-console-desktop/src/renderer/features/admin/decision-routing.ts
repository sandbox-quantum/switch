import type {
  DecisionBackend,
  DecisionBackendInfo,
  DecisionServiceChoice,
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

/** Each choice's name when the server's decision service doesn't describe
 * it (`choiceLabel` prefers the service's own label). */
export const CHOICE_LABELS = {
  server_default: 'Use server default',
  none: 'None',
  endpoint: 'Your own endpoint',
  haiku_anthropic: 'Claude Haiku with your Anthropic key',
  haiku_bedrock: 'Claude Haiku (Bedrock)',
  self_hosted: 'Self-hosted model',
  gemini: 'Gemini',
} as const satisfies Record<DecisionChoice, string>;

/** The order the choices that run in the server's decision service are offered in. */
const SERVICE_CHOICES = [
  'self_hosted',
  'gemini',
  'haiku_bedrock',
  'haiku_anthropic',
] as const satisfies readonly DecisionServiceChoice[];

function isServiceChoice(choice: DecisionChoice): choice is DecisionServiceChoice {
  return (SERVICE_CHOICES as readonly string[]).includes(choice);
}

/** How the server's decision service describes a choice, when it does. */
export function choiceInfo(
  choice: DecisionChoice,
  settings: DecisionSettings
): DecisionBackendInfo | null {
  if (choice === 'server_default') return settings.serverDefault.info;
  if (!isServiceChoice(choice)) return null;
  return settings.options.details[choice] ?? null;
}

/** "Claude Haiku (Bedrock)" → "Claude Haiku": a label without its trailing
 * parenthesis, for a sentence that names two models. */
function shortLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '') || label;
}

/** A described backend in a few words: its label, or with a fallback
 * "Gemini, with Claude Haiku if slow". */
function describedLabel(info: DecisionBackendInfo): string {
  if (info.fallback === null) return info.label;
  return `${shortLabel(info.label)}, with ${shortLabel(info.fallback.label)} if slow`;
}

/** "1.5 s" */
function secondsText(seconds: number): string {
  return `${Number(seconds.toFixed(2))} s`;
}

/** A choice's name in the form: the decision service's own label where it
 * gives one ("Server default: Qwen3 235B (Bedrock)"), else `CHOICE_LABELS`. */
export function choiceLabel(choice: DecisionChoice, settings: DecisionSettings): string {
  const info = choiceInfo(choice, settings);
  if (choice === 'server_default') {
    return info === null ? CHOICE_LABELS.server_default : `Server default: ${describedLabel(info)}`;
  }
  // Haiku with a workspace's key is named for the key, not the model's label.
  if (info === null || choice === 'haiku_anthropic') return CHOICE_LABELS[choice];
  return describedLabel(info);
}

const CHOICE_HINTS: Record<Exclude<DecisionChoice, 'server_default'>, string> = {
  none: 'Auto-route is off in this workspace’s rooms, whatever the server default.',
  endpoint: 'A decision service you run. Room messages are sent to it.',
  haiku_anthropic: 'Claude Haiku through the Anthropic API. Room messages are sent to Anthropic.',
  haiku_bedrock:
    'Claude Haiku through Amazon Bedrock, on this server’s AWS account. No key needed.',
  self_hosted:
    'A model this server’s decision service runs on its own hardware. Room messages stay with this server.',
  gemini:
    'Google’s Gemini, through this server’s decision service. Room messages are sent to Google.',
};

/** The line under a choice: what it is, what it falls back to, and the model
 * and threshold it uses by default, where the decision service says. */
export function choiceHint(choice: DecisionChoice, settings: DecisionSettings): string {
  const info = choiceInfo(choice, settings);
  const parts =
    choice === 'server_default'
      ? info === null
        ? [`Currently ${serverDefaultText(settings)}.`]
        : ['Whatever this server uses for every workspace that hasn’t chosen.']
      : [CHOICE_HINTS[choice]];
  if (info !== null) {
    if (info.fallback !== null) {
      parts.push(
        `Falls back to ${info.fallback.label} after ${secondsText(info.fallback.afterS)}.`
      );
    }
    parts.push(
      info.threshold === null
        ? `Model ${info.model}.`
        : `Model ${info.model}, threshold ${info.threshold} by default.`
    );
  }
  return parts.join(' ');
}

/** The threshold a choice applies when the workspace leaves it blank, where
 * the decision service says. */
export function defaultThreshold(
  choice: DecisionChoice,
  settings: DecisionSettings
): number | null {
  return choiceInfo(choice, settings)?.threshold ?? null;
}

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

function offered(choice: DecisionServiceChoice, settings: DecisionSettings): boolean {
  const { options } = settings;
  switch (choice) {
    case 'haiku_anthropic':
      return options.haikuAnthropic;
    case 'haiku_bedrock':
      return options.haikuBedrock;
    case 'self_hosted':
      return options.selfHosted;
    case 'gemini':
      return options.gemini;
  }
}

/**
 * The choices the form offers, in order. The ones that run inside the
 * server's decision service are offered as that service says (its list of
 * backends; for an older service, the server's configuration). A workspace
 * already saved on a choice the server no longer offers still sees it, so
 * the form shows what is stored.
 */
export function offeredChoices(settings: DecisionSettings): DecisionChoice[] {
  const saved = settings.workspace?.backend;
  return [
    'server_default',
    ...SERVICE_CHOICES.filter((choice) => offered(choice, settings) || saved === choice),
    'endpoint',
    'none',
  ];
}

/** Why choices are missing from the form, or null when there is nothing to say. */
export function choicesNote(settings: DecisionSettings): string | null {
  const { options } = settings;
  if (options.note !== null) return options.note;
  if (options.source === 'none') {
    return 'Models run by this server aren’t offered: they run inside its decision service, and this server has none configured. Its operator can add one.';
  }
  if (options.source === 'configuration' && !options.haikuBedrock) {
    return 'Claude Haiku on Bedrock isn’t offered: it uses this server’s own AWS credentials, so its operator has to turn it on.';
  }
  return null;
}

/** The server's default in words. */
export function serverDefaultText(settings: DecisionSettings): string {
  const { serverDefault } = settings;
  if (!serverDefault.configured) return 'none — this server has no decision service configured';
  if (serverDefault.info !== null) return describedLabel(serverDefault.info);
  return serverDefault.endpoint
    ? `this server’s decision service (${serverDefault.endpoint})`
    : 'this server’s decision service';
}

/** Which setting applies to the workspace's rooms, and what it comes to. */
export function appliesText(settings: DecisionSettings): string {
  if (settings.source === 'server_default') {
    return `This workspace uses the server default: ${serverDefaultText(settings)}.`;
  }
  const own = settings.workspace;
  const backend = own?.backend ?? settings.effective.backend;
  const where = backend === 'endpoint' && own?.endpoint ? ` (${own.endpoint})` : '';
  return `This workspace’s own setting applies: ${choiceLabel(backend, settings)}${where}. The server default is ${serverDefaultText(settings)}.`;
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
    threshold: choice === 'endpoint' || isServiceChoice(choice),
  };
}

/** The threshold as typed: null when blank, NaN when it isn't a number. */
function parsedThreshold(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return Number(trimmed);
}

/**
 * Whether the form moves the saved endpoint to another URL with its key left
 * blank. The server never sends the stored key to a URL other than the one it
 * was saved for, so the form asks for a key, or for the stored one to go.
 */
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

/** What stops the form being saved or tested, in a sentence; null when nothing does. */
export function formProblem(form: DecisionForm, settings: DecisionSettings): string | null {
  const fields = choiceFields(form.choice);
  if (fields.endpoint && form.endpoint.trim() === '') return 'Enter the endpoint’s URL.';
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
