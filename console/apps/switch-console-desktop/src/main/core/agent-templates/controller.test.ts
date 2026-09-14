import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  agentTemplateRoomDocument,
  cloneTargetFor,
  parseAgentTemplate,
} from './agent-template-format';

const SWITCH_EXPERT = `
version: 1
agent:
  name: switch-expert
  description: Answers questions about Switch.
  instructions: |
    You are switch-expert.
  repo: https://github.com/sandbox-quantum/switch
  sources:
    - label: Stand up a Switch expert
      url: https://docs.flintai.dev/flintai/switch/getting-started/switch-expert
    - https://docs.flintai.dev
room:
  name: "Ask {agent}"
  agents: ["{agent}"]
  users: ["{$creator}"]
kickoff: |
  @{agent} hi.
`;

describe('parseAgentTemplate', () => {
  it('reads the agent block, the repo and the sources', () => {
    const t = parseAgentTemplate(SWITCH_EXPERT);
    expect(t.name).toBe('switch-expert');
    expect(t.description).toBe('Answers questions about Switch.');
    expect(t.instructions).toContain('You are switch-expert.');
    expect(t.repoUrl).toBe('https://github.com/sandbox-quantum/switch');
    expect(t.sources).toEqual([
      {
        label: 'Stand up a Switch expert',
        url: 'https://docs.flintai.dev/flintai/switch/getting-started/switch-expert',
      },
      { label: null, url: 'https://docs.flintai.dev' },
    ]);
    expect(t.room).toEqual({ name: 'Ask {agent}', kickoff: '@{agent} hi.' });
    expect(t.warnings).toEqual([]);
  });

  it('is fine without a room, a repo or sources', () => {
    const t = parseAgentTemplate('agent:\n  description: d\n  instructions: i\n');
    expect(t.name).toBeNull();
    expect(t.repoUrl).toBeNull();
    expect(t.sources).toEqual([]);
    expect(t.room).toBeNull();
  });

  it('refuses a document with no agent block', () => {
    expect(() => parseAgentTemplate('room:\n  name: r\n')).toThrow(/"agent:" block/);
  });

  it('refuses an agent with no instructions', () => {
    expect(() => parseAgentTemplate('agent:\n  name: a\n  description: d\n')).toThrow(
      /instructions/
    );
  });

  it('refuses text that is not YAML', () => {
    expect(() => parseAgentTemplate('agent: [')).toThrow(/Invalid YAML/);
  });

  it('warns about a kickoff with no room to land in', () => {
    const t = parseAgentTemplate('agent:\n  instructions: i\nkickoff: hi\n');
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toMatch(/kickoff/);
  });
});

describe('agentTemplateRoomDocument', () => {
  it('turns the room half into a room template with the agent as a declared param', () => {
    const yaml = agentTemplateRoomDocument(SWITCH_EXPERT);
    expect(yaml).not.toBeNull();
    const doc = load(yaml!) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['kickoff', 'params', 'room']);
    expect((doc.params as Record<string, unknown>).agent).toMatchObject({ type: 'string' });
    expect(doc.room).toEqual({
      name: 'Ask {agent}',
      agents: ['{agent}'],
      users: ['{$creator}'],
    });
    expect(doc.kickoff).toBe('@{agent} hi.\n');
    expect(doc).not.toHaveProperty('agent');
  });

  it('keeps params the template declares itself', () => {
    const yaml = agentTemplateRoomDocument(
      'agent:\n  instructions: i\nparams:\n  topic:\n    type: string\nroom:\n  name: "{topic}"\n'
    );
    const doc = load(yaml!) as { params: Record<string, unknown> };
    expect(Object.keys(doc.params).sort()).toEqual(['agent', 'topic']);
  });

  it('is null when the template has no room', () => {
    expect(agentTemplateRoomDocument('agent:\n  instructions: i\n')).toBeNull();
  });
});

describe('cloneTargetFor', () => {
  it('names the clone after the repository', () => {
    expect(cloneTargetFor('/w/switch-expert', 'https://github.com/sandbox-quantum/switch')).toBe(
      '/w/switch-expert/switch'
    );
    expect(cloneTargetFor('/w', 'https://github.com/jqlang/jq.git')).toBe('/w/jq');
    expect(cloneTargetFor('/w', 'git@github.com:jqlang/jq.git')).toBe('/w/jq');
    expect(cloneTargetFor('/w', 'https://example.com/repo/')).toBe('/w/repo');
  });
});
