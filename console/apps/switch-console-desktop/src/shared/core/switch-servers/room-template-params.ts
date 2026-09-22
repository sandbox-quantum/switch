/**
 * The param types a room template can declare, shared by the main-process
 * parser and the renderer's form. Mirrors `ParamType` in core's `rooms_yaml`.
 */

/** Param types whose value names something that exists on the server. The
 * form offers a picker over the matching list, and the server checks the
 * value before provisioning. Mirrors `ENTITY_PARAM_TYPES` in core. */
export const ENTITY_PARAM_TYPES = ['agent', 'bridge', 'room', 'user'] as const;
export type EntityParamType = (typeof ENTITY_PARAM_TYPES)[number];

/** Param types the Console answers itself and leaves out of the request to
 * the server. `provider` is the coding agent that runs an agent the template
 * creates, `location` the machine it runs on, `directory` its working
 * directory. Mirrors `CONSOLE_PARAM_TYPES` in core. */
export const CONSOLE_PARAM_TYPES = ['provider', 'location', 'directory'] as const;
export type ConsoleParamType = (typeof CONSOLE_PARAM_TYPES)[number];

export type ParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | EntityParamType
  | ConsoleParamType;

export const PARAM_TYPES: readonly ParamType[] = [
  'string',
  'number',
  'boolean',
  'enum',
  ...ENTITY_PARAM_TYPES,
  ...CONSOLE_PARAM_TYPES,
];

export function isConsoleParamType(type: ParamType): type is ConsoleParamType {
  return (CONSOLE_PARAM_TYPES as readonly string[]).includes(type);
}

export function isEntityParamType(type: ParamType): type is EntityParamType {
  return (ENTITY_PARAM_TYPES as readonly string[]).includes(type);
}

/** Param types whose `default` may be a list of candidates tried in order.
 * Mirrors `CHAIN_PARAM_TYPES` in core. A `user` param has no first:
 * `{$creator}` already names the deployer. */
export const CHAIN_PARAM_TYPES: readonly ParamType[] = [
  'agent',
  'bridge',
  'room',
  'provider',
  'location',
];

/** In a chain: the first thing of the param's type the server or the Console has. */
export const FIRST = '$first';
/** In a `room` param's chain: the room the template's own `room:` block describes. */
export const NEW = '$new';

/** How a form presents a param. `ask` is a visible input; `advanced` is
 * prefilled and folded away; `fixed` is shown but not editable. Mirrors
 * `ParamInput` in core. */
export type ParamInput = 'ask' | 'advanced' | 'fixed';
export const PARAM_INPUTS: readonly ParamInput[] = ['ask', 'advanced', 'fixed'];
