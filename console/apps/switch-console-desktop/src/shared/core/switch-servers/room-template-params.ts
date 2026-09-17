/**
 * The param types a room template can declare, shared by the main-process
 * parser and the renderer's form. Mirrors `ParamType` in core's `rooms_yaml`.
 */

/** Param types whose value names something that exists on the server. The
 * form offers a picker over the matching list, and the server checks the
 * value before provisioning. Mirrors `ENTITY_PARAM_TYPES` in core. */
export const ENTITY_PARAM_TYPES = ['agent', 'bridge', 'room', 'user'] as const;
export type EntityParamType = (typeof ENTITY_PARAM_TYPES)[number];

/** Param types the Console answers itself and leaves out of the request to the server.
 * `provider` chooses the coding agent that runs the agents a template creates. */
export const CONSOLE_PARAM_TYPES = ['provider'] as const;
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
