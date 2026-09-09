import Ajv from 'ajv';
import { load } from 'js-yaml';
import { createRPCController } from '@shared/lib/ipc/rpc';

export type ParamSpec = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  description: string | null;
  default: string | number | boolean | null;
  enum: string[] | null;
  isAgentName: boolean;
};

export type ParsedTemplate = {
  params: ParamSpec[];
  roomName: string | null;
  agents: string[];
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
    } else {
      // No schema available (server too old or unreachable) — basic structural check
      const knownKeys = new Set(['room']);
      const unknownKeys = Object.keys(doc).filter((k) => !knownKeys.has(k));
      if (unknownKeys.length > 0) {
        throw new Error(
          `This server does not support template features: ${unknownKeys.join(', ')}. ` +
            'Only a plain "room:" block is accepted.'
        );
      }
      if (!doc.room) {
        throw new Error('Template must have a "room:" block.');
      }
    }

    const room = doc.room as Record<string, unknown> | undefined;
    const roomName = room && typeof room.name === 'string' ? room.name : null;
    const agents =
      room && Array.isArray(room.agents)
        ? (room.agents as unknown[]).filter((a): a is string => typeof a === 'string')
        : [];
    const paramSpecs = extractParams(doc.params);

    if (!room) {
      warnings.push('Template has no "room:" block — the server may reject it.');
    }

    return { params: paramSpecs, roomName, agents, warnings };
  },
});
