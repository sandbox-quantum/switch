import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { snapshotSchema } from '@switch-console/shared/session-v1';
import { expect, it } from 'vitest';
import { prepareGeminiHome } from '../gemini/home';
import { HostConnection } from './client';
import { startHostServer } from './server';

it
  .skipIf(process.env.SDK_HOST_LIVE !== '1')
  .each(['claude', 'codex', 'opencode', 'gemini', 'cursor'] as const)(
  'runs %s chat, tools, deduplication and persistent resume through HTTP',
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), `sdk-host-${provider}-`));
    const cwd = await mkdtemp(join(tmpdir(), 'sdk-host-work-'));
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM'])
      if (process.env[key]) env[key] = process.env[key]!;
    if (provider === 'gemini')
      env.GEMINI_CLI_HOME = await prepareGeminiHome({
        root,
        sessionId: 'gemini-home',
        sourceHome: join(homedir(), '.gemini'),
        context: '',
        mcpServerNames: [],
      });
    if (provider === 'codex') {
      env.CODEX_HOME = await mkdtemp(join(tmpdir(), 'sdk-host-codex-auth-'));
      await copyFile(join(homedir(), '.codex/auth.json'), join(env.CODEX_HOME, 'auth.json'));
      await writeFile(join(env.CODEX_HOME, 'config.toml'), '');
    }
    let server = await startHostServer(root);
    const sessionId = randomUUID();
    let client = new HostConnection(server.endpoint);
    const get = async () => snapshotSchema.parse(await client.snapshot(sessionId, null));
    const completed = async (turnId: string) => {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const snapshot = await get();
        const turn = snapshot.turns.find((t) => t.turnId === turnId);
        if (turn && ['completed', 'error', 'interrupted'].includes(turn.status)) {
          expect(turn.status).toBe('completed');
          return snapshot;
        }
        if (snapshot.session.status === 'error')
          throw new Error(
            JSON.stringify(
              await client
                .request(`/sessions/${sessionId}/events?after=0`)
                .then((batch) =>
                  (batch as { events: Array<{ body: { type: string; message?: string } }> }).events
                    .filter((e) => e.body.type === 'notice')
                    .map((e) => e.body.message)
                )
            )
          );
        await delay(100);
      }
      throw new Error(`${provider} turn timed out`);
    };
    try {
      await client.start({
        provider,
        input: {
          sessionId,
          cwd,
          env,
          runtimeMode: 'full-access',
          mcpServers: {},
          ...(provider === 'claude' ? { model: { id: 'claude-sonnet-5' } } : {}),
          ...(provider === 'opencode' ? { model: { id: 'opencode/big-pickle' } } : {}),
        },
      });
      await expect.poll(async () => (await get()).session.status, { timeout: 20000 }).toBe('ready');
      const initial = await get();
      console.info(
        `${provider}: ${initial.session.models?.length ?? 0} models, compact=${initial.session.capabilities.compact}`
      );
      const command = {
        contractVersion: 1 as const,
        sessionId,
        epoch: initial.session.epoch,
        commandId: randomUUID(),
        body: {
          type: 'message.send' as const,
          text: 'Remember the word pelican. Use a tool to write the text pelican into marker.txt in the current directory. Then reply with pelican.',
          delivery: 'queue' as const,
          attachments: [],
        },
      };
      expect((await client.submit(command)).status).toBe('applied');
      await client.submit(command);
      const first = await completed(command.commandId);
      expect(first.items.filter((i) => i.kind === 'user-message')).toHaveLength(1);
      expect(
        first.items.some((i) => i.kind === 'tool-activity'),
        JSON.stringify(first.items)
      ).toBe(true);
      expect(
        first.items
          .filter((i) => i.kind === 'assistant-message')
          .map((i) => i.text)
          .join(' ')
      ).toMatch(/pelican/i);
      expect(await readFile(join(cwd, 'marker.txt'), 'utf8')).toMatch(/pelican/);
      const reconnected = new HostConnection(server.endpoint);
      expect(snapshotSchema.parse(await reconnected.snapshot(sessionId, null)).items).toEqual(
        first.items
      );
      await server.close();
      server = await startHostServer(root);
      client = new HostConnection(server.endpoint);
      await expect
        .poll(
          async () => {
            try {
              return (await get()).session.status;
            } catch {
              return 'recovering';
            }
          },
          { timeout: 40000 }
        )
        .toBe('ready');
      const resumed = await get();
      expect(resumed.items).toEqual(first.items);
      expect(resumed.session.epoch).not.toBe(initial.session.epoch);
      const followup = {
        ...command,
        commandId: randomUUID(),
        epoch: resumed.session.epoch,
        body: {
          ...command.body,
          text: 'What word did I ask you to remember? Reply only with that word, without using tools.',
        },
      };
      await client.submit(followup);
      const second = await completed(followup.commandId);
      expect(
        second.items
          .filter((i) => i.turnId === followup.commandId && i.kind === 'assistant-message')
          .map((i) => i.text)
          .join(' ')
      ).toMatch(/pelican/i);
      if (process.env.SDK_CAPABILITIES_LIVE === '1') {
        const current = await get();
        expect(current.session.capabilities.modelChange).toBe(true);
        expect(current.session.capabilities.compact).toBe(['claude', 'codex', 'opencode'].includes(provider));
        const choice =
          current.session.models?.find((model) => model.id === current.session.model?.id) ??
          current.session.models?.find((model) => /sonnet|big-pickle/.test(model.id)) ??
          current.session.models?.[0];
        if (choice) {
          const change = {
            ...command,
            epoch: current.session.epoch,
            commandId: randomUUID(),
            body: { type: 'session.model.set' as const, modelId: choice.id, options: {} },
          };
          expect((await client.submit(change)).status).toBe('applied');
          expect((await get()).session.model?.id).toBe(choice.id);
        }
        if (current.session.capabilities.compact) {
          const compact = {
            ...command,
            epoch: current.session.epoch,
            commandId: randomUUID(),
            body: { type: 'session.compact' as const },
          };
          const result = await client.submit(compact);
          console.info(`${provider}: native compaction ${result.status}: ${result.message ?? ''}`);
          expect(result.status).toBe('applied');
          expect((await client.submit(compact)).status).toBe('applied');
        }
        const beforeReset = await get();
        const reset = {
          ...command,
          epoch: beforeReset.session.epoch,
          commandId: randomUUID(),
          body: { type: 'session.reset' as const },
        };
        expect((await client.submit(reset)).status).toBe('applied');
        const fresh = await get();
        expect(fresh.session.epoch).not.toBe(beforeReset.session.epoch);
        expect(fresh.items).toEqual(beforeReset.items);
        expect((await client.submit(reset)).status).toBe('applied');
        const nextTurn = {
          ...followup,
          epoch: fresh.session.epoch,
          commandId: randomUUID(),
          body: { ...followup.body, text: 'Reply NEW_CONTEXT_READY without using tools.' },
        };
        await client.submit(nextTurn);
        await completed(nextTurn.commandId);
        console.info(`${provider}: model selection and native reset passed`);
      }
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      if (env.CODEX_HOME) await rm(env.CODEX_HOME, { recursive: true, force: true });
    }
  },
  300000
);
