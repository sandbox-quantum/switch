import { controllerConnectionId, sharedConfigSchema } from '@switch-console/agent-providers';
import { SWITCH_SKILL_CONTEXT, SWITCH_SKILL_FILE } from '@switch-console/plugins/switch-skill';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from './schemas';
import { buildWatcherTemplate, watcherSessionId } from './template';

const definition = { model: null, instructions: 'Review pull requests.', auto_approve: false };

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
      codexConfig: '',
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
      definition: { model: 'opus', instructions: '', auto_approve: true },
      cwd: '/work/scout',
      credentialsPath: '/data/c.json',
      binaryPath: null,
    });
    expect(template.start.input.runtimeMode).toBe('full-access');
    expect(template.start.input.model).toEqual({ id: 'opus' });
    expect(template.execution).not.toHaveProperty('binaryPath');
    expect(template.execution!.context).toBe(SWITCH_SKILL_CONTEXT);
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
