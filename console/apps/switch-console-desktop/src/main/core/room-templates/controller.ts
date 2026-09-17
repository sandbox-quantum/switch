import Ajv from 'ajv';
import { dump, load } from 'js-yaml';
import type { KV } from '@main/db/kv';
import exampleTemplateYaml from '@root/../../../examples/room-templates/red-blue-workroom.template.yaml?raw';
import { PARAM_TYPES, type ParamType } from '@shared/core/switch-servers/room-template-params';
import { createRPCController } from '@shared/lib/ipc/rpc';

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

/** One room of a template, with the fields the Use page shows and edits. */
export type TemplateRoom = {
  name: string | null;
  description: string | null;
  agents: string[];
  users: string[];
  bridge: string | null;
  kickoff: string | null;
};

export type ParsedTemplate = {
  params: ParamSpec[];
  /** The rooms the document creates: one for `room:`, one per entry of `rooms:`. */
  rooms: TemplateRoom[];
  /** The group's name when the document is a group, else null. */
  groupName: string | null;
  roomName: string | null;
  /** The room's description as written in the template, for a listing card. */
  roomDescription: string | null;
  /** All agents from the template (both interpolated and hardcoded). */
  agents: string[];
  /** Hardcoded agents (no `{param}` interpolation), editable in the form. */
  hardcodedAgents: string[];
  /** Hardcoded users, editable in the form. */
  hardcodedUsers: string[];
  /** All users from the template, interpolated entries included. */
  users: string[];
  /** The bridge the template names, or null when unset or interpolated. */
  bridge: string | null;
  /** Message the server posts as the creating user after the room exists. */
  kickoff: string | null;
  /** Whether the template references the `{$creator}` builtin anywhere. */
  usesCreator: boolean;
  warnings: string[];
};

export function extractParams(raw: unknown): ParamSpec[] {
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

/**
 * Pick the part of the server's JSON schema that applies to this document.
 *
 * The schema can be a plain object schema or a `oneOf` with one branch per
 * document shape (room, group). Validating a room document against the
 * whole `oneOf` reports the group branch's errors too, which reads as
 * noise. Validating against the matching branch reports only the mistake.
 */
function schemaForDocument(
  schema: Record<string, unknown>,
  doc: Record<string, unknown>
): Record<string, unknown> {
  const branches = (schema.oneOf ?? schema.anyOf) as Array<{ $ref?: string }> | undefined;
  if (!Array.isArray(branches)) return schema;
  const isGroup = doc.group !== undefined || Array.isArray(doc.rooms);
  const branch = branches.find((b) =>
    isGroup ? /Group/.test(b.$ref ?? '') : !/Group/.test(b.$ref ?? '')
  );
  if (!branch?.$ref) return schema;
  const { oneOf: _one, anyOf: _any, ...rest } = schema;
  return { ...rest, $ref: branch.$ref };
}

// ── Recents ────────────────────────────────────────────────────────────────

/** A template document used from this Console, kept locally so it can be used again or saved to a workspace. */
export type RecentTemplate = {
  name: string;
  yamlText: string;
  usedAt: number;
};

type RecentsKV = Record<string, RecentTemplate[]>;

const MAX_RECENTS = 10;

// Imported inside the function rather than at the top of the module. The KV
// module imports Electron's `app`, which does not exist in the unit tests
// that call `parse`.
let _recentsKV: KV<RecentsKV> | null = null;
async function recentsKV(): Promise<KV<RecentsKV>> {
  if (!_recentsKV) {
    const { KV: Store } = await import('@main/db/kv');
    _recentsKV = new Store<RecentsKV>('template-recents');
  }
  return _recentsKV;
}

export const roomTemplatesController = createRPCController({
  /** Templates used from this Console on `serverId`, newest first. */
  getRecents: async (serverId: string): Promise<RecentTemplate[]> => {
    const kv = await recentsKV();
    return (await kv.get(serverId)) ?? [];
  },

  saveRecent: async (params: {
    serverId: string;
    name: string;
    yamlText: string;
  }): Promise<void> => {
    const kv = await recentsKV();
    const existing = (await kv.get(params.serverId)) ?? [];
    // Using the same document again moves its entry to the top instead of adding a duplicate.
    const rest = existing.filter((r) => r.yamlText !== params.yamlText);
    const entry: RecentTemplate = {
      name: params.name,
      yamlText: params.yamlText,
      usedAt: Date.now(),
    };
    await kv.set(params.serverId, [entry, ...rest].slice(0, MAX_RECENTS));
  },

  /** The example room template from `examples/`, shown when there is nothing else to start from. */
  getExampleTemplate: (): string => exampleTemplateYaml,

  /** Only the `params:` of a document. For agent-only documents, which have no room to parse. */
  params: (params: { yamlText: string }): ParamSpec[] =>
    extractParams(parseYaml(params.yamlText).params),

  parse: (params: { yamlText: string; schema?: Record<string, unknown> }): ParsedTemplate => {
    const warnings: string[] = [];
    const doc = parseYaml(params.yamlText);

    // Validate against server schema if provided
    if (params.schema) {
      const validate = ajv.compile(schemaForDocument(params.schema, doc));
      if (!validate(doc)) {
        const errors = (validate.errors ?? [])
          .map((err) => {
            const path = err.instancePath || '/';
            return `${path}: ${err.message}`;
          })
          .slice(0, 5);
        throw new Error(errors.join('\n'));
      }
    } else if (!doc.room && !Array.isArray(doc.rooms)) {
      throw new Error('Template must have a "room:" block, or "group:" with "rooms:".');
    }

    const isGroup = doc.group !== undefined || Array.isArray(doc.rooms);
    const rawRooms: Record<string, unknown>[] = isGroup
      ? (Array.isArray(doc.rooms) ? doc.rooms : []).filter(
          (r): r is Record<string, unknown> => r !== null && typeof r === 'object'
        )
      : doc.room && typeof doc.room === 'object'
        ? [doc.room as Record<string, unknown>]
        : [];
    const rooms: TemplateRoom[] = rawRooms.map((room) => ({
      name: typeof room.name === 'string' ? room.name : null,
      description: typeof room.description === 'string' ? room.description.trim() : null,
      agents: extractStringList(room.agents),
      users: extractStringList(room.users),
      bridge:
        typeof room.bridge === 'string' && !hasInterpolation(room.bridge) ? room.bridge : null,
      kickoff: typeof room.kickoff === 'string' ? room.kickoff : null,
    }));
    const first = rooms[0] ?? null;
    const allAgents = [...new Set(rooms.flatMap((r) => r.agents))];
    const allUsers = [...new Set(rooms.flatMap((r) => r.users))];
    const paramSpecs = extractParams(doc.params);
    const kickoff = typeof doc.kickoff === 'string' ? doc.kickoff : null;
    if (!isGroup && first?.kickoff) {
      warnings.push(
        '`kickoff:` belongs at the top level, beside `room:`. Inside `room:` the server ignores it.'
      );
    }
    if (isGroup && kickoff) {
      warnings.push(
        "A group's `kickoff:` goes inside the room it is for; at the top level the server refuses it."
      );
    }
    if (rooms.length === 0) {
      warnings.push('Template has no "room:" block, so the server may reject it.');
    }
    const group = doc.group as Record<string, unknown> | undefined;

    return {
      params: paramSpecs,
      rooms,
      groupName: group && typeof group.name === 'string' ? group.name : null,
      roomName: first?.name ?? null,
      roomDescription: first?.description ?? null,
      agents: allAgents,
      hardcodedAgents: allAgents.filter((a) => !hasInterpolation(a)),
      hardcodedUsers: allUsers.filter((u) => !hasInterpolation(u)),
      users: allUsers,
      bridge: first?.bridge ?? null,
      kickoff,
      usesCreator: usesCreator(params.yamlText),
      warnings,
    };
  },

  /** Rewrite the template YAML, replacing room.agents and room.users with edited lists. */
  rewriteYaml: (params: { yamlText: string; agents: string[]; users: string[] }): string => {
    const doc = parseYaml(params.yamlText);
    const room = doc.room as Record<string, unknown> | undefined;
    // The form does not edit the member lists of a group's rooms, so a group
    // document is returned unchanged.
    if (!room || Array.isArray(doc.rooms)) return params.yamlText;
    room.agents = params.agents;
    if (params.users.length > 0) {
      room.users = params.users;
    } else {
      delete room.users;
    }
    return dump(doc, { lineWidth: -1 });
  },
});
