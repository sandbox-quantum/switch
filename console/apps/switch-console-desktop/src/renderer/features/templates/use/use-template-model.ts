import type { ParamSpec } from '@main/core/room-templates/controller';
import type { ParamType } from '@shared/core/switch-servers/room-template-params';
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

/** A param is required when the template gives it no default. A bridge param
 * is the exception: left empty, the room uses the server's default messaging app. */
export function isRequired(param: ParamSpec): boolean {
  return param.default === null && param.type !== 'bridge';
}

/** Each param's default; without one, `false` for a boolean and empty for the rest. */
export function defaultsFor(params: ParamSpec[]): Values {
  const defaults: Values = {};
  for (const param of params) {
    if (param.default !== null) defaults[param.name] = param.default;
    else if (param.type === 'boolean') defaults[param.name] = false;
    else defaults[param.name] = '';
  }
  return defaults;
}

export function isEmpty(value: string | number | boolean | undefined): boolean {
  return value === undefined || value === '';
}

/** Bridge params left empty with no default. The server document is sent without them. */
export function unsetBridgeParams(params: ParamSpec[], values: Values): string[] {
  return params
    .filter((p) => p.type === 'bridge' && p.default === null && isEmpty(values[p.name]))
    .map((p) => p.name);
}

export function missingParams(params: ParamSpec[], values: Values): ParamSpec[] {
  return params.filter((p) => isRequired(p) && isEmpty(values[p.name]));
}

/** The inputs sent to the server: every filled param of a type the server knows, with numbers converted. */
export function serverInputs(params: ParamSpec[], values: Values): Values {
  const inputs: Values = {};
  for (const param of params) {
    if (param.type === 'provider') continue;
    if (param.type === 'bridge' && isEmpty(values[param.name]) && param.default === null) continue;
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
 * The value the form selects for a param before the deployer touches it, or
 * null to leave it empty. A param with `prefill: first` gets the first
 * candidate. A messaging app is also selected when it is the only one,
 * since there is nothing to choose; an agent, room or user never is,
 * because selecting one silently could add a member nobody asked for.
 */
export function prefillChoice(param: ParamSpec, candidates: string[]): string | null {
  if (param.default !== null || candidates.length === 0) return null;
  const wanted = param.prefill === 'first' || (param.type === 'bridge' && candidates.length === 1);
  return wanted ? candidates[0] : null;
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
