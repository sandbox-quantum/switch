import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerRuntime, sharedConfigSchema } from '@switch-console/agent-providers';
import { writeNodeCli } from '@switch-console/agent-providers/testing';
import { afterEach, expect, it } from 'vitest';
import { PROVIDERS } from './providers';
import { PathProviderLocator, providerStatusFrom } from './status';
import { buildWatcherTemplate } from './template';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it.skipIf(process.platform === 'win32')(
  'detects installed, missing and configured OpenHands on a headless machine',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'switch-openhands-controller-'));
    dirs.push(dir);
    const locator = new PathProviderLocator(() => dir, join(dir, 'probe-home'));
    expect(await locator.locate('openhands')).toBeNull();
    expect(providerStatusFrom('openhands', null, null, '2026-11-04T00:00:00Z')).toMatchObject({
      installed: false,
      reason: 'provider_not_installed',
    });
    const binary = await writeNodeCli(
      dir,
      'openhands',
      `
    if (process.argv[2] !== '--version') process.exit(2);
    console.log('OpenHands CLI 1.16.0');
  `
    );
    const located = await locator.locate('openhands');
    expect(located).toMatchObject({ path: binary, version: '1.16.0', versionProblem: null });
    const profile = join(dir, 'profile');
    const input = {
      provider: 'openhands',
      binaryPath: binary,
      cwd: dir,
      env: { OPENHANDS_PERSISTENCE_DIR: profile },
    };
    const signedOut = await providerRuntime('openhands').checkSignIn(input);
    expect(
      providerStatusFrom('openhands', located, signedOut, '2026-11-04T00:00:00Z')
    ).toMatchObject({
      installed: true,
      auth: 'missing',
      auth_problem: expect.stringContaining('openhands login'),
    });
    await mkdir(profile);
    await writeFile(
      join(profile, 'agent_settings.json'),
      JSON.stringify({
        kind: 'Agent',
        llm: { model: 'openai/configured-model' },
        tools: [],
      }),
      { mode: 0o600 }
    );
    const configured = await providerRuntime('openhands').checkSignIn(input);
    expect(
      providerStatusFrom('openhands', located, configured, '2026-11-04T00:00:00Z')
    ).toMatchObject({ installed: true, auth: 'ok' });
  }
);

it('builds a headless room watcher with native ACP capabilities and profile passthrough', () => {
  expect(PROVIDERS).toContain('openhands');
  const template = buildWatcherTemplate({
    agentId: 'openhands-agent',
    provider: 'openhands',
    definition: {
      name: 'scout',
      model: 'openai/configured-model',
      advanced_config: {},
      instructions: 'Read room context and answer mentions.',
      auto_approve: true,
      auto_mode: false,
    },
    cwd: '/work/scout',
    credentialsPath: '/data/agents/openhands-agent/credentials.json',
    binaryPath: '/bin/openhands',
  });
  expect(sharedConfigSchema.safeParse(template).success).toBe(true);
  expect(template.start.input).toMatchObject({
    cwd: '/work/scout',
    model: { id: 'openai/configured-model' },
    runtimeMode: 'full-access',
  });
  expect(template.session.capabilities).toMatchObject({
    input: 'queue',
    approvals: true,
    interrupt: true,
  });
  expect(template.execution?.inheritEnv).toEqual(
    expect.arrayContaining(['OPENHANDS_PERSISTENCE_DIR', 'OPENHANDS_CONVERSATIONS_DIR'])
  );
  const adapter = providerRuntime('openhands').createAdapter({
    binaryPath: undefined,
    logger: undefined,
    skill: '',
    serviceSkills: [],
  });
  expect(adapter.capabilities).toMatchObject({
    modelSwitchInSession: false,
    steering: false,
    resume: true,
    approvals: true,
  });
});
