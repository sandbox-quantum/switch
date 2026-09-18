import type { ParamSpec } from '@main/core/room-templates/controller';
import {
  FIRST,
  NEW,
  type ParamType,
  isConsoleParamType,
} from '@shared/core/switch-servers/room-template-params';
import type { SlotStatus, SlotStep } from './creates-rail';

export type Values = Record<string, string | number | boolean>;

/** Fill `{param}` and `{$builtin}` placeholders from `values`. A placeholder with no value yet is left as written. */
export function interpolate(template: string, values: Values): string {
  return template.replace(/\{(\$?\w+)\}/g, (match, key: string) => {
    const val = values[key];
    return val !== undefined && val !== '' ? String(val) : match;
  });
}

export function hasPlaceholder(text: string): boolean {
  return /\{\$?\w+\}/.test(text);
}

/** Every `{name}` placeholder written in `text`, without the braces. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\{(\$?\w+)\}/g)].map((m) => m[1]);
}

export function typeLabel(type: ParamType): string {
  switch (type) {
    case 'string':
      return 'text';
    case 'boolean':
      return 'yes / no';
    case 'enum':
      return 'one of';
    default:
      return type;
  }
}

/** The name of the input on the form: the template's `label`, else a
 * readable name for the common types, else the param key. */
export function paramLabel(param: ParamSpec): string {
  if (param.label) return param.label;
  switch (param.type) {
    case 'bridge':
      return 'Messaging app';
    case 'provider':
      return 'Provider';
    case 'location':
      return 'Runs on';
    case 'directory':
      return 'Directory';
    case 'room':
      return 'Room';
    default:
      return param.name;
  }
}

/** Whether the value may not be empty at Create. Read from the template. */
export function isRequired(param: ParamSpec): boolean {
  return param.required;
}

/** Whether the default is a chain of candidates rather than a value. */
export function isChain(param: ParamSpec): param is ParamSpec & { default: string[] } {
  return Array.isArray(param.default);
}

/** Each param's starting value: its default, `false` for a boolean without
 * one, empty for the rest. A chain starts empty and `resolveChain` fills it
 * once the candidates are known. */
export function defaultsFor(params: ParamSpec[]): Values {
  const defaults: Values = {};
  for (const param of params) {
    if (param.default !== null && !Array.isArray(param.default))
      defaults[param.name] = param.default;
    else if (param.type === 'boolean') defaults[param.name] = false;
    else defaults[param.name] = '';
  }
  return defaults;
}

export function isEmpty(value: string | number | boolean | undefined): boolean {
  return value === undefined || value === '';
}

export function missingParams(params: ParamSpec[], values: Values): ParamSpec[] {
  return params.filter((p) => isRequired(p) && isEmpty(values[p.name]));
}

/** What is wrong with a value, by the template's own rules, or null. */
export function valueProblem(param: ParamSpec, value: string | number | boolean): string | null {
  if (isEmpty(value)) return null;
  if (param.type === 'string' && param.pattern !== null) {
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${param.pattern})$`);
    } catch {
      return null;
    }
    if (!re.test(String(value))) return `Must match ${param.pattern}`;
  }
  if (param.type === 'number' && typeof value === 'number') {
    if (param.min !== null && value < param.min) return `Must be at least ${param.min}`;
    if (param.max !== null && value > param.max) return `Must be at most ${param.max}`;
  }
  return null;
}

/**
 * The inputs sent to the server: every filled param the server document
 * declares, with numbers converted. Params of a Console type are never sent,
 * nor those only an agent entry reads (`serverNames` says which are left).
 */
export function serverInputs(
  params: ParamSpec[],
  values: Values,
  serverNames: Set<string>
): Values {
  const inputs: Values = {};
  for (const param of params) {
    if (isConsoleParamType(param.type) || !serverNames.has(param.name)) continue;
    const val = values[param.name];
    if (isEmpty(val)) continue;
    inputs[param.name] = param.type === 'number' ? Number(val) : (val as string | boolean);
  }
  return inputs;
}

/** The messaging apps a room can be created on, the server's default first, then by name. */
export function bridgeCandidates(
  bridges: { displayName: string; status: string; isDefault: boolean }[]
): string[] {
  return bridges
    .filter((b) => b.status === 'active')
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) || a.displayName.localeCompare(b.displayName)
    )
    .map((b) => b.displayName);
}

/**
 * The value a chain resolves to: the first candidate the server or the
 * Console has, `$first` standing for the first of `candidates`, `$new` for
 * the template's own room when `hasNewRoom`. Null when nothing matches.
 */
export function resolveChain(
  param: ParamSpec,
  candidates: string[],
  hasNewRoom = false
): string | null {
  if (!isChain(param)) return null;
  for (const candidate of param.default) {
    if (candidate === FIRST) {
      if (candidates.length > 0) return candidates[0];
    } else if (candidate === NEW) {
      if (param.type === 'room' && hasNewRoom) return NEW;
    } else if (candidates.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Which section of the page a param belongs to: the agent it is written
 * into, or the room part. A `room` param always sits with the room, since
 * it says where the agent works; a param used by both sits with the agent. */
export function sectionOf(
  param: ParamSpec,
  agentTexts: string[][],
  roomText: string
): { section: 'agent'; index: number } | { section: 'room' } {
  if (param.type !== 'room') {
    const index = agentTexts.findIndex((texts) =>
      texts.some((t) => placeholdersIn(t).includes(param.name))
    );
    if (index >= 0) return { section: 'agent', index };
  }
  if (param.type === 'room' || placeholdersIn(roomText).includes(param.name))
    return { section: 'room' };
  return { section: 'agent', index: 0 };
}

export type CreateStepStatus = 'waiting' | 'running' | 'done' | 'failed';

/** One call the page makes while creating, as a row of the creating screen. */
export type CreateStep = {
  key: string;
  label: string;
  status: CreateStepStatus;
  /** A problem that did not stop the run, such as a repository that could not be cloned. */
  warning?: string | null;
};

export function createStepStatus(status: SlotStatus): CreateStepStatus {
  return status === 'created'
    ? 'done'
    : status === 'creating'
      ? 'running'
      : status === 'failed'
        ? 'failed'
        : 'waiting';
}

/**
 * The rows for one new agent: its directory, the agent, and who may address
 * it when the template sets that. Rows before the call in progress are done,
 * the one at it is running or failed, the ones after it wait.
 */
export function agentCreateSteps(
  index: number,
  agent: {
    name: string;
    status: SlotStatus;
    step: SlotStep | null;
    clones: boolean;
    setsPolicy: boolean;
    cloneWarning: string | null;
  }
): CreateStep[] {
  const order: SlotStep[] = agent.setsPolicy
    ? ['prepare', 'create', 'policy']
    : ['prepare', 'create'];
  const at = agent.step ? order.indexOf(agent.step) : -1;
  return order.map((step, k) => ({
    key: `${index}:${step}`,
    label:
      step === 'prepare'
        ? agent.clones
          ? `Prepare the directory of ${agent.name} and clone the repository`
          : `Prepare the directory of ${agent.name}`
        : step === 'create'
          ? `Create ${agent.name}`
          : `Set who can talk to ${agent.name}`,
    status:
      agent.status === 'created'
        ? 'done'
        : agent.status === 'idle' || k > at
          ? 'waiting'
          : k < at
            ? 'done'
            : createStepStatus(agent.status),
    warning: step === 'prepare' ? agent.cloneWarning : null,
  }));
}
