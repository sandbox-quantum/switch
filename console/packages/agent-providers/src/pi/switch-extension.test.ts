import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  PI_APPROVAL_OPTIONS,
  PI_APPROVAL_STATUS,
  PI_SWITCH_EXTENSION,
  type PiExtensionConfig,
} from './switch-extension';

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
interface Extension {
  default: (pi: unknown) => void;
  asks: (config: PiExtensionConfig, toolName: string) => boolean;
}

let dir: string;
let extension: Extension;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-extension-test-'));
  const file = join(dir, 'switch-extension.mjs');
  await writeFile(file, PI_SWITCH_EXTENSION);
  extension = (await import(pathToFileURL(file).href)) as Extension;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const config = (runtimeMode: PiExtensionConfig['runtimeMode']): PiExtensionConfig => ({
  runtimeMode,
  mcpServers: {
    switch: { url: 'http://127.0.0.1:4100/mcp', headers: { Authorization: 'Bearer synthetic' } },
    'jira-cloud': { url: 'http://127.0.0.1:4200/mcp', headers: {} },
  },
  autoApproved: ['switch'],
});

async function load(runtimeMode: PiExtensionConfig['runtimeMode'], answer: string | undefined) {
  const path = join(dir, `${runtimeMode}.json`);
  await writeFile(path, JSON.stringify(config(runtimeMode)));
  process.env.SWITCH_PI_CONFIG = path;
  const servers: Array<[string, unknown]> = [];
  const handlers = new Map<string, Handler>();
  extension.default({
    registerMcpServer: (name: string, server: unknown) => servers.push([name, server]),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  });
  const ui: Array<[string, ...unknown[]]> = [];
  const ctx = {
    ui: {
      setStatus: (...args: unknown[]) => ui.push(['setStatus', ...args]),
      select: async (...args: unknown[]) => {
        ui.push(['select', ...args]);
        return answer;
      },
    },
  };
  const call = (toolName: string, input: Record<string, unknown> = {}) =>
    handlers.get('tool_call')!({ toolName, toolCallId: `${toolName}-1`, input }, ctx);
  return { servers, ui, call };
}

it('registers the session MCP servers with their tools declared to the model', async () => {
  const { servers } = await load('approval-required', PI_APPROVAL_OPTIONS.accept);
  expect(servers).toEqual([
    [
      'switch',
      {
        url: 'http://127.0.0.1:4100/mcp',
        headers: { Authorization: 'Bearer synthetic' },
        exposure: 'direct',
      },
    ],
    ['jira-cloud', { url: 'http://127.0.0.1:4200/mcp', headers: {}, exposure: 'direct' }],
  ]);
});

it('asks by runtime mode, never for reads or the session’s own MCP tools', () => {
  const asked = (mode: PiExtensionConfig['runtimeMode']) =>
    [
      'read',
      'grep',
      'bash',
      'edit',
      'write',
      'mcp__switch__send_message',
      'mcp__jira_cloud__search',
      'codemode',
      'custom_tool',
    ].filter((tool) => extension.asks(config(mode), tool));
  const asking = ['bash', 'edit', 'write', 'mcp__jira_cloud__search', 'codemode', 'custom_tool'];
  expect(asked('approval-required')).toEqual(asking);
  expect(asked('auto')).toEqual(asking);
  expect(asked('auto-accept-edits')).toEqual([
    'bash',
    'mcp__jira_cloud__search',
    'codemode',
    'custom_tool',
  ]);
  expect(asked('full-access')).toEqual([]);
});

it('says which tool call the dialog is about, then lets an allowed call run', async () => {
  const { ui, call } = await load('approval-required', PI_APPROVAL_OPTIONS.accept);
  await expect(call('bash', { command: 'ls' })).resolves.toBeUndefined();
  expect(ui).toEqual([
    [
      'setStatus',
      PI_APPROVAL_STATUS,
      JSON.stringify({ toolCallId: 'bash-1', toolName: 'bash', input: { command: 'ls' } }),
    ],
    ['select', 'Allow bash?', Object.values(PI_APPROVAL_OPTIONS)],
    ['setStatus', PI_APPROVAL_STATUS, undefined],
  ]);
});

it('blocks a declined or cancelled call', async () => {
  await expect(
    (await load('approval-required', PI_APPROVAL_OPTIONS.decline)).call('bash')
  ).resolves.toEqual({
    block: true,
    reason: 'The user declined this tool call.',
  });
  await expect((await load('approval-required', undefined)).call('bash')).resolves.toMatchObject({
    block: true,
  });
});

it('remembers a tool allowed for the session', async () => {
  const { ui, call } = await load('approval-required', PI_APPROVAL_OPTIONS.acceptForSession);
  await call('edit', { path: 'a.ts' });
  await call('edit', { path: 'b.ts' });
  expect(ui.filter(([method]) => method === 'select')).toHaveLength(1);
});
