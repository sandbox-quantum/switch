import Ajv from 'ajv';
import { dump, load } from 'js-yaml';
import { createRPCController } from '@shared/lib/ipc/rpc';

/** Param types whose value names something that exists on the server. The
 * form offers a picker over the matching list, and the server checks the
 * value before provisioning. Mirrors `ENTITY_PARAM_TYPES` in core. */
export const ENTITY_PARAM_TYPES = ['agent', 'bridge', 'room', 'user'] as const;
export type EntityParamType = (typeof ENTITY_PARAM_TYPES)[number];

export type ParamType = 'string' | 'number' | 'boolean' | 'enum' | EntityParamType;

const PARAM_TYPES: readonly ParamType[] = [
  'string',
  'number',
  'boolean',
  'enum',
  ...ENTITY_PARAM_TYPES,
];

export type ParamSpec = {
  name: string;
  type: ParamType;
  description: string | null;
  default: string | number | boolean | null;
  enum: string[] | null;
  /** String params carrying long text render as a textarea (a one-line input
   * would strip pasted newlines). Declared in the template: `multiline: true`. */
  multiline: boolean;
};

export function isEntityParamType(type: ParamType): type is EntityParamType {
  return (ENTITY_PARAM_TYPES as readonly string[]).includes(type);
}

export type ParsedTemplate = {
  params: ParamSpec[];
  roomName: string | null;
  /** All agents from the template (both interpolated and hardcoded). */
  agents: string[];
  /** Hardcoded agents (no `{param}` interpolation) — editable in the form. */
  hardcodedAgents: string[];
  /** Hardcoded users — editable in the form. */
  hardcodedUsers: string[];
  /** All users from the template, interpolated entries included. */
  users: string[];
  /** The bridge the template names — null when unset or interpolated. */
  bridge: string | null;
  /** Message the server posts as the creating user after the room exists. */
  kickoff: string | null;
  /** Whether the template references the `{$creator}` builtin anywhere. */
  usesCreator: boolean;
  warnings: string[];
};

function extractParams(raw: unknown): ParamSpec[] {
  if (raw === null || raw === undefined || typeof raw !== 'object') return [];
  const params = raw as Record<string, unknown>;
  return Object.entries(params).map(([name, spec]) => {
    if (spec === null || typeof spec !== 'object') {
      return {
        name,
        type: 'string' as const,
        description: null,
        default: null,
        enum: null,
        multiline: false,
      };
    }
    const s = spec as Record<string, unknown>;
    const type = typeof s.type === 'string' ? s.type : 'string';
    // An unknown type is read as a string so the form still renders; the
    // server's schema is what rejects it, with a message naming the type.
    const validType = PARAM_TYPES.includes(type as ParamType) ? (type as ParamType) : 'string';
    return {
      name,
      type: validType,
      description: typeof s.description === 'string' ? s.description : null,
      default: s.default !== undefined ? (s.default as ParamSpec['default']) : null,
      enum: Array.isArray(s.enum) ? (s.enum as string[]) : null,
      multiline: validType === 'string' && s.multiline === true,
    };
  });
}

function parseYaml(yamlText: string): Record<string, unknown> {
  let doc: Record<string, unknown>;
  try {
    const parsed = load(yamlText);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Template must be a YAML mapping');
    }
    doc = parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  return doc;
}

const hasInterpolation = (s: string) => /\{[^}]+\}/.test(s);

const usesCreator = (s: string) => /\{\$creator(_email)?\}/.test(s);

function extractStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is string => typeof a === 'string');
}

const ajv = new Ajv({ allErrors: true, strict: false });

export const roomTemplatesController = createRPCController({
  parse: (params: { yamlText: string; schema?: Record<string, unknown> }): ParsedTemplate => {
    const warnings: string[] = [];
    const doc = parseYaml(params.yamlText);

    // Validate against server schema if provided
    if (params.schema) {
      const validate = ajv.compile(params.schema);
      if (!validate(doc)) {
        const errors = (validate.errors ?? [])
          .map((err) => {
            const path = err.instancePath || '/';
            return `${path}: ${err.message}`;
          })
          .slice(0, 5);
        throw new Error(errors.join('\n'));
      }
    } else if (!doc.room) {
      throw new Error('Template must have a "room:" block.');
    }

    const room = doc.room as Record<string, unknown> | undefined;
    const roomName = room && typeof room.name === 'string' ? room.name : null;
    const allAgents = extractStringList(room?.agents);
    const allUsers = extractStringList(room?.users);
    const paramSpecs = extractParams(doc.params);
    const kickoff = typeof doc.kickoff === 'string' ? doc.kickoff : null;
    if (room && typeof room.kickoff === 'string') {
      warnings.push(
        '`kickoff:` belongs at the top level, beside `room:` — inside `room:` the server ignores it.'
      );
    }
    const bridge =
      room && typeof room.bridge === 'string' && !hasInterpolation(room.bridge)
        ? room.bridge
        : null;

    if (!room) {
      warnings.push('Template has no "room:" block — the server may reject it.');
    }

    return {
      params: paramSpecs,
      roomName,
      agents: allAgents,
      hardcodedAgents: allAgents.filter((a) => !hasInterpolation(a)),
      hardcodedUsers: allUsers.filter((u) => !hasInterpolation(u)),
      users: allUsers,
      bridge,
      kickoff,
      usesCreator: usesCreator(params.yamlText),
      warnings,
    };
  },

  /** Rewrite the template YAML, replacing room.agents and room.users with edited lists. */
  rewriteYaml: (params: { yamlText: string; agents: string[]; users: string[] }): string => {
    const doc = parseYaml(params.yamlText);
    const room = doc.room as Record<string, unknown> | undefined;
    if (!room) return params.yamlText;
    room.agents = params.agents;
    if (params.users.length > 0) {
      room.users = params.users;
    } else {
      delete room.users;
    }
    return dump(doc, { lineWidth: -1 });
  },
});
