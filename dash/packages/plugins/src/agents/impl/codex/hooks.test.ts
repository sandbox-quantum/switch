import type { PluginFs } from '@switchdash/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { CODEX_HOOKS_PATH, buildCodexHookConfig } from './hooks';

const CODEX_CONFIG_PATH = '.codex/config.toml';

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

describe('buildCodexHookConfig.parseHookEvent', () => {
  const { parseHookEvent } = buildCodexHookConfig();

  it('captures the rollout session id from session-start', () => {
    expect(parseHookEvent('session-start', { session_id: 'abc123' })).toEqual({
      kind: 'session',
      providerSessionId: 'abc123',
    });
  });

  it('falls back through resource_id / resourceId / sessionId', () => {
    expect(parseHookEvent('session-start', { resource_id: 'r1' })).toEqual({
      kind: 'session',
      providerSessionId: 'r1',
    });
    expect(parseHookEvent('session-start', { resourceId: 'r2' })).toEqual({
      kind: 'session',
      providerSessionId: 'r2',
    });
    expect(parseHookEvent('session-start', { sessionId: 'r3' })).toEqual({
      kind: 'session',
      providerSessionId: 'r3',
    });
  });

  it('trims the id and ignores a blank or missing session id', () => {
    expect(parseHookEvent('session-start', { session_id: '  x  ' })).toEqual({
      kind: 'session',
      providerSessionId: 'x',
    });
    expect(parseHookEvent('session-start', { session_id: '   ' })).toEqual({ kind: 'ignore' });
    expect(parseHookEvent('session-start', {})).toEqual({ kind: 'ignore' });
  });

  it('maps an idle_prompt notification to a stop status', () => {
    expect(parseHookEvent('notification', { notification_type: 'idle_prompt' })).toEqual({
      kind: 'status',
      type: 'stop',
    });
  });

  it('maps agent-turn-complete (no notification_type) to a stop status', () => {
    expect(parseHookEvent('notification', { type: 'agent-turn-complete' })).toEqual({
      kind: 'status',
      type: 'stop',
    });
  });

  it('maps a permission_prompt notification to a notification status', () => {
    expect(parseHookEvent('notification', { notification_type: 'permission_prompt' })).toEqual({
      kind: 'status',
      type: 'notification',
      notificationType: 'permission_prompt',
    });
  });

  it('defers unrelated events to the default parser', () => {
    expect(parseHookEvent('stop', {})).toMatchObject({ kind: 'status', type: 'stop' });
    expect(parseHookEvent('totally-unknown', {})).toEqual({ kind: 'ignore' });
  });
});

describe('buildCodexHookConfig install/read/delete', () => {
  it('installs Stop / PermissionRequest / SessionStart hooks and reports the written path', async () => {
    const fs = createMemoryFs();
    const paths = await buildCodexHookConfig().writeHooks(fs, []);

    expect(paths).toEqual([CODEX_HOOKS_PATH]);
    const config = JSON.parse((await fs.read(CODEX_HOOKS_PATH))!) as {
      hooks: Record<string, unknown[]>;
    };
    for (const key of ['Stop', 'PermissionRequest', 'SessionStart']) {
      expect(config.hooks[key]).toHaveLength(1);
      expect(JSON.stringify(config.hooks[key][0])).toContain('SWITCHDASH_HOOK_PORT');
    }
  });

  it('reflects installation state through getHooksInstalled + readHooks', async () => {
    const fs = createMemoryFs();
    const cfg = buildCodexHookConfig();

    expect(await cfg.getHooksInstalled(fs)).toBe(false);
    expect(await cfg.readHooks(fs)).toEqual([]);

    await cfg.writeHooks(fs, []);

    expect(await cfg.getHooksInstalled(fs)).toBe(true);
    expect(await cfg.readHooks(fs)).toEqual([
      { event: 'switchdash', command: 'SWITCHDASH_HOOK_PORT' },
    ]);
  });

  it('preserves user hooks and removes only switchdash entries on delete', async () => {
    const userEntry = { hooks: [{ type: 'command', command: 'echo hi' }] };
    const fs = createMemoryFs({
      [CODEX_HOOKS_PATH]: JSON.stringify({ hooks: { Stop: [userEntry] } }),
    });
    const cfg = buildCodexHookConfig();

    await cfg.writeHooks(fs, []);
    let config = JSON.parse((await fs.read(CODEX_HOOKS_PATH))!) as {
      hooks: Record<string, unknown[]>;
    };
    // The user's own Stop hook survives alongside the injected switchdash one.
    expect(config.hooks.Stop).toHaveLength(2);

    await cfg.deleteHooks(fs);
    config = JSON.parse((await fs.read(CODEX_HOOKS_PATH))!) as { hooks: Record<string, unknown[]> };
    expect(config.hooks.Stop).toEqual([userEntry]);
    expect(await cfg.getHooksInstalled(fs)).toBe(false);
  });

  it('migrates away a legacy config.toml notify command on write', async () => {
    const configToml = [
      'notify = ["powershell.exe", "-NoProfile", "-File", "/tmp/switchdash-codex-notify.ps1"]',
      'model = "gpt-5"',
      '',
    ].join('\n');
    const fs = createMemoryFs({ [CODEX_CONFIG_PATH]: configToml });

    await buildCodexHookConfig().writeHooks(fs, []);

    const rewritten = (await fs.read(CODEX_CONFIG_PATH))!;
    expect(rewritten).not.toContain('notify');
    // Unrelated config is left intact.
    expect(rewritten).toContain('gpt-5');
  });
});
