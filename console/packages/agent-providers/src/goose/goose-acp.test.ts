import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpSessionContext } from '../acp/hooks';
import type { AcpInitializeResult, AcpToolCall } from '../acp/protocol';
import { gooseAcp, gooseConfigDirectory } from './goose-acp';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function profile(contents?: string) {
  const root = await mkdtemp(join(tmpdir(), 'switch-goose-'));
  directories.push(root);
  await mkdir(join(root, 'config'));
  if (contents !== undefined) await writeFile(join(root, 'config', 'config.yaml'), contents);
  return { GOOSE_PATH_ROOT: root };
}

async function check(
  env: Record<string, string>,
  handshake = vi.fn(async (): Promise<AcpInitializeResult> => ({
    agentInfo: { name: 'goose', version: '1.57.0' },
  }))
) {
  const result = await gooseAcp.checkSignIn!({ binaryPath: 'goose', cwd: '.', env, handshake });
  expect(handshake).toHaveBeenCalledTimes(1);
  return result;
}

describe('Goose ACP hooks', () => {
  it('starts ACP with supervised defaults and exactly the supplied environment', async () => {
    const env = { GOOGLE_API_KEY: 'placeholder', GOOSE_MODE: 'auto' };
    expect(await gooseAcp.launch({ binaryPath: '/tools/goose', cwd: '.', env })).toEqual({
      command: '/tools/goose',
      args: ['acp'],
      env: { ...env, GOOSE_MODE: 'approve', GOOSE_DISABLE_SESSION_NAMING: 'true' },
    });
    expect(env.GOOSE_MODE).toBe('auto');
    expect(gooseAcp.authMethodId).toBeUndefined();
  });

  it('leaves session naming to the machine when it sets it', async () => {
    const env = { GOOSE_DISABLE_SESSION_NAMING: 'false' };
    expect(
      (await gooseAcp.launch({ binaryPath: 'goose', cwd: '.', env })).env
        .GOOSE_DISABLE_SESSION_NAMING
    ).toBe('false');
  });

  it.each([
    ['approval-required', 'approve'],
    ['auto-accept-edits', 'approve'],
    ['auto', 'smart_approve'],
    ['full-access', 'auto'],
  ] as const)('maps %s to %s', (mode, expected) => {
    expect(gooseAcp.sessionMode!(mode)).toBe(expected);
  });

  it('recognizes environment configuration without reading the profile', async () => {
    expect(
      (await check({ GOOSE_PROVIDER: 'google', GOOSE_MODEL: 'gemini-2.5-flash' })).status
    ).toBe('authenticated');
  });

  it.each([
    'GOOSE_PROVIDER: google\nGOOSE_MODEL: gemini-2.5-flash\n',
    'active_provider: google\nproviders:\n  google:\n    model: gemini-2.5-flash\n',
  ])('recognizes saved provider configuration', async (contents) => {
    expect((await check(await profile(contents))).status).toBe('authenticated');
  });

  it('combines an environment provider with a saved model', async () => {
    expect(
      (
        await check({
          ...(await profile('GOOSE_MODEL: gemini-2.5-flash\n')),
          GOOSE_PROVIDER: 'google',
        })
      ).status
    ).toBe('authenticated');
  });

  it.each([
    undefined,
    '',
    '# no settings yet\n',
    'GOOSE_PROVIDER: google\n',
    'GOOSE_PROVIDER: " "\nGOOSE_MODEL: model\n',
  ])('reports incomplete configuration without starting a login', async (contents) => {
    expect((await check(await profile(contents))).status).toBe('unconfigured');
  });

  it.each([
    [
      'a goose that is not an ACP agent',
      () => Promise.reject(new Error('provider process exited')),
    ],
    ['another ACP agent', async () => ({ agentInfo: { name: 'other' } })],
  ])('does not take %s for Goose', async (_case, answer) => {
    const env = { GOOSE_PROVIDER: 'google', GOOSE_MODEL: 'gemini-2.5-flash' };
    const result = await check(env, vi.fn(answer));
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('pressly/goose');
  });

  it('reports unreadable configuration without including its contents', async () => {
    const result = await check(await profile('GOOSE_PROVIDER: [invalid'));
    expect(result.status).toBe('unknown');
    expect(result.message).not.toContain('[invalid');
  });

  it('uses the execution host profile on each platform', () => {
    expect(gooseConfigDirectory({ HOME: '/home/example' }, 'linux')).toBe(
      join('/home/example', '.config', 'goose')
    );
    expect(
      gooseConfigDirectory({ HOME: '/home/example', XDG_CONFIG_HOME: '/settings' }, 'linux')
    ).toBe(join('/settings', 'goose'));
    expect(gooseConfigDirectory({ HOME: '/Users/example' }, 'darwin')).toBe(
      join('/Users/example', 'Library', 'Application Support', 'Block', 'goose')
    );
    expect(gooseConfigDirectory({ APPDATA: '/roaming' }, 'win32')).toBe(
      join('/roaming', 'Block', 'goose', 'config')
    );
  });

  it('reads MCP server identity only from Goose tool metadata', () => {
    expect(
      gooseAcp.mcpServerOf!({
        toolCallId: 'call',
        _meta: { goose: { toolCall: { extensionName: 'echo' } } },
      })
    ).toBe('echo');
    expect(gooseAcp.mcpServerOf!({ toolCallId: 'call', title: 'echo: run' })).toBeUndefined();
    expect(
      gooseAcp.mcpServerOf!({
        toolCallId: 'call',
        _meta: { goose: { toolCall: { extensionName: 1 } } },
      })
    ).toBeUndefined();
  });

  it.each(['developer', 'summon', 'Extension Manager'])(
    'does not take the built-in %s extension for an MCP server',
    (extensionName) => {
      expect(gooseAcp.mcpServerOf!(tool('shell', extensionName))).toBeUndefined();
    }
  );

  it.each([
    ['shell', 'command_execution'],
    ['write', 'file_change'],
    ['edit', 'file_change'],
  ] as const)('types the developer %s tool as %s', (toolName, type) => {
    expect(gooseAcp.itemType!(tool(toolName, 'developer'))).toBe(type);
    expect(gooseAcp.itemType!(tool(toolName, 'echo'))).toBeUndefined();
  });

  it('identifies delegation from Goose metadata without matching prose titles', () => {
    expect(gooseAcp.itemType!(tool('delegate', 'summon'))).toBe('subagent');
    expect(gooseAcp.itemType!(tool('delegate', 'echo'))).toBeUndefined();
    expect(gooseAcp.itemType!({ toolCallId: 'call', title: 'Delegate this task' })).toBeUndefined();
  });

  it.each([
    ['shell · echo hi', 'execute'],
    ['write · notes.txt', 'edit'],
    ['edit · src/index.ts', 'edit'],
    ['echo: write · notes.txt', undefined],
    ['constructor · x', undefined],
  ])('gives the permission request for %s the kind %s', (title, kind) => {
    const request = {
      sessionId: 'session',
      toolCall: { toolCallId: 'call', title, kind: 'other' },
      options: [],
    };
    expect(gooseAcp.permission!({} as AcpSessionContext, request)).toBeUndefined();
    expect(request.toolCall.kind).toBe(kind ?? 'other');
  });

  it('never offers what Goose would save for good, and names the rest', () => {
    // Goose's options, as `goose acp` 1.57.0 sends them.
    const option = (kind: string) => ({ optionId: kind, name: kind, kind });
    const request = {
      sessionId: 'session',
      toolCall: { toolCallId: 'call', title: 'shell · ls' },
      options: ['allow_always', 'allow_once', 'reject_once', 'reject_always'].map(option),
    };
    gooseAcp.permission!({} as AcpSessionContext, request);
    expect(request.options).toEqual([
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ]);
  });
});

function tool(toolName: string, extensionName: string): AcpToolCall {
  return { toolCallId: 'call', _meta: { goose: { toolCall: { toolName, extensionName } } } };
}
