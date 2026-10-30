import type {
  DecisionBackend,
  DecisionEffectiveMachine,
  DecisionMachineOption,
  DecisionOfferedModel,
  DecisionSettings,
  DecisionSettingsInput,
  DecisionTestInput,
  DecisionTestOutcome,
} from '@shared/core/switch-servers/switch-servers';

/** How often the chosen machine's state is asked again while it gets its model ready. */
export const MACHINE_POLL_MS = 3_000;

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
  /** The machine picked for `machine`; blank before one is. */
  machineId: string;
  /** The model picked from that machine's offer; blank before one is. */
  model: string;
};

export const CHOICE_LABELS = {
  server_default: 'Use server default',
  none: 'None',
  endpoint: 'Self-hosted endpoint',
  haiku_anthropic: 'Haiku (Anthropic API)',
  haiku_bedrock: 'Haiku on Bedrock',
  machine: 'Run on one of my machines',
} as const satisfies Record<DecisionChoice, string>;

export function formFor(settings: DecisionSettings): DecisionForm {
  const own = settings.workspace;
  return {
    choice: own?.backend ?? 'server_default',
    endpoint: own?.endpoint ?? '',
    apiKey: '',
    clearApiKey: false,
    threshold: own?.threshold === null || own?.threshold === undefined ? '' : String(own.threshold),
    machineId: own?.machineId ?? '',
    model: own?.model ?? '',
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
    ...(settings.options.machines !== null || saved === 'machine' ? (['machine'] as const) : []),
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
  const where =
    backend === 'endpoint' && own?.endpoint
      ? ` (${own.endpoint})`
      : backend === 'machine'
        ? machineWhere(settings)
        : '';
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
  if (form.choice === 'machine') return machineProblem(form, settings);
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
  if (form.choice === 'machine') {
    return { backend: 'machine', machineId: form.machineId, model: form.model };
  }
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

/** " (Mac-Studio, Qwen3.5-4B)": the chosen machine and model, for the sentence saying what applies. */
function machineWhere(settings: DecisionSettings): string {
  const machine = settings.effective.machine;
  const machineId = machine?.id ?? settings.workspace?.machineId ?? null;
  const option = machineOption(settings, machineId);
  const name = machine?.name ?? option?.name ?? null;
  const model = machine?.model ?? settings.workspace?.model ?? null;
  const parts = [name, model === null ? null : modelLabel(model, option)].filter(
    (part): part is string => part !== null
  );
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** One of the admin's machines in the picker, by id. */
export function machineOption(
  settings: DecisionSettings,
  machineId: string | null
): DecisionMachineOption | null {
  if (machineId === null || machineId === '') return null;
  return settings.options.machines?.find((machine) => machine.id === machineId) ?? null;
}

/** A model's name for people, from the machine's offer; the catalogue id when it isn't offered. */
export function modelLabel(model: string, option: DecisionMachineOption | null): string {
  return option?.decision.offered.find((offer) => offer.model === model)?.label ?? model;
}

/** "Apple Silicon", for the line under a machine in the picker. */
const ACCELERATORS: Record<string, string> = {
  apple_silicon: 'Apple Silicon',
  nvidia: 'NVIDIA GPU',
  cpu: 'CPU only',
};

/**
 * What the picker says under a machine: why it can't be chosen, or its
 * hardware, and whether it's connected now. A machine that isn't connected
 * can still be chosen: it starts on the model when it next connects.
 */
export function machineOptionNote(machine: DecisionMachineOption): string {
  const parts: string[] = [];
  if (!machine.decision.supported) {
    parts.push(machine.decision.reason ?? 'It can’t run the decision model');
  } else {
    const hardware = machine.decision.hardware;
    if (hardware) {
      const name = hardware.gpuName ?? ACCELERATORS[hardware.accelerator] ?? hardware.accelerator;
      parts.push(
        hardware.memoryBytes ? `${name}, ${gigabytes(hardware.memoryBytes)} GB memory` : name
      );
    }
  }
  if (!machine.connected) parts.push('Not connected now');
  return parts.join(' · ');
}

/** "Qwen3.5-4B · fast · 2.7 GB download": a model in the select. */
export function offeredModelText(offer: DecisionOfferedModel): string {
  const parts = [offer.label, offer.speed === 'fast' ? 'fast' : 'slow on this machine'];
  if (offer.downloadBytes > 0) parts.push(`${gigabytes(offer.downloadBytes)} GB download`);
  return parts.join(' · ');
}

/** What stops a machine choice being saved or tested. */
function machineProblem(form: DecisionForm, settings: DecisionSettings): string | null {
  if (form.machineId === '') return 'Choose one of your machines.';
  const option = machineOption(settings, form.machineId);
  if (option === null) return 'That machine isn’t one of yours in this workspace any more.';
  if (!option.decision.supported) {
    return option.decision.reason ?? 'That machine can’t run the decision model.';
  }
  if (form.model === '') return 'Choose a model.';
  if (!option.decision.offered.some((offer) => offer.model === form.model)) {
    return 'That machine doesn’t offer this model. Choose one it offers.';
  }
  return null;
}

/**
 * The form after choosing a machine: its first fast model (else its first)
 * when the model picked isn't one it offers.
 */
export function withMachine(form: DecisionForm, option: DecisionMachineOption): DecisionForm {
  const offered = option.decision.offered;
  const keeps = offered.some((offer) => offer.model === form.model);
  const model = keeps
    ? form.model
    : ((offered.find((offer) => offer.speed === 'fast') ?? offered[0])?.model ?? '');
  return { ...form, machineId: option.id, model };
}

/** "2.7", in decimal gigabytes as disks and downloads are sold. */
function gigabytes(bytes: number): string {
  return (bytes / 1_000_000_000).toFixed(1);
}

/** The machine's reasons for not running the model, as the end of "Failed: …". */
const FAILURE_REASONS: Record<string, string> = {
  not_enough_disk: 'not enough disk space',
  download_failed: 'the model could not be downloaded',
  checksum_mismatch: 'the downloaded model didn’t match its checksum, so it was discarded',
  model_server_crashed: 'the model server kept crashing',
  out_of_memory: 'not enough memory to run the model',
  unsupported_hardware: 'this machine can’t run the model',
  turned_off_on_machine: 'turned off on the machine',
};

export type MachineStateTone = 'ok' | 'busy' | 'problem' | 'idle';

export type MachineStateLine = { text: string; tone: MachineStateTone };

/** "14:05", or "28 Oct 14:05" when it was not today. */
export function clockText(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * Where the chosen machine's decision model stands, in a line: getting
 * ready, downloading with its progress, starting, running with the model
 * and the last decision's time, offline since when, turned off on the
 * machine, or failed and why.
 */
export function machineStateLine(
  machine: DecisionEffectiveMachine,
  option: DecisionMachineOption | null,
  now: Date = new Date()
): MachineStateLine {
  const connected = machine.connected ?? option?.connected ?? true;
  if (!connected) {
    return {
      text: machine.since ? `Offline since ${clockText(machine.since, now)}` : 'Offline',
      tone: 'problem',
    };
  }
  const label = modelLabel(machine.model, option);
  switch (machine.state) {
    case 'downloading': {
      const progress = machine.progress;
      return {
        text:
          progress && progress.totalBytes > 0
            ? `Downloading ${gigabytes(progress.doneBytes)} / ${gigabytes(progress.totalBytes)} GB`
            : 'Downloading',
        tone: 'busy',
      };
    }
    case 'starting':
      return { text: 'Starting', tone: 'busy' };
    case 'running':
      return {
        text:
          machine.lastDecisionMs !== null
            ? `Running · ${label} · last decision ${latencyText(machine.lastDecisionMs)}`
            : `Running · ${label}`,
        tone: 'ok',
      };
    case 'failed':
      return { text: `Failed: ${failureReasonText(machine, option)}`, tone: 'problem' };
    case 'off':
      if (machine.reason === 'turned_off_on_machine') {
        return { text: 'Turned off on the machine', tone: 'idle' };
      }
      return { text: 'Getting ready', tone: 'busy' };
  }
  return { text: 'Getting ready', tone: 'busy' };
}

/** Why the model failed, in words; a reason the machine names that Console doesn't know is shown as it came. */
function failureReasonText(
  machine: DecisionEffectiveMachine,
  option: DecisionMachineOption | null
): string {
  const reason = machine.reason;
  if (reason === null) return 'the machine didn’t say why';
  const words = FAILURE_REASONS[reason];
  if (words === undefined) return reason.replace(/_/g, ' ');
  if (reason === 'not_enough_disk') {
    const needed =
      machine.progress?.totalBytes ||
      option?.decision.offered.find((offer) => offer.model === machine.model)?.downloadBytes ||
      0;
    return needed > 0 ? `${words} (the model needs ${gigabytes(needed)} GB)` : words;
  }
  return words;
}

/**
 * Whether the section should keep asking the server how the machine is
 * getting on: until it runs or fails, and while it is offline.
 */
export function machineSettling(settings: DecisionSettings): boolean {
  if (settings.effective.backend !== 'machine') return false;
  const machine = settings.effective.machine;
  if (machine === null) return false;
  if (machine.connected === false) return true;
  return machine.state !== 'running' && machine.state !== 'failed';
}
