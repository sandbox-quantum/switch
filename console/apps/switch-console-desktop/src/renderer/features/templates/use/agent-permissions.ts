import type { AgentTemplateAddressing } from '@main/core/agent-templates/agent-template-format';
import type { ParsedAgentEntry } from '@main/core/agent-templates/template-document';
import { newAgentPermissions } from '@shared/core/agents/agents';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { holds, type Values } from './use-template-model';

/**
 * What a template gives a new agent that decides what anyone can make it do:
 * whether it runs every tool without asking, and who may talk to it. Worked
 * out the way the run that creates the agent reads the template
 * (`permissionsOnCreate`), so the Use page can show them before anything is
 * created. Anyone in a workspace can write a template, so these are never
 * left out of what the page shows.
 */

/** Who may talk to a new agent once it exists. */
export type AgentReach =
  | { kind: 'owner' }
  | { kind: 'owner-agents' }
  | { kind: 'anyone' }
  /** A version 2 `addressing: {anyone_in: [...]}`: the people in those rooms, by key. */
  | { kind: 'rooms'; rooms: string[] }
  /** Written in a form Switch Console cannot read, so it cannot say who. */
  | { kind: 'unknown' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A version 2 field written as `[{if, value}, ...]`: the first value whose
 * condition holds (a case with no `if` always does), or undefined when none
 * does, as the server chooses it. Any other value as it is.
 */
export function chooseCase(node: unknown, values: Values): unknown {
  if (
    Array.isArray(node) &&
    node.length > 0 &&
    node.every((item) => isRecord(item) && 'value' in item)
  ) {
    for (const item of node as Record<string, unknown>[]) {
      if (!('if' in item) || (typeof item.if === 'string' && holds(item.if, values)))
        return chooseCase(item.value, values);
    }
    return undefined;
  }
  return node;
}

/** A value written as a whole `{param}`, replaced by the param's value. */
function filled(node: unknown, values: Values): unknown {
  if (typeof node !== 'string') return node;
  const whole = /^\s*\{(\$?\w+)\}\s*$/.exec(node);
  return whole ? values[whole[1]!] : node;
}

/**
 * Whether the agent runs every tool without asking (`auto_approve`). Null when
 * the template says it in a form Switch Console cannot read, which is shown
 * and confirmed as if it did.
 */
export function runsWithoutAsking(written: unknown, values: Values): boolean | null {
  const value = filled(chooseCase(written, values), values);
  if (value === undefined || value === null || value === false || value === '') return false;
  if (value === true) return true;
  return null;
}

/** Who may talk to the agent (`addressing`); without one, its owner and the owner's agents. */
export function whoCanAddress(written: unknown, values: Values): AgentReach {
  const value = filled(chooseCase(written, values), values);
  if (value === undefined || value === null || value === '') return { kind: 'owner-agents' };
  if (value === 'owner' || value === 'owner-agents' || value === 'anyone') return { kind: value };
  if (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.anyone_in) &&
    value.anyone_in.every((room) => typeof room === 'string')
  )
    return { kind: 'rooms', rooms: value.anyone_in as string[] };
  return { kind: 'unknown' };
}

/**
 * `auto_approve` as Switch Console sends it for a new managed agent of a
 * version 1 template: `true`, or a `{param}` whose input is true. Anything
 * else is false, a list of cases included: version 1 has none.
 */
export function consoleAutoApprove(
  entry: Pick<ParsedAgentEntry, 'autoApprove'>,
  values: Values
): boolean {
  return typeof entry.autoApprove === 'string'
    ? values[entry.autoApprove.replace(/^\{|\}$/g, '')] === true
    : entry.autoApprove === true;
}

/**
 * `addressing` as Switch Console gives a new agent of a version 1 template:
 * one of the plain values, or else the default, its owner and the owner's
 * agents. A list of cases or a `{param}` is not read.
 */
export function consoleAddressing(
  entry: Pick<ParsedAgentEntry, 'addressing'>
): AgentTemplateAddressing {
  return entry.addressing ?? 'owner-agents';
}

/**
 * Who creates a template run's agents, which decides how their permissions
 * are read: the server for a version 2 document (`document`); Switch Console
 * for a version 1 template, as managed agents on a server with agent
 * management (`managed`) or as agents it runs itself (`console`).
 */
export type TemplateRun = 'document' | 'managed' | 'console';

/**
 * What a new agent will be given, read the way the run that creates it reads
 * the template, so what the Use page shows and asks about before Create is
 * what gets created. `provider` is the one the deployer picked for the slot,
 * null while none is: an agent this Console runs takes its permissions from
 * its provider, not from the template.
 */
export function permissionsOnCreate(
  entry: Pick<ParsedAgentEntry, 'autoApprove' | 'addressing' | 'permissionsAsWritten'>,
  values: Values,
  run: TemplateRun,
  provider: AgentProviderId | null
): { bypass: boolean | null; reach: AgentReach } {
  if (run === 'document')
    return {
      bypass: runsWithoutAsking(entry.permissionsAsWritten.autoApprove, values),
      reach: whoCanAddress(entry.permissionsAsWritten.addressing, values),
    };
  return {
    bypass:
      run === 'managed'
        ? consoleAutoApprove(entry, values)
        : consoleRunPermissions(provider).autoApprove,
    reach: { kind: consoleAddressing(entry) },
  };
}

/**
 * The permissions an agent this Console runs for a version 1 template is
 * created with, whatever the template says: its provider's automatic review,
 * or bypass for a provider without one (Cursor).
 */
export function consoleRunPermissions(provider: AgentProviderId | null): {
  autoApprove: boolean;
  autoMode: boolean;
} {
  return provider === null ? { autoApprove: false, autoMode: true } : newAgentPermissions(provider);
}
