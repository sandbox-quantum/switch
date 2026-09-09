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

export const roomTemplatesController = createRPCController({
  parse: (params: { yamlText: string }): ParsedTemplate => {
    const warnings: string[] = [];
    let doc: Record<string, unknown>;
    try {
      const parsed = load(params.yamlText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Template must be a YAML mapping');
      }
      doc = parsed as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
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
