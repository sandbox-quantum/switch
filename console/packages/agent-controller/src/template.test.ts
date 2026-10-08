import { controllerConnectionId, sharedConfigSchema } from '@switch-console/agent-providers';
import { sessionLaunchConfig } from '@switch-console/plugins/agents';
import { SWITCH_SKILL_CONTEXT, SWITCH_SKILL_FILE } from '@switch-console/plugins/switch-skill';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from './schemas';
import {
  advancedConfigDefinitionProblem,
  buildWatcherTemplate,
  watcherSessionId,
} from './template';

const definition = {
  name: 'scout',
  model: null,
  advanced_config: {},
  instructions: 'Review pull requests.',
  auto_approve: false,
};

describe('buildWatcherTemplate', () => {
  it.each(PROVIDERS)('builds a configuration the shared host accepts for %s', (provider) => {
    const template = buildWatcherTemplate({
      agentId: 'agent-1',
      provider,
      definition,
      cwd: '/work/scout',
      credentialsPath: '/data/agents/agent-1/credentials.json',
      binaryPath: `/usr/bin/${provider}`,
    });
    expect(sharedConfigSchema.safeParse(template).success).toBe(true);
    expect(template.session).toMatchObject({
      sessionId: watcherSessionId('agent-1'),
      agentId: 'agent-1',
      provider,
      status: 'starting',
    });
    expect(template.start.provider).toBe(provider);
    expect(template.start.input).toMatchObject({
      sessionId: watcherSessionId('agent-1'),
      cwd: '/work/scout',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: {},
    });
    expect(template.start.input.model).toBeUndefined();
    expect(template.roomConnection).toEqual({ connectionId: controllerConnectionId('agent-1') });
    expect(template.execution).toMatchObject({
      credentialsPath: '/data/agents/agent-1/credentials.json',
      binaryPath: `/usr/bin/${provider}`,
      codexConfig: provider === 'codex' ? 'developer_instructions = "Review pull requests."\n' : '',
    });
    expect(template.execution!.inheritEnv).toEqual(
      expect.arrayContaining(['PATH', 'HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
    );
    if (provider === 'opencode') {
      expect(template.execution!.skill).toBe(SWITCH_SKILL_FILE);
      expect(template.execution!.context).toBe('Review pull requests.');
    } else {
      expect(template.execution!.skill).toBe('');
      expect(template.execution!.context).toBe(`${SWITCH_SKILL_CONTEXT}\n\nReview pull requests.`);
    }
  });

  it('runs an auto-approving agent with full access, on its model', () => {
    const template = buildWatcherTemplate({
      agentId: 'agent-1',
      provider: 'claude',
      definition: {
        name: 'scout',
        model: 'opus',
        advanced_config: {},
        instructions: '',
        auto_approve: true,
      },
      cwd: '/work/scout',
      credentialsPath: '/data/c.json',
      binaryPath: null,
    });
    expect(template.start.input.runtimeMode).toBe('full-access');
    expect(template.start.input.model).toEqual({ id: 'opus' });
    expect(template.execution).not.toHaveProperty('binaryPath');
    expect(template.execution!.context).toBe(SWITCH_SKILL_CONTEXT);
  });

  it('applies a Codex agent’s advanced configuration as Console does: model options and profile', () => {
    const advanced = {
      model: 'gpt-5.5',
      advancedConfig: { effort: 'high', verbosity: 'low', webSearch: 'true' },
    };
    const template = buildWatcherTemplate({
      agentId: 'agent-1',
      provider: 'codex',
      definition: {
        name: 'scout',
        model: advanced.model,
        advanced_config: advanced.advancedConfig,
        instructions: 'Review pull requests.',
        auto_approve: false,
      },
      cwd: '/work/scout',
      credentialsPath: '/data/c.json',
      binaryPath: null,
    });
    const console = sessionLaunchConfig({
      provider: 'codex',
      slug: 'scout',
      description: '',
      cwd: '/work/scout',
      instructions: 'Review pull requests.',
      ...advanced,
    });
    expect(template.start.input.model).toEqual({ id: 'gpt-5.5', options: { effort: 'high' } });
    expect(template.execution!.codexConfig).toBe(console.codexConfig);
    expect(template.execution!.codexConfig).toContain('model_verbosity = "low"');
    expect(template.execution!.codexConfig).toContain('web_search = true');
    expect(template.start.input).not.toHaveProperty('agentDefinition');
  });

  it('runs a Claude Code agent as the definition its advanced configuration amounts to', () => {
    const template = buildWatcherTemplate({
      agentId: 'agent-1',
      provider: 'claude',
      definition: {
        name: 'scout',
        model: 'opus',
        advanced_config: {
          tools: ['Read'],
          permissionMode: 'plan',
          maxTurns: 5,
          isolation: 'worktree',
          effort: 'max',
        },
        instructions: 'Review pull requests.',
        auto_approve: false,
      },
      cwd: '/work/scout',
      credentialsPath: '/data/c.json',
      binaryPath: null,
    });
    expect(template.start.input.model).toEqual({ id: 'opus', options: { effort: 'max' } });
    expect(template.start.input.agentName).toBe('scout');
    expect(template.start.input.agentDefinition).toEqual({
      description: 'scout',
      prompt: 'Review pull requests.',
      model: 'opus',
      tools: ['Read', 'mcp__switch'],
      permissionMode: 'plan',
      maxTurns: 5,
      effort: 'max',
    });
    expect(template.execution).not.toHaveProperty('agentDefinition');
  });

  it('gives an OpenCode agent its variant with the model', () => {
    const template = buildWatcherTemplate({
      agentId: 'agent-1',
      provider: 'opencode',
      definition: {
        name: 'scout',
        model: 'anthropic/claude-sonnet-4-5',
        advanced_config: { variant: 'high', temperature: 0.2 },
        instructions: '',
        auto_approve: false,
      },
      cwd: '/work/scout',
      credentialsPath: '/data/c.json',
      binaryPath: null,
    });
    expect(template.start.input.model).toEqual({
      id: 'anthropic/claude-sonnet-4-5',
      options: { variant: 'high' },
    });
  });

  it('advertises the adapter’s own approval and question capabilities', () => {
    const codex = buildWatcherTemplate({
      agentId: 'agent-1',
      provider: 'codex',
      definition,
      cwd: '/w',
      credentialsPath: '/c',
      binaryPath: null,
    });
    const claude = buildWatcherTemplate({
      agentId: 'agent-1',
      provider: 'claude',
      definition,
      cwd: '/w',
      credentialsPath: '/c',
      binaryPath: null,
    });
    expect(codex.session.capabilities).toMatchObject({ approvals: true, questions: false });
    expect(claude.session.capabilities).toMatchObject({ approvals: true, questions: true });
  });
});

describe('advancedConfigDefinitionProblem', () => {
  it('accepts the advanced configuration a provider offers', () => {
    expect(
      advancedConfigDefinitionProblem('opencode', {
        ...definition,
        advanced_config: { variant: 'high', maxSteps: 40, webSearch: 'false' },
      })
    ).toBeNull();
  });

  it('names a field this controller does not know for the provider', () => {
    expect(
      advancedConfigDefinitionProblem('codex', {
        ...definition,
        advanced_config: { sandbox: 'workspace-write' },
      })
    ).toMatch(/'sandbox'/);
    expect(
      advancedConfigDefinitionProblem('cursor', {
        ...definition,
        advanced_config: { effort: 'high' },
      })
    ).toMatch(/'effort'/);
  });

  it('names a Claude Code setting its session cannot start with', () => {
    expect(
      advancedConfigDefinitionProblem('claude', {
        ...definition,
        advanced_config: { maxTurns: 1.5 },
      })
    ).toMatch(/maxTurns/);
  });
});
