import { expect, it } from 'vitest';
import { SWITCH_SKILL_CONTEXT } from '../../../switch-skill';
import { pluginRegistry } from '../../plugin-registry';
import { advancedConfigProblem, advancedSettings, sessionLaunchConfig } from '../../session-launch';
import { plugin, provider } from './index';

it('registers Droid with installation, model-discovery sign-in gating, and session-host metadata', () => {
  expect(pluginRegistry.get('droid')).toBe(provider);
  expect(plugin.metadata).toMatchObject({
    id: 'droid',
    name: 'Factory Droid',
    sessionStartMaySignIn: true,
  });
  expect(plugin.capabilities.hostDependency.binaryNames).toEqual(['droid']);
  expect(plugin.capabilities.hostDependency.updates).toMatchObject({
    update: { kind: 'cli', args: ['update'] },
  });
  for (const platform of ['macos', 'linux', 'windows'] as const)
    expect(plugin.capabilities.hostDependency.installCommands[platform]?.[0]?.recommended).toBe(
      true
    );
  expect(plugin.capabilities.autoApprove.kind).toBe('supported');
});

it('passes the chosen model and Switch room instructions through the create-agent launch path', () => {
  const launch = sessionLaunchConfig({
    provider: 'droid',
    slug: 'scout',
    description: '',
    cwd: '/work',
    instructions: 'Read room context before answering mentions.',
    model: 'advertised-model',
    advancedConfig: {},
  });
  expect(launch.model).toEqual({ id: 'advertised-model' });
  expect(launch.context).toBe(
    `${SWITCH_SKILL_CONTEXT}\n\nRead room context before answering mentions.`
  );
  expect(advancedSettings('droid')).toEqual({});
  expect(advancedConfigProblem('droid', {})).toBeNull();
  expect(advancedConfigProblem('droid', { effort: 'high' })).toContain('effort');
});
