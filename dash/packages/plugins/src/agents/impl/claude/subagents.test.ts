import path from 'node:path';
import type { PluginFs } from '@switchdash/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { CLAUDE_SUBAGENTS, claudeRepoAgentsBehavior } from './subagents';

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
const defRel = (name: string) => path.join(CLAUDE_SUBAGENTS.definitionsDirRelative, `${name}.md`);

describe('claudeRepoAgentsBehavior.launchArgs', () => {
  it('builds --agent and --settings for a subagent', () => {
    expect(claudeRepoAgentsBehavior.launchArgs('/repo/agent', 'reviewer')).toEqual([
      '--agent',
      'reviewer',
      '--settings',
      path.join('/repo/agent', '.switch', 'agents', 'reviewer.json'),
    ]);
  });
});

describe('claudeRepoAgentsBehavior.discoverDefinitions', () => {
  it('parses definitions, eligibility, and registered state', async () => {
    const workspaceFs = fakeFs({
      [defRel('reviewer')]:
        '---\nname: reviewer\ndescription: Reviews code\nmodel: opus\n---\nbody',
      // No `tools` line → eligible (inherits all tools), and registered (creds exist).
      [settingsRel('reviewer')]: '{"env":{}}',
      // Has a tools list without the Switch MCP prefix → ineligible.
      [defRel('linter')]: '---\ndescription: Lints\ntools: Read, Edit\n---\n',
    });

    const defs = await claudeRepoAgentsBehavior.discoverDefinitions(workspaceFs);

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

describe('claudeRepoAgentsBehavior.discoverLocal', () => {
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

    const local = await claudeRepoAgentsBehavior.discoverLocal(workspaceFs, homeFs);

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

describe('claudeRepoAgentsBehavior.readLaunchEnv', () => {
  it('returns only non-empty SWITCH_* keys', async () => {
    const workspaceFs = fakeFs({
      [settingsRel('reviewer')]:
        '{"env":{"SWITCH_AGENT_ID":"a1","SWITCH_API_TOKEN":"t","SWITCH_API_ENDPOINT":"  ","OTHER":"x"}}',
    });

    expect(await claudeRepoAgentsBehavior.readLaunchEnv(workspaceFs, 'reviewer')).toEqual({
      SWITCH_AGENT_ID: 'a1',
      SWITCH_API_TOKEN: 't',
    });
  });

  it('returns {} when the credentials file is missing', async () => {
    expect(await claudeRepoAgentsBehavior.readLaunchEnv(fakeFs({}), 'reviewer')).toEqual({});
  });
});

describe('claudeRepoAgentsBehavior.writeDefinition / readDefinition', () => {
  it('writes frontmatter + body without a tools line, and round-trips attributes', async () => {
    const workspaceFs = fakeFs({});
    await claudeRepoAgentsBehavior.writeDefinition(workspaceFs, {
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

    const attrs = await claudeRepoAgentsBehavior.readDefinition(workspaceFs, 'reviewer');
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
    await claudeRepoAgentsBehavior.writeDefinition(workspaceFs, {
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
    const attrs = await claudeRepoAgentsBehavior.readDefinition(workspaceFs, 'reviewer');
    expect(attrs?.tools).toEqual(['Read', 'Grep']);
  });

  it('serialises optional scalar, number, and boolean fields and omits empty ones', async () => {
    const workspaceFs = fakeFs({});
    await claudeRepoAgentsBehavior.writeDefinition(workspaceFs, {
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

    const attrs = await claudeRepoAgentsBehavior.readDefinition(workspaceFs, 'worker');
    expect(attrs).toMatchObject({ color: 'blue', maxTurns: 5, background: true, model: '' });
  });

  it('returns null when no definition exists', async () => {
    expect(await claudeRepoAgentsBehavior.readDefinition(fakeFs({}), 'ghost')).toBeNull();
  });
});

describe('claudeRepoAgentsBehavior.attributeFields', () => {
  it('declares name and description first, both required', () => {
    const fields = claudeRepoAgentsBehavior.attributeFields();
    expect(fields[0]).toMatchObject({ key: 'name', required: true, immutableOnEdit: true });
    expect(fields[1]).toMatchObject({ key: 'description', required: true });
    expect(fields.map((f) => f.key)).toContain('tools');
  });
});

describe('claudeRepoAgentsBehavior.removeLocal', () => {
  it('deletes the definition and the legacy per-agent settings', async () => {
    const workspaceFs = fakeFs({
      [defRel('reviewer')]: '---\nname: reviewer\ndescription: x\n---\n',
      [settingsRel('reviewer')]: '{"env":{}}',
    });

    await claudeRepoAgentsBehavior.removeLocal(workspaceFs, 'reviewer');

    expect(await workspaceFs.exists(defRel('reviewer'))).toBe(false);
    expect(await workspaceFs.exists(settingsRel('reviewer'))).toBe(false);
  });

  it('leaves the provider-neutral credentials to the caller, which removes them for every provider', async () => {
    const neutralRel = path.join('.switch', 'agents', 'reviewer.json');
    const workspaceFs = fakeFs({
      [defRel('reviewer')]: '---\nname: reviewer\ndescription: x\n---\n',
      [neutralRel]: '{"env":{}}',
    });

    await claudeRepoAgentsBehavior.removeLocal(workspaceFs, 'reviewer');

    expect(await workspaceFs.exists(neutralRel)).toBe(true);
  });
});
