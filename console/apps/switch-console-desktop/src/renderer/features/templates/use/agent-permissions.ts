import { holds, type Values } from './use-template-model';

/**
 * What a template gives a new agent that decides what anyone can make it do:
 * whether it runs every tool without asking, and who may talk to it. Worked
 * out from the fields as written (`permissionsAsWritten`), the way the server
 * works them out, so the Use page can show them before anything is created.
 * Anyone in a workspace can write a template, so these are never left out of
 * what the page shows.
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
