import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { cloneDirectory, firstFreeDirectory, stripFrontMatter } from './agent-template-format';
import { composeTemplateDocument, parseAgentTemplate, serverDocument } from './template-document';

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

  it('reads who may address the agent, and warns about a value it does not know', () => {
    expect(parseAgentTemplate('agent:\n  instructions: i\n  addressing: anyone\n').addressing).toBe(
      'anyone'
    );
    expect(parseAgentTemplate('agent:\n  instructions: i\n').addressing).toBeNull();
    const odd = parseAgentTemplate('agent:\n  instructions: i\n  addressing: everyone\n');
    expect(odd.addressing).toBeNull();
    expect(odd.warnings[0]).toMatch(/addressing/);
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

describe('stripFrontMatter', () => {
  it('drops a leading front matter block and keeps the body', () => {
    expect(stripFrontMatter('---\nname: x\ndescription: y\n---\n\nYou are x.\n')).toBe(
      'You are x.\n'
    );
  });

  it('leaves instructions without front matter alone', () => {
    expect(stripFrontMatter('You are x.\n---\nnot front matter\n')).toBe(
      'You are x.\n---\nnot front matter\n'
    );
  });

  it('applies to the fallback instructions too', () => {
    const t = parseAgentTemplate('agent:\n  description: d\n', '---\nname: a\n---\nBody.\n');
    expect(t.instructions).toBe('Body.\n');
  });
});

describe('serverDocument', () => {
  it('turns the room half into a room template with the agent as a declared param', () => {
    const yaml = serverDocument(SWITCH_EXPERT);
    expect(yaml).not.toBeNull();
    const doc = load(yaml!) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['kickoff', 'params', 'room', 'version']);
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
    const yaml = serverDocument(
      'agent:\n  instructions: i\nparams:\n  topic:\n    type: string\nroom:\n  name: "{topic}"\n'
    );
    const doc = load(yaml!) as { params: Record<string, unknown> };
    expect(Object.keys(doc.params).sort()).toEqual(['agent', 'topic']);
  });

  it('is null when the template has no room', () => {
    expect(serverDocument('agent:\n  instructions: i\n')).toBeNull();
  });
});

describe('composeTemplateDocument', () => {
  it('inlines the persona, minus its front matter, and keeps the rest of the document', () => {
    const out = composeTemplateDocument(
      'agent:\n  name: a\n  repo: https://x/y\nroom:\n  name: r\n',
      '---\nname: a\n---\nBody.\n'
    );
    const doc = load(out) as { agent: Record<string, unknown>; room: Record<string, unknown> };
    expect(doc.agent.instructions).toBe('Body.\n');
    expect(doc.agent.repo).toBe('https://x/y');
    expect(doc.room).toEqual({ name: 'r' });
    expect(parseAgentTemplate(out).instructions).toBe('Body.\n');
  });

  it('leaves inline instructions alone', () => {
    const out = composeTemplateDocument('agent:\n  instructions: mine\n', 'other');
    expect((load(out) as { agent: { instructions: string } }).agent.instructions).toBe('mine');
  });
});

describe('cloneDirectory', () => {
  it('names the clone after the repository', () => {
    expect(cloneDirectory('/w/switch-expert', 'https://github.com/sandbox-quantum/switch')).toBe(
      '/w/switch-expert/switch'
    );
    expect(cloneDirectory('/w', 'https://github.com/jqlang/jq.git')).toBe('/w/jq');
    expect(cloneDirectory('/w', 'git@github.com:jqlang/jq.git')).toBe('/w/jq');
    expect(cloneDirectory('/w', 'https://example.com/repo/')).toBe('/w/repo');
  });
});

describe('firstFreeDirectory', () => {
  it('keeps the base when nothing lives there, and steps past folders that hold an agent', async () => {
    expect(await firstFreeDirectory('/w/a', async () => false)).toBe('/w/a');
    const taken = new Set(['/w/a', '/w/a-2']);
    expect(await firstFreeDirectory('/w/a', async (d) => taken.has(d))).toBe('/w/a-3');
  });
});
