import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { describeConformance, echoMcpServerSpec, EventRecorder } from '../testing/index';
import { createGeminiAdapter } from './gemini-adapter';
import { prepareGeminiHome } from './home';

const home = await prepareGeminiHome({
  root: await mkdtemp(join(tmpdir(), 'switch-gemini-home-')),
  sessionId: 'conformance',
  sourceHome: join(homedir(), '.gemini'),
  context: '',
  mcpServerNames: ['echo'],
});

describeConformance('gemini', {
  createAdapter: async () => createGeminiAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('gemini', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the gemini binary is not on PATH' : null;
  },
  env: { GEMINI_CLI_HOME: home },
  mcpServers: { echo: echoMcpServerSpec() },
  skip: {
    'user-input':
      'Gemini ACP exposes permission choices, but no structured ask_user answers. Questions use conversation turns.',
    subagent:
      'Gemini subagents are experimental and are not enabled in the isolated session settings.',
  },
});

it('keeps history across two consecutive ACP resumes', async (ctx) => {
  const probe = spawnSync('gemini', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return ctx.skip('the gemini binary is not on PATH');
  const cwd = await mkdtemp(join(tmpdir(), 'gemini-repeat-resume-'));
  const env: Record<string, string> = { GEMINI_CLI_HOME: home };
  for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  let nativeId: string | undefined;
  try {
    for (let index = 0; index < 3; index++) {
      const adapter = createGeminiAdapter();
      const recorder = new EventRecorder(adapter);
      const sessionId = `repeat-${index}`;
      try {
        const session = await adapter.startSession({
          sessionId,
          cwd,
          env,
          runtimeMode: 'full-access',
          mcpServers: {},
          ...(nativeId ? { resume: { nativeSessionId: nativeId } } : {}),
        });
        nativeId = session.nativeSessionId;
        await adapter.sendTurn({
          sessionId,
          turnId: sessionId,
          text:
            index === 0
              ? 'Remember the word pelican. Reply only pelican. Do not use tools.'
              : 'What word did I ask you to remember? Reply with only that word. Do not use tools.',
        });
        const done = await recorder.waitFor('turn.completed', (e) => e.turnId === sessionId, 60000);
        expect(done.outcome).toBe('completed');
        expect(recorder.assistantText(sessionId).toLowerCase()).toContain('pelican');
      } finally {
        await adapter.stopAll();
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 180000);
