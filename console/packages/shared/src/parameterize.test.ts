import { describe, expect, it } from 'vitest';
import { parameterize, type ParamSubstitution } from './parameterize';

const EXPORTED_YAML = `room:
  name: local-deploy
  description: Local deployment room
  channel_type: channel_public
  read_visibility: public
  write_visibility: public
  agents:
  - agent-alpha
  - agent-beta
`;

describe('parameterize', () => {
  it('returns the input unchanged when there are no substitutions', () => {
    expect(parameterize(EXPORTED_YAML, [])).toBe(EXPORTED_YAML);
  });

  it('replaces the room name and adds a params block', () => {
    const result = parameterize(EXPORTED_YAML, [{ key: 'name', value: 'local-deploy' }]);
    expect(result).toContain("name: '{name}'");
    expect(result).toContain('params:\n');
    expect(result).toContain('    default: local-deploy');
    expect(result).toContain('    type: string');
    expect(result).toMatch(/^params:/m);
    expect(result).toMatch(/^room:/m);
  });

  it('replaces agent names in the sequence', () => {
    const result = parameterize(EXPORTED_YAML, [{ key: 'agent_a', value: 'agent-alpha' }]);
    expect(result).toContain("- '{agent_a}'");
    expect(result).not.toContain('- agent-alpha');
  });

  it('handles multiple substitutions', () => {
    const subs: ParamSubstitution[] = [
      { key: 'name', value: 'local-deploy' },
      { key: 'agent_a', value: 'agent-alpha' },
      { key: 'agent_b', value: 'agent-beta' },
    ];
    const result = parameterize(EXPORTED_YAML, subs);
    expect(result).toContain("name: '{name}'");
    expect(result).toContain("- '{agent_a}'");
    expect(result).toContain("- '{agent_b}'");
    expect(result).toContain('  name:\n    type: string\n    default: local-deploy');
    expect(result).toContain('  agent_a:\n    type: string\n    default: agent-alpha');
    expect(result).toContain('  agent_b:\n    type: string\n    default: agent-beta');
  });

  it('includes description when provided', () => {
    const result = parameterize(EXPORTED_YAML, [
      { key: 'name', value: 'local-deploy', description: 'The room name' },
    ]);
    expect(result).toContain('    description: The room name');
  });

  it('replaces longer values first to avoid partial matches', () => {
    const yaml = `room:
  name: agent-alpha-room
  agents:
  - agent-alpha
`;
    const result = parameterize(yaml, [
      { key: 'room_name', value: 'agent-alpha-room' },
      { key: 'agent', value: 'agent-alpha' },
    ]);
    // The room name contains 'agent-alpha' as a substring — the longer value
    // must be replaced first so the room name isn't partially mangled.
    expect(result).toContain("name: '{room_name}'");
    expect(result).toContain("- '{agent}'");
  });

  it('quotes values containing single quotes', () => {
    const yaml = `room:
  name: it's-a-room
`;
    const result = parameterize(yaml, [{ key: 'name', value: "it's-a-room" }]);
    expect(result).toContain("name: '{name}'");
    // The default in the params block should have doubled single quotes.
    expect(result).toContain("default: 'it''s-a-room'");
  });

  it('replaces occurrences in instruction text', () => {
    const yaml = `room:
  name: my-room
  instructions: Welcome to my-room, the best room.
`;
    const result = parameterize(yaml, [{ key: 'name', value: 'my-room' }]);
    expect(result).toContain("instructions: 'Welcome to {name}, the best room.'");
  });

  it('throws on invalid param name', () => {
    expect(() => parameterize(EXPORTED_YAML, [{ key: '123bad', value: 'x' }])).toThrow(
      'Invalid param name'
    );
  });

  it('throws on empty value', () => {
    expect(() => parameterize(EXPORTED_YAML, [{ key: 'x', value: '' }])).toThrow('Empty value');
  });

  it('throws on duplicate keys', () => {
    expect(() =>
      parameterize(EXPORTED_YAML, [
        { key: 'name', value: 'a' },
        { key: 'name', value: 'b' },
      ])
    ).toThrow('Duplicate param key');
  });

  it('produces YAML that starts with params then room', () => {
    const result = parameterize(EXPORTED_YAML, [{ key: 'name', value: 'local-deploy' }]);
    const paramsIdx = result.indexOf('params:');
    const roomIdx = result.indexOf('room:');
    expect(paramsIdx).toBeLessThan(roomIdx);
    expect(paramsIdx).toBe(0);
  });

  it('round-trips: parameterized YAML is valid for the server parser', () => {
    // The server parser expects: top-level `params:` and `room:`, with
    // placeholder values as quoted strings. This test verifies structure only —
    // actual YAML parsing is the server's job.
    const result = parameterize(EXPORTED_YAML, [{ key: 'name', value: 'local-deploy' }]);
    // Has both top-level keys.
    expect(result).toMatch(/^params:/m);
    expect(result).toMatch(/^room:/m);
    // Placeholder is quoted (safe for yaml.safe_load).
    expect(result).toMatch(/'.*\{name\}.*'/);
  });
});
