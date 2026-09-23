import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  type HostedBootstrapDependencies,
  type HostedDeploymentSpec,
  prepareHostedDeployment,
  runHostedBootstrap,
} from './hosted-bootstrap';
import type { fenceDeadOwner } from './process-fence';
import type { superviseSharedHost } from './supervisor';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{
  root: string;
  state: string;
  workspace: string;
  providerCredential: string;
  switchCredentials: string;
  specPath: string;
  spec: HostedDeploymentSpec;
}> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-bootstrap-'));
  roots.push(root);
  const state = join(root, 'state');
  const workspace = join(root, 'workspace');
  const secrets = join(root, 'mounted-secrets');
  const binary = join(root, 'claude');
  const providerCredential = join(secrets, 'provider');
  const switchCredentials = join(secrets, 'switch.json');
  const specPath = join(root, 'deployment.json');
  await mkdir(workspace);
  await mkdir(secrets);
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(binary, 0o700);
  await writeFile(providerCredential, 'provider-secret-value\n', { mode: 0o600 });
  await writeFile(
    switchCredentials,
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'https://switch.invalid/api/agent',
        SWITCH_API_TOKEN: 'switch-secret-value',
        SWITCH_AGENT_ID: 'agent-id',
      },
    }),
    { mode: 0o600 }
  );
  const spec: HostedDeploymentSpec = {
    version: 1,
    session: { sessionId: 'session-id', agentId: 'agent-id' },
    provider: {
      kind: 'claude',
      credential: { kind: 'api-key', path: providerCredential },
      binaryPath: binary,
      context: 'Follow the mounted Switch room workflow.',
    },
    workspacePath: workspace,
    room: { roomId: 'room-id', startCursor: 4 },
    runtimeMode: 'approval-required',
    switchCredentialsPath: switchCredentials,
    mcpRuntime: '@sandboxaq/switch-agent-runtime@0.0.0-fixture',
  };
  await writeFile(specPath, JSON.stringify(spec));
  return { root, state, workspace, providerCredential, switchCredentials, specPath, spec };
}

it('persists one stable identity without persisting either credential value', async () => {
  const input = await fixture();
  const first = await prepareHostedDeployment(input.state, input.spec);
  const second = await prepareHostedDeployment(input.state, input.spec);
  expect(second.config.session.hostId).toBe(first.config.session.hostId);
  expect(second.config.session.epoch).toBe(first.config.session.epoch);
  expect(second.config.roomConnection?.connectionId).toBe(
    first.config.roomConnection?.connectionId
  );
  expect(first.providerEnvironment.ANTHROPIC_API_KEY).toBe('provider-secret-value');
  expect(first.providerEnvironment.SWITCH_API_TOKEN).toBeUndefined();
  const persisted = [
    await readFile(join(input.state, 'hosted-deployment.json'), 'utf8'),
    await readFile(join(input.state, 'config.json'), 'utf8'),
  ].join('\n');
  expect(persisted).not.toContain('provider-secret-value');
  expect(persisted).not.toContain('switch-secret-value');
  expect(first.config.start.input.env.HOME).toBe(join(first.root, 'home'));
  expect(first.config.start.input.env.CLAUDE_CONFIG_DIR).toBe(
    join(first.root, 'provider-home', 'claude')
  );
});

it('converges concurrent first starts on the same saved identity', async () => {
  const input = await fixture();
  const [first, second] = await Promise.all([
    prepareHostedDeployment(input.state, input.spec),
    prepareHostedDeployment(input.state, input.spec),
  ]);
  expect(second.config).toEqual(first.config);
});

it('maps a mounted setup token only into the worker environment', async () => {
  const input = await fixture();
  input.spec.provider.credential.kind = 'setup-token';
  const prepared = await prepareHostedDeployment(input.state, input.spec);
  expect(prepared.providerEnvironment.CLAUDE_CODE_OAUTH_TOKEN).toBe('provider-secret-value');
  expect(prepared.providerEnvironment.ANTHROPIC_API_KEY).toBeUndefined();
  expect(JSON.stringify(prepared.config)).not.toContain('provider-secret-value');
});

it('does not fall back to ambient provider, cloud, Node, or home credentials', async () => {
  const input = await fixture();
  vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-provider-secret');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'ambient-setup-secret');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'ambient-cloud-secret');
  vi.stubEnv('NODE_OPTIONS', '--require=/tmp/ambient-hook.cjs');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/ambient-claude-home');
  const prepared = await prepareHostedDeployment(input.state, input.spec);
  expect(prepared.providerEnvironment.ANTHROPIC_API_KEY).toBe('provider-secret-value');
  expect(prepared.providerEnvironment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(prepared.providerEnvironment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(prepared.providerEnvironment.NODE_OPTIONS).toBeUndefined();
  expect(prepared.providerEnvironment.CLAUDE_CONFIG_DIR).toBe(
    join(prepared.root, 'provider-home', 'claude')
  );
});

it('reloads a replaced provider secret at bootstrap without changing session identity', async () => {
  const input = await fixture();
  const first = await prepareHostedDeployment(input.state, input.spec);
  await writeFile(input.providerCredential, 'rotated-provider-secret\n', { mode: 0o600 });
  const second = await prepareHostedDeployment(input.state, input.spec);
  expect(second.config).toEqual(first.config);
  expect(second.providerEnvironment.ANTHROPIC_API_KEY).toBe('rotated-provider-secret');
  const persisted = [
    await readFile(join(second.root, 'hosted-deployment.json'), 'utf8'),
    await readFile(join(second.root, 'config.json'), 'utf8'),
  ].join('\n');
  expect(persisted).not.toContain('provider-secret-value');
  expect(persisted).not.toContain('rotated-provider-secret');
});

it('rejects overlapping state and workspace paths before creating runtime homes', async () => {
  const input = await fixture();
  const state = join(input.workspace, 'state');
  await expect(prepareHostedDeployment(state, input.spec)).rejects.toThrow(
    'state and workspace directories must not overlap'
  );
  await expect(readFile(join(state, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('treats dot-dot-prefixed names as children for path isolation', async () => {
  const input = await fixture();
  await mkdir(input.state, { mode: 0o700 });
  const credentialDirectory = join(input.state, '..credentials');
  await mkdir(credentialDirectory);
  const nestedCredential = join(credentialDirectory, 'provider');
  await writeFile(nestedCredential, 'nested-provider-secret', { mode: 0o600 });
  await expect(
    prepareHostedDeployment(input.state, {
      ...input.spec,
      provider: {
        ...input.spec.provider,
        credential: { kind: 'api-key', path: nestedCredential },
      },
    })
  ).rejects.toThrow('must be mounted outside');

  const nestedWorkspace = join(input.state, '..workspace');
  await mkdir(nestedWorkspace);
  await expect(
    prepareHostedDeployment(input.state, { ...input.spec, workspacePath: nestedWorkspace })
  ).rejects.toThrow('state and workspace directories must not overlap');
});

it('rejects malformed credential files without exposing their content', async () => {
  const input = await fixture();
  await writeFile(
    input.switchCredentials,
    JSON.stringify({ env: { SWITCH_API_TOKEN: 'secret-that-must-not-escape' } })
  );
  let message = '';
  try {
    await prepareHostedDeployment(input.state, input.spec);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('Switch credential file is missing or invalid');
  expect(message).not.toContain('secret-that-must-not-escape');
});

it('rejects a credential-bearing Switch endpoint before it can enter the journal', async () => {
  const input = await fixture();
  await writeFile(
    input.switchCredentials,
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'https://user:password@switch.invalid/api',
        SWITCH_API_TOKEN: 'switch-secret-value',
        SWITCH_AGENT_ID: 'agent-id',
      },
    })
  );
  await expect(prepareHostedDeployment(input.state, input.spec)).rejects.toThrow(
    'invalid endpoint'
  );
});

it('rejects a changed deployment spec and a tampered saved launch configuration', async () => {
  const input = await fixture();
  await prepareHostedDeployment(input.state, input.spec);
  await expect(
    prepareHostedDeployment(input.state, {
      ...input.spec,
      room: { roomId: 'different-room', startCursor: 4 },
    })
  ).rejects.toThrow('differs from the saved state');
  const planPath = join(input.state, 'hosted-deployment.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  plan.config.start.input.env.UNEXPECTED = 'value';
  await writeFile(planPath, JSON.stringify(plan));
  await expect(prepareHostedDeployment(input.state, input.spec)).rejects.toThrow(
    'does not match its deployment specification'
  );
});

it('wires the existing daemon to the foreground supervisor and forwards shutdown', async () => {
  const input = await fixture();
  const stop = new AbortController();
  let launched: Parameters<typeof superviseSharedHost>[0] | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const supervise: typeof superviseSharedHost = async (options) => {
    launched = options;
    started();
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
  const fenceDeadWorker: typeof fenceDeadOwner = async () => {};
  const dependencies: HostedBootstrapDependencies = { supervise, fenceDeadWorker };
  const running = runHostedBootstrap(
    {
      stateDirectory: input.state,
      specPath: input.specPath,
      sharedDaemonEntrypoint: '/opt/switch/shared-host-daemon.mjs',
      signal: stop.signal,
    },
    dependencies
  );
  await ready;
  stop.abort();
  await running;
  expect(launched?.existingWorker).toBe('reject');
  const canonicalState = await realpath(input.state);
  expect(launched?.args).toEqual([
    '/opt/switch/shared-host-daemon.mjs',
    canonicalState,
    join(canonicalState, 'config.json'),
  ]);
  expect(launched?.args.join(' ')).not.toContain('provider-secret-value');
  expect(launched?.args.join(' ')).not.toContain('switch-secret-value');
  expect(launched?.env.ANTHROPIC_API_KEY).toBe('provider-secret-value');
  expect(launched?.signal.aborted).toBe(true);
});

it('redacts the mounted provider credential from launcher failures', async () => {
  const input = await fixture();
  const supervise: typeof superviseSharedHost = async () => {
    throw new Error('provider rejected provider-secret-value with switch-secret-value');
  };
  const fenceDeadWorker: typeof fenceDeadOwner = async () => {};
  await expect(
    runHostedBootstrap(
      {
        stateDirectory: input.state,
        specPath: input.specPath,
        sharedDaemonEntrypoint: '/opt/switch/shared-host-daemon.mjs',
        signal: new AbortController().signal,
      },
      { supervise, fenceDeadWorker }
    )
  ).rejects.toThrow('provider rejected [REDACTED] with [REDACTED]');
});
