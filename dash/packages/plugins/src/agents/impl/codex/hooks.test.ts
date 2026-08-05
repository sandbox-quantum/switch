import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HookEvent, PluginFs } from '@switchdash/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { CODEX_CONFIG_PATH, CODEX_HOOKS_PATH, buildCodexHookConfig } from './hooks';
import { plugin } from './index';

const execFileAsync = promisify(execFile);

/**
 * Execute a generated hook command under a real `sh` with `curl` stubbed out,
 * feeding it an event payload on stdin the way Codex does, and report the URL
 * and request body it would have posted.
 *
 * A copy of the harness in `@switchdash/core`'s `helpers/hooks.test.ts`; this
 * package resolves that one through `dist` subpath exports, which do not carry
 * test files.
 */
async function runHookCommand(
  command: string,
  { env, stdin }: { env: Record<string, string>; stdin: string }
): Promise<{ url: string; body: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-hook-'));
  try {
    const stub = path.join(dir, 'curl');
    const argvOut = path.join(dir, 'argv');
    const bodyOut = path.join(dir, 'body');
    await writeFile(
      stub,
      '#!/bin/sh\n' +
        `printf '%s\\n' "$@" > ${JSON.stringify(argvOut)}\n` +
        `for a in "$@"; do [ "$a" = "@-" ] && cat > ${JSON.stringify(bodyOut)}; done\n` +
        'exit 0\n',
      { mode: 0o755 }
    );
    await writeFile(bodyOut, '');
    await writeFile(argvOut, '');

    await new Promise<void>((resolve, reject) => {
      const child = spawn('sh', ['-c', command], {
        env: { ...env, PATH: `${dir}:${process.env.PATH ?? ''}` },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', reject);
      child.on('close', () => resolve());
      child.stdin.end(stdin);
    });

    const { stdout: argv } = await execFileAsync('cat', [argvOut]);
    const { stdout: body } = await execFileAsync('cat', [bodyOut]);
    return { url: argv.split('\n').find((a) => a.startsWith('http://')) ?? '', body };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The `command` strings switchdash writes into Codex's `hooks.json`, by event. */
async function installedCommands(): Promise<Record<string, string>> {
  const fs = createMemoryFs();
  await buildCodexHookConfig().writeHooks(fs, []);
  const config = JSON.parse((await fs.read(CODEX_HOOKS_PATH))!) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  return Object.fromEntries(
    Object.entries(config.hooks).map(([key, entries]) => [key, entries[0].hooks[0].command])
  );
}

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

  it('handles an empty notification body without a stop/permission misclassification', () => {
    // nt undefined and no `type: agent-turn-complete` → falls to the default
    // parser, which yields a plain notification status (not a spurious stop).
    expect(parseHookEvent('notification', {})).toMatchObject({
      kind: 'status',
      type: 'notification',
    });
  });

  it('turns tool events into activity, so the status is not stuck on the opener', () => {
    // Without these the runtime status has nothing to report for a whole turn
    // and renders "Working on it…" from first tool call to last.
    expect(parseHookEvent('tool-use', { tool_name: 'shell' })).toEqual({
      kind: 'activity',
      detail: '_Running tool_ `shell`',
    });
    expect(parseHookEvent('tool-done', { tool_name: 'shell' })).toEqual({
      kind: 'activity',
      detail: '_Ran tool_ `shell`',
    });
  });

  it("names the Switch MCP tool by its leaf, so a room action reads as what it did", () => {
    expect(
      parseHookEvent('tool-use', { tool_name: 'mcp__switch__post_message' })
    ).toEqual({ kind: 'activity', detail: '_Running tool_ `post_message`' });
  });

  it("renders Codex's argv-array shell command as text", () => {
    // Codex sends `command` as an argv array where Claude sends a string.
    expect(
      parseHookEvent('tool-use', {
        tool_name: 'shell',
        tool_input: { command: ['bash', '-lc', 'pytest  -q'] },
      })
    ).toEqual({ kind: 'activity', detail: '_Running tool_ `shell` — bash -lc pytest -q' });
  });

  it('drops the object suffix rather than the line when the input is unexpected', () => {
    // The tool name is the point; an unrecognised tool or a shape we did not
    // predict must not cost the status update entirely.
    expect(parseHookEvent('tool-use', { tool_name: 'some_future_tool' })).toEqual({
      kind: 'activity',
      detail: '_Running tool_ `some_future_tool`',
    });
    expect(
      parseHookEvent('tool-use', { tool_name: 'shell', tool_input: { command: 42 } })
    ).toEqual({ kind: 'activity', detail: '_Running tool_ `shell`' });
  });

  it('ignores a tool event with no tool name', () => {
    expect(parseHookEvent('tool-use', {})).toEqual({ kind: 'ignore' });
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

  it('installs tool hooks unscoped, with no room-tracking matcher', async () => {
    // The tool hooks exist for the runtime status line and so cover every tool.
    // Room tracking is not among their jobs: since the agent-bridge push
    // transport (CHOO-1857), a session's room is claimed on the connection
    // switchdash opens and hands it as SWITCH_CONNECTION_ID, so the server
    // reports the room back and the old `connect_to_room` scrape is gone.
    const fs = createMemoryFs();
    await buildCodexHookConfig().writeHooks(fs, []);
    const config = JSON.parse((await fs.read(CODEX_HOOKS_PATH))!) as {
      hooks: Record<string, { matcher?: string }[]>;
    };

    expect(Object.keys(config.hooks).sort()).toEqual([
      'PermissionRequest',
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
    ]);
    expect(config.hooks.PostToolUse[0].matcher).toBeUndefined();
    expect(config.hooks.PreToolUse[0].matcher).toBeUndefined();
    expect(JSON.stringify(config.hooks)).not.toContain('switch_room_connect');
  });

  it('declares exactly the events its installed hooks can produce', async () => {
    // The declaration is what the rest of the app reasons about a provider from,
    // so an event no installed hook emits is a claim nothing can honour.
    const producible: Record<string, HookEvent> = {
      Stop: 'stop',
      PermissionRequest: 'notification',
      SessionStart: 'session',
      PreToolUse: 'tool-use',
      PostToolUse: 'tool-done',
    };

    const fs = createMemoryFs();
    await buildCodexHookConfig().writeHooks(fs, []);
    const config = JSON.parse((await fs.read(CODEX_HOOKS_PATH))!) as {
      hooks: Record<string, unknown>;
    };

    const emitted = Object.keys(config.hooks).map((key) => {
      const event = producible[key];
      if (!event) throw new Error(`unmapped Codex hook key ${key}`);
      return event;
    });
    const hooks = plugin.capabilities.hooks;
    const declared = hooks.kind === 'none' ? [] : hooks.supportedEvents;

    expect([...declared].sort()).toEqual([...new Set(emitted)].sort());
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

  it('refuses to install hooks over an unparseable hooks file', async () => {
    // Rewriting from scratch would silently discard every hook the user has
    // configured, so a file we cannot parse must stop the install.
    const fs = createMemoryFs({ [CODEX_HOOKS_PATH]: '{ not json' });

    await expect(buildCodexHookConfig().writeHooks(fs, [])).rejects.toThrow(/not valid JSON/);
    expect(await fs.read(CODEX_HOOKS_PATH)).toBe('{ not json');
  });

  it('refuses to delete hooks from an unparseable hooks file', async () => {
    const fs = createMemoryFs({ [CODEX_HOOKS_PATH]: '{ not json' });

    await expect(buildCodexHookConfig().deleteHooks(fs)).rejects.toThrow(/not valid JSON/);
    expect(await fs.read(CODEX_HOOKS_PATH)).toBe('{ not json');
  });

  it('propagates a failed hooks-file read instead of rewriting from scratch', async () => {
    const fs = createMemoryFs();
    fs.read = async () => {
      throw new Error('transport failure');
    };

    await expect(buildCodexHookConfig().writeHooks(fs, [])).rejects.toThrow('transport failure');
  });
});

describe('the installed Codex hook commands actually post', () => {
  // Codex runs each command as `$SHELL -lc "<command>"` and writes the event
  // JSON to its stdin. These commands resolve their endpoint in shell, so
  // asserting on the string only proves the text is present — a command that
  // resolves an empty port, or never reads the payload, passes a string check
  // and then fails silently behind curl's `|| true`.
  const ENV = {
    SWITCHDASH_HOOK_PORT: '5001',
    SWITCHDASH_HOOK_TOKEN: 'env-token',
    SWITCHDASH_PTY_ID: 'codex:s1',
  };

  it.each(['SessionStart'])(
    'the %s command reaches the hook server with the payload intact',
    async (event) => {
      const payload = JSON.stringify({ session_id: 's1' });
      const { url, body } = await runHookCommand((await installedCommands())[event], {
        env: ENV,
        stdin: payload,
      });

      expect(url).toBe('http://127.0.0.1:5001/hook');
      expect(body).toBe(payload);
    }
  );

  it.each(['Stop', 'PermissionRequest'])(
    'the %s command reaches the hook server with its fixed body',
    async (event) => {
      const { url } = await runHookCommand((await installedCommands())[event], {
        env: ENV,
        stdin: '',
      });

      expect(url).toBe('http://127.0.0.1:5001/hook');
    }
  );

  it('prefers the sidecar endpoint file over the baked-in env, for every event', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codex-ep-'));
    const endpointFile = path.join(dir, 'endpoint');
    await writeFile(endpointFile, '6002\nfresh-token\n');

    try {
      for (const command of Object.values(await installedCommands())) {
        const { url } = await runHookCommand(command, {
          env: { ...ENV, SWITCHDASH_HOOK_ENDPOINT_FILE: endpointFile },
          stdin: '{}',
        });
        expect(url).toBe('http://127.0.0.1:6002/hook');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
