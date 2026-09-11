import Ajv from 'ajv';
import { dump, load } from 'js-yaml';
import { createRPCController } from '@shared/lib/ipc/rpc';

export type ParamSpec = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  description: string | null;
  default: string | number | boolean | null;
  enum: string[] | null;
  isAgentName: boolean;
  /** String params carrying long text render as a textarea (a one-line input
   * would strip pasted newlines). Declared in the template: `multiline: true`. */
  multiline: boolean;
};

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

/** Convention: trigger the agent picker when the param is named exactly "agent" or ends in "_agent". */
function isAgentParam(name: string): boolean {
  return name === 'agent' || name.endsWith('_agent');
}

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
        isAgentName: isAgentParam(name),
        multiline: false,
      };
    }
    const s = spec as Record<string, unknown>;
    const type = typeof s.type === 'string' ? s.type : 'string';
    const validType = (['string', 'number', 'boolean', 'enum'] as const).includes(
      type as 'string' | 'number' | 'boolean' | 'enum'
    )
      ? (type as ParamSpec['type'])
      : ('string' as const);
    return {
      name,
      type: validType,
      description: typeof s.description === 'string' ? s.description : null,
      default: s.default !== undefined ? (s.default as ParamSpec['default']) : null,
      enum: Array.isArray(s.enum) ? (s.enum as string[]) : null,
      isAgentName: validType === 'string' && isAgentParam(name),
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
    const kickoff = room && typeof room.kickoff === 'string' ? room.kickoff : null;
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
