import type { PluginFs } from '@switch-console/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { CLAUDE_SETTINGS_PATH, buildClaudeHookConfig } from './hooks';

function createMemoryFs(initial: Record<string, string> = {}): PluginFs {
  const files = new Map(Object.entries(initial));
  return {
    async read(path) {
      return files.get(path) ?? null;
    },
    async write(path, content) {
      files.set(path, content);
    },
    async delete(path) {
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
    async list(path) {
      return [...files.keys()].filter((file) => file.startsWith(path));
    },
  };
}

type NestedHookEntry = { matcher?: string; hooks: { type: string; command: string }[] };

describe('buildClaudeHookConfig', () => {
  it('installs the scoped connect_to_room and general activity hooks', async () => {
    const fs = createMemoryFs();
    await buildClaudeHookConfig().writeHooks(fs, []);

    const settings = JSON.parse((await fs.read(CLAUDE_SETTINGS_PATH))!) as {
      hooks: Record<string, NestedHookEntry[]>;
    };

    const postToolUse = settings.hooks.PostToolUse;
    expect(postToolUse).toHaveLength(2);

    const scoped = postToolUse.find((e) => e.matcher === 'mcp__.*__connect_to_room');
    expect(scoped).toBeDefined();
    expect(scoped!.hooks[0].command).toContain('switch_room_connect');

    // The general PostToolUse activity hook (no matcher) reports 'tool-done'.
    const general = postToolUse.find((e) => e.matcher === undefined);
    expect(general).toBeDefined();
    expect(general!.hooks[0].command).toContain('tool-done');

    // PreToolUse reports 'tool-use' so work shows in-progress.
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('tool-use');

    // Failures and subagent start/stop get their own event types.
    expect(settings.hooks.PostToolUseFailure[0].hooks[0].command).toContain('tool-use-failure');
    expect(settings.hooks.SubagentStart[0].hooks[0].command).toContain('subagent');
    expect(settings.hooks.SubagentStop[0].hooks[0].command).toContain('subagent-done');
  });

  it('preserves unrelated settings (env, permissions) when installing hooks', async () => {
    const existing = JSON.stringify({
      env: { SWITCH_API_TOKEN: 'secret', SWITCH_AGENT_ID: 'agent-1' },
      permissions: { allow: ['Bash'] },
    });
    const fs = createMemoryFs({ [CLAUDE_SETTINGS_PATH]: existing });
    await buildClaudeHookConfig().writeHooks(fs, []);

    const settings = JSON.parse((await fs.read(CLAUDE_SETTINGS_PATH))!) as Record<string, unknown>;
    expect(settings.env).toEqual({ SWITCH_API_TOKEN: 'secret', SWITCH_AGENT_ID: 'agent-1' });
    expect(settings.permissions).toEqual({ allow: ['Bash'] });
    expect(settings.hooks).toBeDefined();
  });

  it('refuses to install hooks over an unparseable settings file', async () => {
    const fs = createMemoryFs({ [CLAUDE_SETTINGS_PATH]: 'not json {' });
    await expect(buildClaudeHookConfig().writeHooks(fs, [])).rejects.toThrow(/not valid JSON/);
    expect(await fs.read(CLAUDE_SETTINGS_PATH)).toBe('not json {');
  });

  it('propagates a failed settings read instead of rewriting the file from scratch', async () => {
    const fs = createMemoryFs();
    fs.read = async () => {
      throw new Error('SSH connection is not available');
    };
    await expect(buildClaudeHookConfig().writeHooks(fs, [])).rejects.toThrow(
      /SSH connection is not available/
    );
    expect(await fs.exists(CLAUDE_SETTINGS_PATH)).toBe(false);
  });

  it('parses tool-use / tool-done into "Running tool" / "Ran tool" lines', async () => {
    const { parseHookEvent } = buildClaudeHookConfig();
    expect(
      parseHookEvent('tool-use', { tool_name: 'Edit', tool_input: { file_path: '/a/b/x.py' } })
    ).toEqual({ kind: 'activity', detail: '_Running tool_ `Edit` — x.py' });
    expect(
      parseHookEvent('tool-done', { tool_name: 'Edit', tool_input: { file_path: '/a/b/x.py' } })
    ).toEqual({ kind: 'activity', detail: '_Ran tool_ `Edit` — x.py' });
    expect(
      parseHookEvent('tool-use', { tool_name: 'Bash', tool_input: { command: 'git push' } })
    ).toEqual({ kind: 'activity', detail: '_Running tool_ `Bash` — git push' });
    // MCP tool → bare leaf name, no object suffix.
    expect(
      parseHookEvent('tool-use', { tool_name: 'mcp__plugin_switch__post_message', tool_input: {} })
    ).toEqual({ kind: 'activity', detail: '_Running tool_ `post_message`' });
    // The Task tool is left to the subagent hooks.
    expect(parseHookEvent('tool-use', { tool_name: 'Task', tool_input: {} })).toEqual({
      kind: 'ignore',
    });
    expect(parseHookEvent('tool-use', {})).toEqual({ kind: 'ignore' });
  });

  it('parses a tool-use-failure event into a "failed" activity line', async () => {
    const { parseHookEvent } = buildClaudeHookConfig();
    expect(
      parseHookEvent('tool-use-failure', {
        tool_name: 'Bash',
        tool_input: { command: 'pytest -q' },
      })
    ).toEqual({ kind: 'activity', detail: '`Bash` _failed_ — pytest -q' });
    expect(parseHookEvent('tool-use-failure', { tool_name: 'Edit' })).toEqual({
      kind: 'activity',
      detail: '`Edit` _failed_',
    });
    expect(parseHookEvent('tool-use-failure', {})).toEqual({ kind: 'ignore' });
  });

  it('parses subagent start/stop into named delegation lines', async () => {
    const { parseHookEvent } = buildClaudeHookConfig();
    expect(parseHookEvent('subagent', { agent_type: 'Explore' })).toEqual({
      kind: 'activity',
      detail: '_Delegating to_ `Explore`',
    });
    expect(parseHookEvent('subagent-done', { agent_type: 'Explore' })).toEqual({
      kind: 'activity',
      detail: '_Subagent_ `Explore` _finished_',
    });
    expect(parseHookEvent('subagent', {})).toEqual({
      kind: 'activity',
      detail: '_Delegating to a subagent_',
    });
  });

  it('prefers the typed notification_type, falling back to message text', async () => {
    const { parseHookEvent } = buildClaudeHookConfig();
    expect(
      parseHookEvent('notification', { notification_type: 'permission_prompt' })
    ).toMatchObject({
      kind: 'status',
      type: 'notification',
      notificationType: 'permission_prompt',
    });
    // Typed but outside our enum → mapped by intent.
    expect(
      parseHookEvent('notification', { notification_type: 'agent_needs_input' })
    ).toMatchObject({ notificationType: 'permission_prompt' });
    // No typed field → sniff the message.
    expect(
      parseHookEvent('notification', { message: 'Claude needs your permission to run git' })
    ).toMatchObject({ notificationType: 'permission_prompt' });
    expect(parseHookEvent('notification', { message: 'waiting for you' })).toMatchObject({
      notificationType: 'idle_prompt',
    });
  });

  it('leaves matcher-less hooks (Stop) without a matcher field', async () => {
    const fs = createMemoryFs();
    await buildClaudeHookConfig().writeHooks(fs, []);

    const settings = JSON.parse((await fs.read(CLAUDE_SETTINGS_PATH))!) as {
      hooks: Record<string, NestedHookEntry[]>;
    };

    expect(settings.hooks.Stop[0]).not.toHaveProperty('matcher');
  });
});
