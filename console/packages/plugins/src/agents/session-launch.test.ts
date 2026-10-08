import { describe, expect, it } from 'vitest';
import { SWITCH_SKILL_CONTEXT, SWITCH_SKILL_FILE } from '../switch-skill';
import {
  advancedConfigProblem,
  advancedSettings,
  agentLaunchSources,
  sessionLaunchConfig,
} from './session-launch';

const BASE = {
  slug: 'scout',
  description: '',
  cwd: '/work/scout',
  instructions: 'Review pull requests.',
};

describe('sessionLaunchConfig', () => {
  it('runs Claude Code as the agent definition its advanced configuration amounts to', () => {
    const launch = sessionLaunchConfig({
      ...BASE,
      provider: 'claude',
      model: 'opus',
      advancedConfig: {
        tools: ['Read', 'Grep'],
        disallowedTools: ['Write'],
        permissionMode: 'acceptEdits',
        color: 'red',
        maxTurns: 12,
        background: true,
        isolation: 'worktree',
        effort: 'high',
        memory: 'project',
      },
    });
    expect(launch.model).toEqual({ id: 'opus', options: { effort: 'high' } });
    expect(launch.agent).toEqual({
      name: 'scout',
      definition: {
        description: 'scout',
        prompt: 'Review pull requests.',
        model: 'opus',
        tools: ['Read', 'Grep', 'mcp__switch'],
        disallowedTools: ['Write'],
        permissionMode: 'acceptEdits',
        maxTurns: 12,
        background: true,
        effort: 'high',
        memory: 'project',
      },
    });
    expect(launch.codexConfig).toBe('');
    expect(launch.skill).toBe('');
    expect(launch.context).toBe(`${SWITCH_SKILL_CONTEXT}\n\nReview pull requests.`);
  });

  it('runs Claude Code as it is when nothing describes the agent', () => {
    const launch = sessionLaunchConfig({
      ...BASE,
      provider: 'claude',
      instructions: '',
      model: null,
      advancedConfig: {},
    });
    expect(launch).toEqual({
      model: undefined,
      agent: undefined,
      codexConfig: '',
      skill: '',
      context: SWITCH_SKILL_CONTEXT,
      instructions: '',
    });
  });

  it('writes Codex’s advanced configuration into its profile', () => {
    const launch = sessionLaunchConfig({
      ...BASE,
      provider: 'codex',
      model: 'gpt-5.5',
      advancedConfig: {
        effort: 'high',
        verbosity: 'low',
        reasoningSummary: 'concise',
        webSearch: 'false',
      },
    });
    expect(launch.model).toEqual({ id: 'gpt-5.5', options: { effort: 'high' } });
    expect(launch.agent).toBeUndefined();
    expect(launch.codexConfig).toContain('model = "gpt-5.5"');
    expect(launch.codexConfig).toContain('model_reasoning_effort = "high"');
    expect(launch.codexConfig).toContain('model_verbosity = "low"');
    expect(launch.codexConfig).toContain('model_reasoning_summary = "concise"');
    expect(launch.codexConfig).toContain('web_search = false');
    expect(launch.codexConfig).toContain('developer_instructions = "Review pull requests."');
    expect(launch.context).toBe(`${SWITCH_SKILL_CONTEXT}\n\nReview pull requests.`);
  });

  it('gives OpenCode its variant with the model and the skill as a file', () => {
    const launch = sessionLaunchConfig({
      ...BASE,
      provider: 'opencode',
      model: 'anthropic/claude-sonnet-4-5',
      advancedConfig: { variant: 'max', temperature: 0.2, webSearch: 'true' },
    });
    expect(launch).toEqual({
      model: { id: 'anthropic/claude-sonnet-4-5', options: { variant: 'max' } },
      agent: undefined,
      codexConfig: '',
      skill: SWITCH_SKILL_FILE,
      context: 'Review pull requests.',
      instructions: 'Review pull requests.',
    });
  });

  it.each(['cursor', 'antigravity'])('runs %s on its model with the instructions', (provider) => {
    const launch = sessionLaunchConfig({
      ...BASE,
      provider,
      model: 'some-model',
      advancedConfig: {},
    });
    expect(launch).toEqual({
      model: { id: 'some-model' },
      agent: undefined,
      codexConfig: '',
      skill: '',
      context: `${SWITCH_SKILL_CONTEXT}\n\nReview pull requests.`,
      instructions: 'Review pull requests.',
    });
  });

  it('leaves the model’s option out when no model is chosen', () => {
    expect(
      sessionLaunchConfig({
        ...BASE,
        provider: 'codex',
        model: null,
        advancedConfig: { effort: 'high' },
      }).model
    ).toBeUndefined();
  });
});

describe('agentLaunchSources', () => {
  it('turns every setting into a string, and stands the name in for a missing description', () => {
    const sources = agentLaunchSources({
      provider: 'claude',
      name: 'scout',
      description: '',
      settings: { tools: ['Read', 'Grep'], maxTurns: 3, background: false, color: '', model: null },
      instructions: '',
    });
    expect(sources.specialization).toEqual({
      tools: 'Read,Grep',
      maxTurns: '3',
      background: 'false',
    });
    expect(sources.definition).toMatchObject({ description: 'scout', prompt: 'scout' });
  });
});

describe('advancedSettings', () => {
  it('lists the settings each provider applies, without the agent’s main attributes', () => {
    expect(advancedSettings('claude')).toEqual({
      tools: 'list',
      disallowedTools: 'list',
      permissionMode: 'text',
      color: 'text',
      maxTurns: 'number',
      background: 'boolean',
      isolation: 'text',
      effort: 'text',
      memory: 'text',
    });
    expect(advancedSettings('codex')).toEqual({
      effort: 'text',
      verbosity: 'text',
      reasoningSummary: 'text',
      webSearch: 'text',
    });
    expect(advancedSettings('opencode')).toEqual({
      variant: 'text',
      temperature: 'number',
      topP: 'number',
      maxSteps: 'number',
      webSearch: 'text',
      smallModel: 'text',
    });
    expect(advancedSettings('cursor')).toEqual({});
    expect(advancedSettings('antigravity')).toEqual({});
  });
});

describe('advancedConfigProblem', () => {
  it('accepts values of the shape each setting is applied as', () => {
    expect(
      advancedConfigProblem('claude', {
        tools: ['Read'],
        maxTurns: 4,
        background: true,
        effort: 'max',
      })
    ).toBeNull();
  });

  it('accepts an empty configuration for a provider that applies no settings', () => {
    expect(advancedConfigProblem('antigravity', {})).toBeNull();
    expect(advancedConfigProblem('cursor', {})).toBeNull();
  });

  it('names a field the provider does not apply', () => {
    expect(advancedConfigProblem('codex', { sandbox: 'workspace-write' })).toBe(
      "The advanced configuration field 'sandbox' is not one this build applies for codex."
    );
    expect(advancedConfigProblem('cursor', { effort: 'high' })).toMatch(/'effort'/);
    expect(advancedConfigProblem('antigravity', { effort: 'high' })).toMatch(/'effort'/);
  });

  it('names a field whose value is not of the shape it is applied as', () => {
    expect(advancedConfigProblem('claude', { tools: 'Read' })).toMatch(/'tools'.*list/);
    expect(advancedConfigProblem('claude', { background: 'true' })).toMatch(/'background'/);
    expect(advancedConfigProblem('opencode', { temperature: '0.2' })).toMatch(/'temperature'/);
    expect(advancedConfigProblem('codex', { effort: 3 })).toMatch(/'effort'.*text/);
  });

  it('leaves which values a field accepts to the server', () => {
    expect(advancedConfigProblem('codex', { effort: 'extreme' })).toBeNull();
  });
});
