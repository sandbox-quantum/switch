import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acpInitialize, checkAcpSignIn } from '../acp/acp-adapter';
import type { AcpSessionResult } from '../acp/protocol';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';
import { gooseAcp } from './goose-acp';

const probe = spawnSync('goose', ['--version'], { encoding: 'utf8', timeout: 15_000 });
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!!probe.error || probe.status !== 0)('Goose CLI without inference', () => {
  async function input(config = '', extra: Record<string, string> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'switch-goose-cli-'));
    roots.push(root);
    await mkdir(join(root, 'config'));
    if (config) await writeFile(join(root, 'config', 'config.yaml'), config);
    return {
      binaryPath: 'goose',
      cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: root, GOOSE_PATH_ROOT: root, ...extra },
    };
  }

  it.each([
    ['', {}, 'unconfigured'],
    ['', { GOOSE_PROVIDER: 'ollama', GOOSE_MODEL: 'example-model' }, 'authenticated'],
    ['GOOSE_PROVIDER: ollama\nGOOSE_MODEL: example-model\n', {}, 'authenticated'],
    [
      'active_provider: ollama\nproviders:\n  ollama:\n    model: example-model\n',
      {},
      'authenticated',
    ],
  ] as const)(
    'reads resolved configuration without a model call: %j',
    async (config, env, status) => {
      expect(await checkAcpSignIn(gooseAcp, await input(config, env))).toMatchObject({ status });
    }
  );

  it('accepts every mapped mode through session/set_mode', async () => {
    const launchInput = await input('', { GOOSE_PROVIDER: 'ollama', GOOSE_MODEL: 'example-model' });
    const client = new StdioJsonRpcClient({
      ...(await gooseAcp.launch(launchInput)),
      cwd: launchInput.cwd,
      logger: noopLogger,
      onExit: () => {},
    });
    try {
      const initialized = await acpInitialize(client);
      expect(initialized.agentInfo?.name).toBe('goose');
      const session = await client.request<AcpSessionResult>('session/new', {
        cwd: launchInput.cwd,
        mcpServers: [],
      });
      expect(session.modes?.currentModeId).toBe('approve');
      for (const mode of [
        'approval-required',
        'auto-accept-edits',
        'auto',
        'full-access',
      ] as const) {
        const modeId = gooseAcp.sessionMode!(mode);
        expect(session.modes?.availableModes.some((available) => available.id === modeId)).toBe(
          true
        );
        await expect(
          client.request('session/set_mode', { sessionId: session.sessionId, modeId })
        ).resolves.toEqual({});
      }
    } finally {
      await client.dispose();
    }
  });
});
