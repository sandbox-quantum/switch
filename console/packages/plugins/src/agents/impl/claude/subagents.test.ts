import type { PluginFs } from '@switch-console/core/agents/plugins';
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

// Forward-slash literals, not `path.join`: these keys are what a PluginFs sees,
// and on Windows `path.join` would produce backslashes here *and* in the code
// under test, so the two would agree with each other and with nothing else.
const settingsRel = (name: string) =>
  `${CLAUDE_SUBAGENTS.dirRelative}/${name}${CLAUDE_SUBAGENTS.settingsSuffix}`;
/** Provider-neutral per-agent credentials file (the current write location). */
const defRel = (name: string) => `${CLAUDE_SUBAGENTS.definitionsDirRelative}/${name}.md`;

describe('claudeRepoAgentsBehavior.launchArgs', () => {
  it('builds --agent and --settings for a subagent', () => {
    expect(claudeRepoAgentsBehavior.launchArgs('/repo/agent', 'reviewer')).toEqual([
      '--agent',
      'reviewer',
      '--settings',
      '/repo/agent/.switch/agents/reviewer.json',
    ]);
  });

  it('keeps a remote POSIX path POSIX', () => {
    // launchArgs is handed `remoteRepoDir` / the SSH session path for a remote
    // agent, and the flag is parsed by a shell on that Linux host.
    const args = claudeRepoAgentsBehavior.launchArgs('/home/agent/repo', 'reviewer');
    expect(args[3]).toBe('/home/agent/repo/.switch/agents/reviewer.json');
    expect(args[3]).not.toContain('\\');
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
      instructions: 'You are a careful reviewer.',
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
      instructions: 'You are a careful reviewer.',
      tools: [],
    });
  });

  it('falls back to the description for the body when there are no instructions', async () => {
    const workspaceFs = fakeFs({});
    await claudeRepoAgentsBehavior.writeDefinition(workspaceFs, {
      name: 'reviewer',
      description: 'Reviews diffs',
    });

    // Claude Code reads the body as the system prompt, so it cannot be empty.
    expect(await workspaceFs.read(defRel('reviewer'))).toBe(
      '---\nname: reviewer\ndescription: Reviews diffs\n---\n\nReviews diffs\n'
    );
  });

  it('does not read the description stand-in back as instructions', async () => {
    // Otherwise the round trip invents a prompt the user never wrote, and the
    // next write pins it as if they had.
    const workspaceFs = fakeFs({});
    await claudeRepoAgentsBehavior.writeDefinition(workspaceFs, {
      name: 'reviewer',
      description: 'Reviews diffs',
    });

    const attrs = await claudeRepoAgentsBehavior.readDefinition(workspaceFs, 'reviewer');
    expect(attrs?.instructions).toBe('');
  });

  it('generates the same bytes for the same attributes', async () => {
    // The two-way sync tells "someone edited this" from "the config moved on"
    // by comparing bytes against what was last generated, so generating has to
    // be repeatable or every write looks like a hand edit.
    const attributes = {
      name: 'reviewer',
      description: 'Reviews diffs',
      model: 'opus',
      tools: ['Read', 'Grep'],
      instructions: 'Be careful.',
    };
    const first = fakeFs({});
    const second = fakeFs({});
    await claudeRepoAgentsBehavior.writeDefinition(first, attributes);
    await claudeRepoAgentsBehavior.writeDefinition(second, attributes);

    expect(await first.read(defRel('reviewer'))).toBe(await second.read(defRel('reviewer')));
  });

  it('always merges the Switch connector tools into a non-empty tools list', async () => {
    const workspaceFs = fakeFs({});
    await claudeRepoAgentsBehavior.writeDefinition(workspaceFs, {
      name: 'reviewer',
      description: 'Reviews diffs',
      tools: ['Read', 'Grep'],
      instructions: 'body',
    });

    const raw = (await workspaceFs.read(defRel('reviewer'))) ?? '';
    expect(raw).toContain('tools: Read, Grep, mcp__plugin_switch-connector_switch');

    // Read-back strips the Switch rules so the form shows only the user's tools.
    const attrs = await claudeRepoAgentsBehavior.readDefinition(workspaceFs, 'reviewer');
    expect(attrs?.tools).toEqual(['Read', 'Grep']);
  });

  it('strips the retired switch-channel rule an older Switch Console wrote', async () => {
    const workspaceFs = fakeFs({
      [defRel('reviewer')]: [
        '---',
        'name: reviewer',
        'description: Reviews diffs',
        'tools: Read, mcp__plugin_switch-connector_switch, mcp__plugin_switch-connector_switch-channel',
        '---',
        'body',
        '',
      ].join('\n'),
    });

    const attrs = await claudeRepoAgentsBehavior.readDefinition(workspaceFs, 'reviewer');
    expect(attrs?.tools).toEqual(['Read']);

    // And it is not written back: only the rule Switch Console still authors is.
    await claudeRepoAgentsBehavior.writeDefinition(workspaceFs, attrs ?? {});
    const raw = (await workspaceFs.read(defRel('reviewer'))) ?? '';
    expect(raw).toContain('tools: Read, mcp__plugin_switch-connector_switch\n');
    expect(raw).not.toContain('switch-channel');
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
      instructions: 'do work',
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
    const neutralRel = '.switch/agents/reviewer.json';
    const workspaceFs = fakeFs({
      [defRel('reviewer')]: '---\nname: reviewer\ndescription: x\n---\n',
      [neutralRel]: '{"env":{}}',
    });

    await claudeRepoAgentsBehavior.removeLocal(workspaceFs, 'reviewer');

    expect(await workspaceFs.exists(neutralRel)).toBe(true);
  });
});
