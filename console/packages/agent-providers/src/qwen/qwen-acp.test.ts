import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpSelectedAnswer, AcpSessionContext } from '../acp/hooks';
import type { AcpPermissionRequest } from '../acp/protocol';
import type { UserInputQuestion } from '../events';
import { qwenAcp, qwenHome } from './qwen-acp';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

/** A home directory whose `.qwen` holds `settings` and, optionally, a `.env`. */
async function home(settings?: unknown, dotenv?: string) {
  const root = await mkdtemp(join(tmpdir(), 'switch-qwen-'));
  directories.push(root);
  await mkdir(join(root, '.qwen'));
  if (settings !== undefined)
    await writeFile(
      join(root, '.qwen', 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings)
    );
  if (dotenv !== undefined) await writeFile(join(root, '.qwen', '.env'), dotenv);
  return { HOME: root, USERPROFILE: root };
}

async function check(env: Record<string, string>) {
  const handshake = vi.fn();
  const result = await qwenAcp.checkSignIn!({ binaryPath: 'qwen', cwd: '.', env, handshake });
  expect(handshake).not.toHaveBeenCalled();
  return result;
}

const openai = { security: { auth: { selectedType: 'openai' } } };

describe('Qwen Code ACP hooks', () => {
  it('starts ACP mode with exactly the supplied environment and never authenticates', async () => {
    const env = { OPENAI_API_KEY: 'placeholder' };
    expect(await qwenAcp.launch({ binaryPath: '/tools/qwen', cwd: '.', env })).toEqual({
      command: '/tools/qwen',
      args: ['--acp'],
      env,
    });
    expect(qwenAcp.authMethodId).toBeUndefined();
  });

  it.each([
    ['approval-required', 'default'],
    ['auto-accept-edits', 'auto-edit'],
    ['auto', 'auto'],
    ['full-access', 'yolo'],
  ] as const)('puts %s sessions in Qwen mode %s', (mode, expected) => {
    expect(qwenAcp.sessionMode!(mode)).toBe(expected);
  });

  describe('sign-in', () => {
    it('reports a machine where no provider was chosen as unconfigured', async () => {
      expect((await check(await home())).status).toBe('unconfigured');
      expect((await check(await home({ model: { name: 'qwen3' } }))).status).toBe('unconfigured');
    });

    it('does not count the discontinued Qwen OAuth as signed in', async () => {
      const result = await check(
        await home({ security: { auth: { selectedType: 'qwen-oauth' } } })
      );
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain('/auth');
    });

    it('names the key a chosen provider is missing', async () => {
      const result = await check(await home(openai));
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain('OPENAI_API_KEY');
    });

    it.each([
      ['the environment', openai, undefined, { OPENAI_API_KEY: 'placeholder' }],
      ['the settings env', { ...openai, env: { OPENAI_API_KEY: 'placeholder' } }, undefined, {}],
      [
        'security.auth.apiKey',
        { security: { auth: { selectedType: 'openai', apiKey: 'placeholder' } } },
        undefined,
        {},
      ],
      ['a user-level .env', openai, 'export OPENAI_API_KEY="placeholder"\n', {}],
      [
        "the model provider's own key",
        {
          ...openai,
          model: { name: 'qwen3-coder-plus' },
          modelProviders: {
            openai: [{ id: 'qwen3-coder-plus', envKey: 'BAILIAN_CODING_PLAN_API_KEY' }],
          },
        },
        undefined,
        { BAILIAN_CODING_PLAN_API_KEY: 'placeholder' },
      ],
    ])('finds the key in %s', async (_where, settings, dotenv, extra) => {
      expect((await check({ ...(await home(settings, dotenv)), ...extra })).status).toBe(
        'authenticated'
      );
    });

    it('reads only the key a model provider names, as Qwen does', async () => {
      const settings = {
        security: { auth: { selectedType: 'openai', apiKey: 'placeholder' } },
        model: { name: 'qwen3-coder-plus' },
        modelProviders: {
          openai: [{ id: 'qwen3-coder-plus', envKey: 'BAILIAN_CODING_PLAN_API_KEY' }],
        },
      };
      const result = await check({ ...(await home(settings)), OPENAI_API_KEY: 'placeholder' });
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain('BAILIAN_CODING_PLAN_API_KEY');
    });

    it('ignores an empty key and a commented-out one', async () => {
      const env = await home(openai, '# OPENAI_API_KEY=placeholder\nOPENAI_API_KEY=\n');
      expect((await check({ ...env, OPENAI_API_KEY: ' ' })).status).toBe('unauthenticated');
    });

    it('reads settings written with comments', async () => {
      const settings = `{
        // chosen with /auth
        "security": { "auth": { "selectedType": "openai" } },
      }`;
      expect(
        (await check({ ...(await home(settings)), OPENAI_API_KEY: 'placeholder' })).status
      ).toBe('authenticated');
    });

    it.each([
      ['a wrong shape', { security: { auth: { selectedType: 7 } } }],
      ['broken JSON', '{ "security": { "auth": { "selectedType": "secret-shape" '],
    ])('reports settings with %s as unknown, without their contents', async (_what, settings) => {
      const result = await check(await home(settings));
      expect(result.status).toBe('unknown');
      expect(result.message).not.toMatch(/7|secret-shape/);
    });

    it('reads the profile QWEN_HOME names', async () => {
      const env = await home();
      const profile = join(env.HOME, 'other');
      await mkdir(profile);
      await writeFile(join(profile, 'settings.json'), JSON.stringify(openai));
      expect(
        (await check({ ...env, QWEN_HOME: profile, OPENAI_API_KEY: 'placeholder' })).status
      ).toBe('authenticated');
    });
  });

  it('resolves QWEN_HOME as Qwen does', () => {
    const env = { HOME: '/home/ada' };
    expect(qwenHome(env, '/work')).toBe(join('/home/ada', '.qwen'));
    expect(qwenHome({ ...env, QWEN_HOME: '~/profiles/qwen' }, '/work')).toBe(
      join('/home/ada', 'profiles/qwen')
    );
    expect(qwenHome({ ...env, QWEN_HOME: 'qwen-profile' }, '/work')).toBe(
      resolve('/work', 'qwen-profile')
    );
  });

  it('reads the MCP server from the tool name Qwen gives it', () => {
    const tool = (toolName: unknown) => ({ toolCallId: 'call', _meta: { toolName } });
    expect(qwenAcp.mcpServerOf!(tool('mcp__echo__echo'))).toBe('echo');
    expect(qwenAcp.mcpServerOf!(tool('mcp__switch__send_message'))).toBe('switch');
    expect(qwenAcp.mcpServerOf!(tool('run_shell_command'))).toBeUndefined();
    expect(qwenAcp.mcpServerOf!(tool(3))).toBeUndefined();
    expect(qwenAcp.mcpServerOf!({ toolCallId: 'call', title: 'mcp__echo__echo' })).toBeUndefined();
  });

  it('types the agent tool as a subagent', () => {
    expect(qwenAcp.itemType!({ toolCallId: 'call', _meta: { toolName: 'agent' } })).toBe(
      'subagent'
    );
    expect(qwenAcp.itemType!({ toolCallId: 'call', title: 'agent' })).toBeUndefined();
  });

  describe('questions', () => {
    const options = [
      { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
    ];

    function questionRequest(questions: unknown, offered = options): AcpPermissionRequest {
      return {
        sessionId: 'session',
        toolCall: {
          toolCallId: 'call',
          title: 'ask_user_question',
          _meta: {
            toolName: 'ask_user_question',
            qwenInteractionKind: 'user_question',
            qwenQuestions: questions,
          },
        },
        options: offered,
      };
    }

    function context(selected: AcpSelectedAnswer[]) {
      let asked: UserInputQuestion[] = [];
      const ctx = {
        askQuestions: vi.fn(
          async (questions: UserInputQuestion[], answer: (s: AcpSelectedAnswer[]) => unknown) => {
            asked = questions;
            return answer(selected);
          }
        ),
      } as unknown as AcpSessionContext;
      return { ctx, asked: () => asked };
    }

    it('asks the questions and answers with the chosen labels, keyed by index', async () => {
      const { ctx, asked } = context([
        { questionId: '0', values: ['Vitest'] },
        { questionId: '1', values: ['Lint', 'Types'] },
      ]);
      const answer = await qwenAcp.permission!(
        ctx,
        questionRequest([
          {
            question: 'Which test runner?',
            header: 'Runner',
            options: [{ label: 'Vitest', description: 'Fast' }, { label: 'Jest' }],
          },
          {
            question: 'Which checks?',
            header: 'Checks',
            options: [{ label: 'Lint' }, { label: 'Types' }],
            multiSelect: true,
          },
        ])
      );
      expect(asked()).toEqual([
        {
          id: '0',
          header: 'Runner',
          question: 'Which test runner?',
          options: [
            { label: 'Vitest', value: 'Vitest', description: 'Fast' },
            { label: 'Jest', value: 'Jest' },
          ],
          multiSelect: false,
          allowCustomAnswer: false,
        },
        {
          id: '1',
          header: 'Checks',
          question: 'Which checks?',
          options: [
            { label: 'Lint', value: 'Lint' },
            { label: 'Types', value: 'Types' },
          ],
          multiSelect: true,
          allowCustomAnswer: false,
        },
      ]);
      expect(answer).toEqual({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Vitest', '1': 'Lint, Types' },
      });
    });

    it('cancels a question it cannot submit', async () => {
      const { ctx } = context([]);
      const declined = [{ optionId: 'cancel', name: 'Cancel', kind: 'reject_once' }];
      expect(await qwenAcp.permission!(ctx, questionRequest([], declined))).toEqual({
        outcome: { outcome: 'cancelled' },
      });
      expect(ctx.askQuestions).not.toHaveBeenCalled();
    });

    it('leaves a tool permission to the adapter', () => {
      const { ctx } = context([]);
      expect(
        qwenAcp.permission!(ctx, {
          sessionId: 'session',
          toolCall: {
            toolCallId: 'call',
            kind: 'execute',
            _meta: { toolName: 'run_shell_command' },
          },
          options,
        })
      ).toBeUndefined();
    });

    it('never offers an approval Qwen would save as a rule', () => {
      const { ctx } = context([]);
      const request: AcpPermissionRequest = {
        sessionId: 'session',
        toolCall: { toolCallId: 'call', kind: 'execute', _meta: { toolName: 'run_shell_command' } },
        // Qwen 0.26.5's options for a shell command.
        options: [
          {
            optionId: 'proceed_always_project',
            name: 'Always Allow in project: ls',
            kind: 'allow_always',
          },
          {
            optionId: 'proceed_always_user',
            name: 'Always Allow for user: ls',
            kind: 'allow_always',
          },
          { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
        ],
      };
      expect(qwenAcp.permission!(ctx, request)).toBeUndefined();
      expect(request.options.map((option) => option.optionId)).toEqual(['proceed_once', 'cancel']);
    });
  });
});
