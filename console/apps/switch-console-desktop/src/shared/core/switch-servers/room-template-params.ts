/**
 * The param types a room template can declare, shared by the main-process
 * parser and the renderer's form. Mirrors `ParamType` in core's `rooms_yaml`.
 */

/** Param types whose value names something that exists on the server. The
 * form offers a picker over the matching list, and the server checks the
 * value before provisioning. Mirrors `ENTITY_PARAM_TYPES` in core. */
export const ENTITY_PARAM_TYPES = ['agent', 'bridge', 'room', 'user'] as const;
export type EntityParamType = (typeof ENTITY_PARAM_TYPES)[number];

export type ParamType = 'string' | 'number' | 'boolean' | 'enum' | EntityParamType;

export const PARAM_TYPES: readonly ParamType[] = [
  'string',
  'number',
  'boolean',
  'enum',
  ...ENTITY_PARAM_TYPES,
];

export function isEntityParamType(type: ParamType): type is EntityParamType {
  return (ENTITY_PARAM_TYPES as readonly string[]).includes(type);
}
