import { describe, expect, it } from 'vitest';
import { roomTemplatesController } from './controller';

const parse = (yamlText: string, schema?: Record<string, unknown>) =>
  roomTemplatesController.parse({ yamlText, schema });

/** A permissive schema that accepts both `room:` and `params:`, standing in
 *  for a server that supports template params. */
const PARAMS_SCHEMA = {
  type: 'object',
  required: ['room'],
  properties: {
    room: { type: 'object' },
    params: { type: 'object' },
  },
  additionalProperties: false,
};

describe('roomTemplatesController.parse', () => {
  it('extracts params with types and defaults', () => {
    const result = parse(
      `
room:
  name: test-room
  agents:
    - bot-a
    - '{deploy_agent}'
params:
  label:
    type: string
    description: A label
    default: hello
  count:
    type: number
    default: 3
  enabled:
    type: boolean
    default: true
  env:
    type: enum
    enum: [dev, prod]
`,
      PARAMS_SCHEMA
    );
    expect(result.roomName).toBe('test-room');
    expect(result.agents).toEqual(['bot-a', '{deploy_agent}']);
    expect(result.params).toHaveLength(4);
    expect(result.params[0]).toMatchObject({
      name: 'label',
      type: 'string',
      default: 'hello',
    });
    expect(result.params[1]).toMatchObject({ name: 'count', type: 'number', default: 3 });
    expect(result.params[2]).toMatchObject({ name: 'enabled', type: 'boolean', default: true });
    expect(result.params[3]).toMatchObject({ name: 'env', type: 'enum', enum: ['dev', 'prod'] });
    expect(result.warnings).toEqual([]);
  });

  it('carries entity param types through instead of guessing from the name', () => {
    const result = parse(
      `
room:
  name: test
params:
  agent:
    type: string
  coder:
    type: agent
  where:
    type: bridge
  escalate_to:
    type: room
  owner:
    type: user
`,
      PARAMS_SCHEMA
    );
    const byName = Object.fromEntries(result.params.map((p) => [p.name, p.type]));
    expect(byName).toEqual({
      agent: 'string',
      coder: 'agent',
      where: 'bridge',
      escalate_to: 'room',
      owner: 'user',
    });
  });

  it('reads an unknown type as string and leaves the schema to reject it', () => {
    const result = parse('room:\n  name: test\nparams:\n  x:\n    type: widget\n');
    expect(result.params[0].type).toBe('string');
  });

  it('paramless template returns empty params', () => {
    const result = parse(`
room:
  name: simple-room
  description: No params
`);
    expect(result.params).toEqual([]);
    expect(result.roomName).toBe('simple-room');
  });

  it('passes through params without schema (server validates on create)', () => {
    const result = parse('room:\n  name: test\nparams:\n  x:\n    type: string\n');
    expect(result.params).toHaveLength(1);
  });

  it('throws on invalid YAML', () => {
    expect(() => parse('{{{')).toThrow(/Invalid YAML/);
  });

  it('rejects non-mapping YAML', () => {
    expect(() => parse('- a\n- b\n')).toThrow('Template must be a YAML mapping');
  });

  it('rejects template without room block', () => {
    expect(() => parse('something_else:\n  name: test\n')).toThrow(/must have a "room:" block/);
  });

  it('handles bare param names (no spec object)', () => {
    const result = parse(
      `
room:
  name: test
params:
  deploy_agent:
  label:
`,
      PARAMS_SCHEMA
    );
    expect(result.params[0]).toMatchObject({
      name: 'deploy_agent',
      type: 'string',
      default: null,
    });
    expect(result.params[1]).toMatchObject({
      name: 'label',
      type: 'string',
    });
  });

  it('validates YAML against a JSON Schema when provided', () => {
    const schema = {
      type: 'object',
      required: ['room'],
      properties: {
        room: {
          type: 'object',
          required: ['name', 'description'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    };
    // Valid template passes
    const result = parse('room:\n  name: test\n  description: hello\n', schema);
    expect(result.roomName).toBe('test');

    // Missing required field fails
    expect(() => parse('room:\n  name: test\n', schema)).toThrow(/description/);
  });

  it('skips fallback validation when schema is provided', () => {
    // With a permissive schema, params are allowed even though it would
    // fail the no-schema fallback check
    const result = parse('room:\n  name: test\nparams:\n  x:\n    type: string\n', PARAMS_SCHEMA);
    expect(result.params).toHaveLength(1);
  });
});

describe('roomTemplatesController.parse: kickoff and creator', () => {
  it('extracts kickoff, bridge, users, and the creator flag', () => {
    const result = roomTemplatesController.parse({
      yamlText: [
        'params:',
        '  coder:',
        '    type: string',
        'room:',
        '  name: "Work: {task}"',
        '  description: d',
        '  bridge: "Slack"',
        '  agents: ["{coder}", "helper"]',
        '  users: ["{$creator}", "bob"]',
        'kickoff: |',
        '  @{coder} start on the brief.',
      ].join('\n'),
    });
    expect(result.kickoff).toBe('@{coder} start on the brief.\n');
    expect(result.bridge).toBe('Slack');
    expect(result.users).toEqual(['{$creator}', 'bob']);
    expect(result.hardcodedUsers).toEqual(['bob']);
    expect(result.usesCreator).toBe(true);
  });

  it('warns about the stale room-level kickoff form and ignores it', () => {
    const result = roomTemplatesController.parse({
      yamlText: ['room:', '  name: n', '  description: d', '  kickoff: go'].join('\n'),
    });
    expect(result.kickoff).toBeNull();
    expect(result.warnings.some((w) => w.includes('kickoff'))).toBe(true);
  });

  it('defaults kickoff/bridge to null and usesCreator to false', () => {
    const result = roomTemplatesController.parse({
      yamlText: 'room:\n  name: n\n  description: d\n',
    });
    expect(result.kickoff).toBeNull();
    expect(result.bridge).toBeNull();
    expect(result.users).toEqual([]);
    expect(result.usesCreator).toBe(false);
  });

  it('treats an interpolated bridge name as unknown', () => {
    const result = roomTemplatesController.parse({
      yamlText: 'room:\n  name: n\n  description: d\n  bridge: "{which}"\n',
    });
    expect(result.bridge).toBeNull();
  });
});

describe('roomTemplatesController.parse: multiline params', () => {
  it('marks a string param declared multiline', () => {
    const result = roomTemplatesController.parse({
      yamlText: [
        'params:',
        '  brief:',
        '    type: string',
        '    multiline: true',
        '  task_name:',
        '    type: string',
        'room:',
        '  name: n',
        '  description: d',
      ].join('\n'),
    });
    const byName = Object.fromEntries(result.params.map((p) => [p.name, p]));
    expect(byName.brief.multiline).toBe(true);
    expect(byName.task_name.multiline).toBe(false);
  });

  it('ignores multiline on non-string params', () => {
    const result = roomTemplatesController.parse({
      yamlText: [
        'params:',
        '  flag:',
        '    type: boolean',
        '    multiline: true',
        'room:',
        '  name: n',
        '  description: d',
      ].join('\n'),
    });
    expect(result.params[0].multiline).toBe(false);
  });
});

describe('roomTemplatesController.params: prefill', () => {
  it('reads prefill on a param whose type has a list, and nowhere else', () => {
    const params = roomTemplatesController.params({
      yamlText: [
        'params:',
        '  bridge:',
        '    type: bridge',
        '    prefill: first',
        '  topic:',
        '    type: string',
        '    prefill: first',
        '  reviewer:',
        '    type: agent',
      ].join('\n'),
    });
    const byName = Object.fromEntries(params.map((p) => [p.name, p.prefill]));
    expect(byName).toEqual({ bridge: 'first', topic: null, reviewer: null });
  });
});
