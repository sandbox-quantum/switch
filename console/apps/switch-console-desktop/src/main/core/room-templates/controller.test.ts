import { describe, expect, it } from 'vitest';
import { roomTemplatesController } from './controller';

const parse = (yamlText: string) => roomTemplatesController.parse({ yamlText });

describe('roomTemplatesController.parse', () => {
  it('extracts params with types and defaults', () => {
    const result = parse(`
room:
  name: test-room
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
`);
    expect(result.roomName).toBe('test-room');
    expect(result.params).toHaveLength(4);
    expect(result.params[0]).toMatchObject({
      name: 'label',
      type: 'string',
      default: 'hello',
      isAgentName: false,
    });
    expect(result.params[1]).toMatchObject({ name: 'count', type: 'number', default: 3 });
    expect(result.params[2]).toMatchObject({ name: 'enabled', type: 'boolean', default: true });
    expect(result.params[3]).toMatchObject({ name: 'env', type: 'enum', enum: ['dev', 'prod'] });
    expect(result.warnings).toEqual([]);
  });

  it('agent picker: exactly "agent" or ending in "_agent"', () => {
    const result = parse(`
room:
  name: test
params:
  agent:
    type: string
  deploy_agent:
    type: string
  management:
    type: string
  agent_config:
    type: string
  my_agent_name:
    type: string
`);
    const byName = Object.fromEntries(result.params.map((p) => [p.name, p.isAgentName]));
    expect(byName).toEqual({
      agent: true,
      deploy_agent: true,
      management: false,
      agent_config: false,
      my_agent_name: false,
    });
  });

  it('non-string params never get isAgentName', () => {
    const result = parse(`
room:
  name: test
params:
  agent:
    type: number
  deploy_agent:
    type: boolean
`);
    expect(result.params.every((p) => !p.isAgentName)).toBe(true);
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

  it('warns when room block is missing', () => {
    const result = parse('params:\n  x:\n    type: string\n');
    expect(result.warnings).toContain('Template has no "room:" block — the server may reject it.');
  });

  it('throws on invalid YAML', () => {
    expect(() => parse('{{{')).toThrow(/Invalid YAML/);
  });

  it('rejects non-mapping YAML', () => {
    expect(() => parse('- a\n- b\n')).toThrow('Template must be a YAML mapping');
  });

  it('handles bare param names (no spec object)', () => {
    const result = parse(`
room:
  name: test
params:
  deploy_agent:
  label:
`);
    expect(result.params[0]).toMatchObject({
      name: 'deploy_agent',
      type: 'string',
      isAgentName: true,
      default: null,
    });
    expect(result.params[1]).toMatchObject({
      name: 'label',
      type: 'string',
      isAgentName: false,
    });
  });
});
