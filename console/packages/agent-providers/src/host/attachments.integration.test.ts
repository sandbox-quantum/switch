import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment, Session } from '@switch-console/shared/session-v1';
import { expect, it } from 'vitest';
import { prepareGeminiHome } from '../gemini/home';
import { echoMcpServerSpec } from '../testing/fixtures';
import { stageAttachment } from './attachments';
import { adapterFor } from './server';
import { HostedSession } from './session-host';

it
  .skipIf(process.env.SDK_ATTACHMENTS_LIVE !== '1')
  .each(['claude', 'codex', 'opencode', 'gemini', 'cursor'] as const)(
  'delivers real file bytes, a project skill and MCP to %s',
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-attachment-live-'));
    const cwd = join(root, 'work');
    const sessionId = randomUUID();
    const token = `FILE_${randomUUID().replaceAll('-', '')}`;
    const skillToken = `SKILL_${randomUUID().replaceAll('-', '')}`;
    const data = Buffer.from(token);
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC',
      'base64'
    );
    const picture: Attachment = {
      attachmentId: randomUUID(),
      name: 'color.png',
      mimeType: 'image/png',
      bytes: image.length,
    };
    const attachment: Attachment = {
      attachmentId: randomUUID(),
      name: 'report.txt',
      mimeType: 'text/plain',
      bytes: data.length,
    };
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM'])
      if (process.env[key]) env[key] = process.env[key]!;
    await mkdir(cwd);
    const skillDirectory = {
      claude: '.claude',
      codex: '.agents',
      opencode: '.opencode',
      gemini: '.gemini',
      cursor: '.cursor',
    }[provider];
    const skill = join(cwd, skillDirectory, 'skills/sdk-verification');
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      `---\nname: sdk-verification\ndescription: Verify attached documents using the echo tool.\n---\nRead the attached document. Invoke the switch_echo MCP tool with its contents. Include ${skillToken} in your final response.\n`
    );
    if (provider === 'gemini')
      env.GEMINI_CLI_HOME = await prepareGeminiHome({
        root,
        sessionId: 'home',
        sourceHome: join(homedir(), '.gemini'),
        context: '',
        mcpServerNames: ['echo'],
      });
    if (provider === 'codex') {
      env.CODEX_HOME = join(root, 'codex-home');
      await mkdir(env.CODEX_HOME);
      await copyFile(join(homedir(), '.codex/auth.json'), join(env.CODEX_HOME, 'auth.json'));
      await writeFile(join(env.CODEX_HOME, 'config.toml'), '');
    }
    const session: Session = {
      sessionId,
      agentId: 'fixture-agent',
      hostId: 'fixture-host',
      epoch: randomUUID(),
      provider,
      status: 'starting',
      connectivity: 'online',
      pendingRequestIds: [],
      capabilities: {
        input: 'queue',
        approvals: true,
        questions: true,
        interrupt: true,
        reset: true,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    };
    let host: HostedSession | undefined;
    try {
      host = await HostedSession.start(
        join(root, 'state'),
        {
          session,
          input: {
            sessionId,
            cwd,
            env,
            runtimeMode: 'full-access',
            mcpServers: { echo: echoMcpServerSpec() },
            ...(provider === 'claude' ? { model: { id: 'claude-sonnet-5' } } : {}),
            ...(provider === 'opencode' ? { model: { id: 'opencode/big-pickle' } } : {}),
          },
          stageAttachments: (attachments) =>
            Promise.all(
              attachments.map((file) =>
                stageAttachment(root, file, async () => {
                  const bytes = file.attachmentId === picture.attachmentId ? image : data;
                  return { data: bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
                })
              )
            ),
        },
        adapterFor(provider)
      );
      const command = {
        contractVersion: 1 as const,
        sessionId,
        epoch: session.epoch,
        commandId: randomUUID(),
        origin: {
          actorId: 'fixture-owner',
          surface: 'console' as const,
          roomId: null,
          threadId: null,
          messageId: null,
        },
        body: {
          type: 'message.send' as const,
          text: 'Use the sdk-verification skill to process the attached document. Follow its instructions and report both the document contents and the skill verification token. Also identify the solid color in the attached image.',
          delivery: 'queue' as const,
          attachments: [attachment, picture],
        },
      };
      const supportsImages = host
        .snapshot()
        .session.capabilities.attachmentMimeTypes.includes('image/png');
      if (!supportsImages) {
        await expect(host.command(command)).rejects.toThrow();
        command.body.attachments = [attachment];
        command.body.text =
          'Use the sdk-verification skill to process the attached document. Follow its instructions and report both the document contents and the skill verification token.';
      }
      await host.command(command);
      await host.command(command);
      await expect
        .poll(
          () => host!.snapshot().turns.find((turn) => turn.turnId === command.commandId)?.status,
          { timeout: 120000 }
        )
        .toBe('completed');
      const snapshot = host.snapshot();
      const answer = snapshot.items
        .filter((item) => item.kind === 'assistant-message')
        .map((item) => item.text)
        .join(' ');
      expect(answer).toContain(token);
      expect(answer).toContain(skillToken);
      if (supportsImages) expect(answer.toLowerCase()).toContain('red');
      expect(
        snapshot.items.some(
          (item) =>
            /echo/i.test(JSON.stringify(item)) &&
            item.kind !== 'assistant-message' &&
            item.kind !== 'user-message'
        ),
        JSON.stringify(snapshot.items)
      ).toBe(true);
      expect(snapshot.items.filter((item) => item.kind === 'user-message')).toHaveLength(1);
      expect(snapshot.items.find((item) => item.kind === 'user-message')?.attachments).toEqual(
        command.body.attachments
      );
      expect(await readFile(join(skill, 'SKILL.md'), 'utf8')).toContain(skillToken);
    } finally {
      await host?.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
  180000
);
