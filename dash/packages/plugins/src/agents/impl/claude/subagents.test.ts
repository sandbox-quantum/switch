import path from 'node:path';
import type { PluginFs } from '@switchdash/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { CLAUDE_SUBAGENTS, claudeSubagentsBehavior } from './subagents';

/** Minimal in-memory PluginFs over a flat path→content map. */
function fakeFs(files: Record<string, string>): PluginFs {
  const store = new Map(Object.entries(files));
  return {
    read: (p) => Promise.resolve(store.get(p) ?? null),
    write: (p, content) => {
      store.set(p, content);
      return Promise.resolve();
    },
    delete: (p) => {
      store.delete(p);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(store.has(p)),
    list: (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
      }
      return Promise.resolve([...names]);
    },
  };
}

const settingsRel = (name: string) =>
  path.join(CLAUDE_SUBAGENTS.dirRelative, `${name}${CLAUDE_SUBAGENTS.settingsSuffix}`);
/** Provider-neutral per-agent credentials file (the current write location). */
const neutralRel = (name: string) => path.join('.switch', 'agents', `${name}.json`);
const defRel = (name: string) => path.join(CLAUDE_SUBAGENTS.definitionsDirRelative, `${name}.md`);

describe('claudeSubagentsBehavior.launchArgs', () => {
  it('builds --agent and --settings for a subagent', () => {
    expect(claudeSubagentsBehavior.launchArgs('/repo/agent', 'reviewer')).toEqual([
      '--agent',
      'reviewer',
      '--settings',
      path.join('/repo/agent', '.switch', 'agents', 'reviewer.json'),
    ]);
  });
});

describe('claudeSubagentsBehavior.discoverDefinitions', () => {
  it('parses definitions, eligibility, and registered state', async () => {
    const workspaceFs = fakeFs({
      [defRel('reviewer')]:
        '---\nname: reviewer\ndescription: Reviews code\nmodel: opus\n---\nbody',
      // No `tools` line → eligible (inherits all tools), and registered (creds exist).
      [settingsRel('reviewer')]: '{"env":{}}',
      // Has a tools list without the Switch MCP prefix → ineligible.
      [defRel('linter')]: '---\ndescription: Lints\ntools: Read, Edit\n---\n',
    });

    const defs = await claudeSubagentsBehavior.discoverDefinitions(workspaceFs);

    expect(defs).toEqual([
      { name: 'linter', description: 'Lints', model: null, eligible: false, registered: false },
      {
        name: 'reviewer',
        description: 'Reviews code',
        model: 'opus',
        eligible: true,
        registered: true,
      },
    ]);
  });
});

describe('claudeSubagentsBehavior.discoverLocal', () => {
  it('reads creds env and definition meta, project scope then home', async () => {
    const workspaceFs = fakeFs({
      [settingsRel('reviewer')]:
        '{"env":{"SWITCH_AGENT_ID":"a1","SWITCH_API_ENDPOINT":"https://s"}}',
      [defRel('reviewer')]: '---\ndescription: Reviews\nmodel: opus\n---\n',
      [settingsRel('helper')]: '{"env":{"SWITCH_AGENT_ID":"a2"}}',
    });
    const homeFs = fakeFs({
      [defRel('helper')]: '---\ndescription: From home\n---\n',
    });

    const local = await claudeSubagentsBehavior.discoverLocal(workspaceFs, homeFs);

    expect(local).toEqual([
      {
        name: 'helper',
        description: 'From home',
        model: null,
        switchAgentId: 'a2',
        apiEndpoint: null,
      },
      {
        name: 'reviewer',
        description: 'Reviews',
        model: 'opus',
        switchAgentId: 'a1',
        apiEndpoint: 'https://s',
      },
    ]);
  });
});

describe('claudeSubagentsBehavior.readLaunchEnv', () => {
  it('returns only non-empty SWITCH_* keys', async () => {
    const workspaceFs = fakeFs({
      [settingsRel('reviewer')]:
        '{"env":{"SWITCH_AGENT_ID":"a1","SWITCH_API_TOKEN":"t","SWITCH_API_ENDPOINT":"  ","OTHER":"x"}}',
    });

    expect(await claudeSubagentsBehavior.readLaunchEnv(workspaceFs, 'reviewer')).toEqual({
      SWITCH_AGENT_ID: 'a1',
      SWITCH_API_TOKEN: 't',
    });
  });

  it('returns {} when the credentials file is missing', async () => {
    expect(await claudeSubagentsBehavior.readLaunchEnv(fakeFs({}), 'reviewer')).toEqual({});
  });
});

describe('claudeSubagentsBehavior.writeDefinition / readDefinition', () => {
  it('writes frontmatter + body without a tools line, and round-trips attributes', async () => {
    const workspaceFs = fakeFs({});
    await claudeSubagentsBehavior.writeDefinition(workspaceFs, {
      name: 'reviewer',
      description: 'Reviews diffs',
      model: 'opus',
      prompt: 'You are a careful reviewer.',
    });

    const raw = await workspaceFs.read(defRel('reviewer'));
    expect(raw).toBe(
      '---\nname: reviewer\ndescription: Reviews diffs\nmodel: opus\n---\n\nYou are a careful reviewer.\n'
    );
    // No `tools:` line → the subagent inherits all tools and is Switch-eligible.
    expect(raw).not.toContain('tools:');

    const attrs = await claudeSubagentsBehavior.readDefinition(workspaceFs, 'reviewer');
    expect(attrs).toMatchObject({
      name: 'reviewer',
      description: 'Reviews diffs',
      model: 'opus',
      prompt: 'You are a careful reviewer.',
      tools: [],
    });
  });

  it('always merges the Switch connector tools into a non-empty tools list', async () => {
    const workspaceFs = fakeFs({});
    await claudeSubagentsBehavior.writeDefinition(workspaceFs, {
      name: 'reviewer',
      description: 'Reviews diffs',
      tools: ['Read', 'Grep'],
      prompt: 'body',
    });

    const raw = (await workspaceFs.read(defRel('reviewer'))) ?? '';
    expect(raw).toContain(
      'tools: Read, Grep, mcp__plugin_switch-connector_switch, mcp__plugin_switch-connector_switch-channel'
    );

    // Read-back strips the Switch rules so the form shows only the user's tools.
    const attrs = await claudeSubagentsBehavior.readDefinition(workspaceFs, 'reviewer');
    expect(attrs?.tools).toEqual(['Read', 'Grep']);
  });

  it('serialises optional scalar, number, and boolean fields and omits empty ones', async () => {
    const workspaceFs = fakeFs({});
    await claudeSubagentsBehavior.writeDefinition(workspaceFs, {
      name: 'worker',
      description: 'line one\nline two',
      model: '',
      color: 'blue',
      maxTurns: 5,
      background: true,
      permissionMode: '',
      prompt: 'do work',
    });

    const raw = (await workspaceFs.read(defRel('worker'))) ?? '';
    expect(raw).toContain('description: line one line two');
    expect(raw).toContain('color: blue');
    expect(raw).toContain('maxTurns: 5');
    expect(raw).toContain('background: true');
    expect(raw).not.toContain('model:');
    expect(raw).not.toContain('permissionMode:');

    const attrs = await claudeSubagentsBehavior.readDefinition(workspaceFs, 'worker');
    expect(attrs).toMatchObject({ color: 'blue', maxTurns: 5, background: true, model: '' });
  });

  it('returns null when no definition exists', async () => {
    expect(await claudeSubagentsBehavior.readDefinition(fakeFs({}), 'ghost')).toBeNull();
  });
});

describe('claudeSubagentsBehavior.attributeFields', () => {
  it('declares name and description first, both required', () => {
    const fields = claudeSubagentsBehavior.attributeFields();
    expect(fields[0]).toMatchObject({ key: 'name', required: true, immutableOnEdit: true });
    expect(fields[1]).toMatchObject({ key: 'description', required: true });
    expect(fields.map((f) => f.key)).toContain('tools');
  });
});

describe('claudeSubagentsBehavior.removeLocal', () => {
  it('deletes both the definition and credentials files', async () => {
    const workspaceFs = fakeFs({
      [defRel('reviewer')]: '---\nname: reviewer\ndescription: x\n---\n',
      [settingsRel('reviewer')]: '{"env":{}}',
    });

    await claudeSubagentsBehavior.removeLocal(workspaceFs, 'reviewer');

    expect(await workspaceFs.exists(defRel('reviewer'))).toBe(false);
    expect(await workspaceFs.exists(settingsRel('reviewer'))).toBe(false);
  });
});

describe('claudeSubagentsBehavior.writeSettings', () => {
  it('writes the credentials JSON, permissions.allow, and a gitignore', async () => {
    const workspaceFs = fakeFs({});
    await claudeSubagentsBehavior.writeSettings(workspaceFs, {
      subagentName: 'reviewer',
      apiEndpoint: 'https://s',
      apiToken: 'secret',
      agentId: 'a1',
    });

    const written = await workspaceFs.read(neutralRel('reviewer'));
    expect(JSON.parse(written!)).toEqual({
      permissions: {
        allow: [
          'mcp__plugin_switch-connector_switch',
          'mcp__plugin_switch-connector_switch-channel',
        ],
      },
      env: { SWITCH_API_ENDPOINT: 'https://s', SWITCH_API_TOKEN: 'secret', SWITCH_AGENT_ID: 'a1' },
    });
    expect(await workspaceFs.read(path.join('.switch', 'agents', '.gitignore'))).toBe('*\n');
  });

  it('preserves existing permissions and env, unioning the Switch rules', async () => {
    const workspaceFs = fakeFs({
      [neutralRel('reviewer')]: JSON.stringify({
        permissions: { allow: ['Bash'] },
        env: { KEEP: 'me' },
      }),
    });
    await claudeSubagentsBehavior.writeSettings(workspaceFs, {
      subagentName: 'reviewer',
      apiEndpoint: 'https://s',
      apiToken: 'secret',
      agentId: 'a1',
    });

    const settings = JSON.parse((await workspaceFs.read(neutralRel('reviewer')))!);
    expect(settings.permissions.allow).toEqual([
      'Bash',
      'mcp__plugin_switch-connector_switch',
      'mcp__plugin_switch-connector_switch-channel',
    ]);
    expect(settings.env.KEEP).toBe('me');
    expect(settings.env.SWITCH_AGENT_ID).toBe('a1');
  });
});
