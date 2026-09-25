import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerObsoleteError } from './exit-codes';
import {
  type HostedBootstrapDependencies,
  type HostedDeploymentSpec,
  hostedDeploymentSpecSchema,
  prepareHostedDeployment,
  runHostedBootstrap,
} from './hosted-bootstrap';
import { githubLaunchEnvironment } from './hosted-github';
import type { superviseSharedHost } from './supervisor';

const roots: string[] = [];

beforeEach(() => {
  vi.stubEnv('SWITCH_HOST_INSTANCE_ID', 'instance-fixture');
  vi.stubEnv('SWITCH_HOST_BOOT_ID', 'boot-fixture');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{
  root: string;
  state: string;
  workspace: string;
  providerCredential: string;
  switchCredentials: string;
  workerCapability: string;
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
  const workerCapability = join(secrets, 'worker-capability');
  const specPath = join(root, 'deployment.json');
  await mkdir(workspace);
  await mkdir(secrets);
  await writeFile(binary, '#!/bin/sh\necho \'{"loggedIn":true}\'\n', { mode: 0o700 });
  await chmod(binary, 0o700);
  await writeFile(providerCredential, 'provider-secret-value\n', { mode: 0o600 });
  await writeFile(workerCapability, 'worker-capability-secret\n', { mode: 0o600 });
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
    revision: 3,
    session: { sessionId: 'session-id', agentId: 'agent-id' },
    provider: {
      kind: 'claude',
      credential: { kind: 'api-key', path: providerCredential },
      binaryPath: binary,
      context: 'Follow the mounted Switch room workflow.',
    },
    workspacePath: workspace,
    watch: true,
    runtimeMode: 'approval-required',
    switchCredentialsPath: switchCredentials,
    workerCapabilityPath: workerCapability,
  };
  await writeFile(specPath, JSON.stringify(spec));
  return {
    root,
    state,
    workspace,
    providerCredential,
    switchCredentials,
    workerCapability,
    specPath,
    spec,
  };
}

async function configureGitHub(
  input: Awaited<ReturnType<typeof fixture>>,
  token = 'github-secret-value'
): Promise<string> {
  const credentialPath = join(input.root, 'mounted-secrets', 'github');
  await writeFile(credentialPath, `${token}\n`, { mode: 0o600 });
  input.spec.github = { credentialPath };
  return credentialPath;
}

function mockGitHubValidation(status = 200, body = '{}') {
  const request = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', request);
  return request;
}

/** Stub Switch's `/hosted` routes; any other request is GitHub validation. */
function mockHosted() {
  const request = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith('/hosted/provider-credential'))
      return new Response(
        JSON.stringify({
          status: 'connected',
          revision: 'test-revision',
          provider: 'claude',
          kind: 'api-key',
          credential: 'provider-secret-value',
        })
      );
    return new Response('{}');
  });
  vi.stubGlobal('fetch', request);
  return request;
}

function run(
  input: Awaited<ReturnType<typeof fixture>>,
  dependencies: HostedBootstrapDependencies,
  signal = new AbortController().signal
): Promise<void> {
  return runHostedBootstrap(
    {
      stateDirectory: input.state,
      specPath: input.specPath,
      sharedDaemonEntrypoint: '/opt/switch/shared-host-daemon.mjs',
      signal,
    },
    dependencies
  );
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
  expect(first.providerEnvironment.GH_TOKEN).toBeUndefined();
  expect(first.config.execution?.inheritEnv).not.toContain('GH_TOKEN');
  const persisted = [
    await readFile(join(input.state, 'hosted-deployment.json'), 'utf8'),
    await readFile(join(input.state, 'config.json'), 'utf8'),
  ].join('\n');
  expect(persisted).not.toContain('provider-secret-value');
  expect(persisted).not.toContain('switch-secret-value');
  expect(persisted).not.toContain('worker-capability-secret');
  expect(persisted).not.toContain('instance-fixture');
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

it('validates and launches with a GitHub token without persisting it', async () => {
  const input = await fixture();
  await configureGitHub(input);
  const request = mockGitHubValidation();
  const prepared = await prepareHostedDeployment(input.state, input.spec);

  expect(request).toHaveBeenCalledTimes(1);
  expect(prepared.providerEnvironment.GH_TOKEN).toBe('github-secret-value');
  expect(prepared.config.execution?.inheritEnv).toContain('GH_TOKEN');
  for (const [key, value] of Object.entries(githubLaunchEnvironment())) {
    expect(prepared.config.start.input.env[key]).toBe(value);
    expect(prepared.providerEnvironment[key]).toBe(value);
  }
  const persisted = [
    await readFile(join(input.state, 'hosted-deployment.json'), 'utf8'),
    await readFile(join(input.state, 'config.json'), 'utf8'),
  ].join('\n');
  expect(persisted).not.toContain('github-secret-value');
});

it('reloads and validates a rotated GitHub token without changing the saved plan', async () => {
  const input = await fixture();
  const credentialPath = await configureGitHub(input);
  const request = mockGitHubValidation();
  const first = await prepareHostedDeployment(input.state, input.spec);
  await writeFile(credentialPath, 'rotated-github-secret\n', { mode: 0o600 });
  const second = await prepareHostedDeployment(input.state, input.spec);

  expect(request).toHaveBeenCalledTimes(2);
  expect(second.config).toEqual(first.config);
  expect(second.providerEnvironment.GH_TOKEN).toBe('rotated-github-secret');
  const persisted = [
    await readFile(join(input.state, 'hosted-deployment.json'), 'utf8'),
    await readFile(join(input.state, 'config.json'), 'utf8'),
  ].join('\n');
  expect(persisted).not.toContain('github-secret-value');
  expect(persisted).not.toContain('rotated-github-secret');
});

it('rejects a GitHub credential inside hosted state or workspace before validation', async () => {
  const input = await fixture();
  await mkdir(input.state, { mode: 0o700 });
  const stateCredential = join(input.state, 'github');
  await writeFile(stateCredential, 'github-secret-value\n', { mode: 0o600 });
  input.spec.github = { credentialPath: stateCredential };
  const request = mockGitHubValidation();

  await expect(prepareHostedDeployment(input.state, input.spec)).rejects.toThrow(
    'GitHub credential file must be mounted outside'
  );
  const workspaceCredential = join(input.workspace, 'github');
  await writeFile(workspaceCredential, 'github-secret-value\n', { mode: 0o600 });
  input.spec.github = { credentialPath: workspaceCredential };
  await expect(prepareHostedDeployment(input.state, input.spec)).rejects.toThrow(
    'GitHub credential file must be mounted outside'
  );
  expect(request).not.toHaveBeenCalled();
  await expect(readFile(join(input.state, 'hosted-deployment.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('sanitizes GitHub validation rejection and does not launch or persist a plan', async () => {
  const input = await fixture();
  await configureGitHub(input);
  await writeFile(input.specPath, JSON.stringify(input.spec));
  mockGitHubValidation(401, 'remote-body-that-must-not-escape github-secret-value');
  let launched = false;
  const supervise: typeof superviseSharedHost = async () => {
    launched = true;
  };
  let message = '';
  try {
    await run(input, { supervise });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain('GitHub rejected the credential');
  expect(message).not.toContain('github-secret-value');
  expect(message).not.toContain('remote-body-that-must-not-escape');
  expect(launched).toBe(false);
  await expect(readFile(join(input.state, 'hosted-deployment.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(readFile(join(input.state, 'config.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
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
      watch: false,
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

it('adopts a newer revision with a changed spec and keeps the session identity and homes', async () => {
  const input = await fixture();
  input.spec.provider.definition = { name: 'helper', content: 'first definition' };
  const first = await prepareHostedDeployment(input.state, input.spec);
  const definition = join(input.workspace, '.claude', 'agents', 'helper.md');
  await mkdir(join(input.workspace, '.claude', 'agents'), { recursive: true });
  await writeFile(definition, 'first definition');
  const retained = join(first.root, 'provider-home', 'claude', 'retained');
  await writeFile(retained, 'kept');
  const revised: HostedDeploymentSpec = {
    ...input.spec,
    revision: 4,
    watch: false,
    provider: {
      ...input.spec.provider,
      model: { id: 'model-next' },
      context: 'Revised instructions.',
      definition: { name: 'helper', content: 'revised definition' },
    },
  };
  const second = await prepareHostedDeployment(input.state, revised);
  expect(second.config.session.hostId).toBe(first.config.session.hostId);
  expect(second.config.session.epoch).toBe(first.config.session.epoch);
  expect(second.config.roomConnection?.connectionId).toBe(
    first.config.roomConnection?.connectionId
  );
  expect(second.config).not.toEqual(first.config);
  expect(JSON.parse(await readFile(join(second.root, 'config.json'), 'utf8'))).toEqual(
    second.config
  );
  const plan = JSON.parse(await readFile(join(second.root, 'hosted-deployment.json'), 'utf8'));
  expect(plan.spec).toEqual(revised);
  expect(await readFile(definition, 'utf8')).toBe('revised definition');
  expect(await readFile(retained, 'utf8')).toBe('kept');
  expect(JSON.parse(await readFile(join(second.root, 'watch.json'), 'utf8')).spawn).toBe(false);
  // The same revision is settled again; a changed spec at it is still refused.
  await expect(prepareHostedDeployment(input.state, revised)).resolves.toBeDefined();
  await expect(prepareHostedDeployment(input.state, { ...revised, watch: true })).rejects.toThrow(
    'differs from the saved state'
  );
});

it('refuses a deployment older than the saved revision', async () => {
  const input = await fixture();
  await prepareHostedDeployment(input.state, input.spec);
  await expect(
    prepareHostedDeployment(input.state, { ...input.spec, revision: 2 })
  ).rejects.toThrow('revision 2 is older than the saved revision 3');
  await expect(
    prepareHostedDeployment(input.state, { ...input.spec, revision: 2, watch: false })
  ).rejects.toThrow('older than the saved revision');
});

it('wires the shared daemon to the supervisor and forwards shutdown', async () => {
  const input = await fixture();
  mockHosted();
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
  const running = run(input, { supervise }, stop.signal);
  await ready;
  stop.abort();
  await running;
  const canonicalState = await realpath(input.state);
  expect(launched?.args).toEqual([
    '/opt/switch/shared-host-daemon.mjs',
    canonicalState,
    join(canonicalState, 'config.json'),
    '--watch-worker',
  ]);
  expect(launched?.args.join(' ')).not.toContain('provider-secret-value');
  expect(launched?.args.join(' ')).not.toContain('switch-secret-value');
  expect(launched?.env.ANTHROPIC_API_KEY).toBe('provider-secret-value');
  expect(launched?.env.SWITCH_HOSTED_BOOTSTRAP).toBe('1');
  expect(launched?.env.SWITCH_HOST_INSTANCE_ID).toBe('instance-fixture');
  expect(launched?.env.SWITCH_HOST_BOOT_ID).toBe('boot-fixture');
  expect(JSON.stringify(launched?.env)).not.toContain('worker-capability-secret');
  expect(launched?.logRedactions).toEqual(
    expect.arrayContaining([
      'provider-secret-value',
      'switch-secret-value',
      'worker-capability-secret',
    ])
  );
  expect(launched?.signal.aborted).toBe(true);
});

it('writes the worker capability as a private file in the daemon root', async () => {
  const input = await fixture();
  const prepared = await prepareHostedDeployment(input.state, input.spec);
  const path = join(prepared.root, 'worker-capability');
  expect(await readFile(path, 'utf8')).toBe('worker-capability-secret');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(prepared.providerEnvironment)).not.toContain('worker-capability-secret');
  expect(prepared.logRedactions).toContain('worker-capability-secret');
});

it('records whether the watcher may start sessions', async () => {
  const input = await fixture();
  await prepareHostedDeployment(input.state, input.spec);
  expect(JSON.parse(await readFile(join(input.state, 'watch.json'), 'utf8'))).toEqual({
    enabled: true,
    spawn: true,
  });
  const other = await fixture();
  other.spec.watch = false;
  await prepareHostedDeployment(other.state, other.spec);
  expect(JSON.parse(await readFile(join(other.state, 'watch.json'), 'utf8'))).toEqual({
    enabled: true,
    spawn: false,
  });
});

it('points a Codex session at the materialized login', async () => {
  const input = await fixture();
  input.spec.provider.kind = 'codex';
  const prepared = await prepareHostedDeployment(input.state, input.spec);
  expect(prepared.config.start.input.env.CODEX_HOME).toBe(join(prepared.root, 'provider-home'));
});

it('requires the machine identity', async () => {
  const input = await fixture();
  vi.stubEnv('SWITCH_HOST_BOOT_ID', '');
  await expect(prepareHostedDeployment(input.state, input.spec)).rejects.toThrow(
    'SWITCH_HOST_BOOT_ID'
  );
});

it('requires the watch flag and the worker capability path', async () => {
  const { spec } = await fixture();
  const { watch: _watch, ...withoutWatch } = spec;
  expect(hostedDeploymentSpecSchema.safeParse(withoutWatch).success).toBe(false);
  const { workerCapabilityPath: _path, ...withoutCapability } = spec;
  expect(hostedDeploymentSpecSchema.safeParse(withoutCapability).success).toBe(false);
});

it('passes an obsolete worker through unchanged', async () => {
  const input = await fixture();
  mockHosted();
  const obsolete = new WorkerObsoleteError('The worker bundle is obsolete.');
  await expect(
    run(input, {
      supervise: async () => {
        throw obsolete;
      },
    })
  ).rejects.toBe(obsolete);
});

it('redacts raw and encoded GitHub credentials from launcher failures', async () => {
  const input = await fixture();
  const token = 'github-secret:%value';
  await configureGitHub(input, token);
  await writeFile(input.specPath, JSON.stringify(input.spec));
  mockHosted();
  const encoded = encodeURIComponent(token);
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const supervise: typeof superviseSharedHost = async () => {
    throw new Error(`github rejected ${token} encoded ${encoded} basic ${basic}`);
  };
  let message = '';
  try {
    await run(input, { supervise });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toBe('github rejected [REDACTED] encoded [REDACTED] basic [REDACTED]');
});

it('redacts the mounted provider credential from launcher failures', async () => {
  const input = await fixture();
  mockHosted();
  const supervise: typeof superviseSharedHost = async () => {
    throw new Error('provider rejected provider-secret-value with switch-secret-value');
  };
  await expect(run(input, { supervise })).rejects.toThrow(
    'provider rejected [REDACTED] with [REDACTED]'
  );
});

it('does not invalidate credentials when provider readiness is inconclusive', async () => {
  const input = await fixture();
  input.spec.provider.credential.refresh = true;
  await rm(input.providerCredential);
  await writeFile(input.spec.provider.binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(input.specPath, JSON.stringify(input.spec));
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: 'connected',
          revision: 'test-revision',
          provider: 'claude',
          kind: 'api-key',
          credential: 'provider-secret-value',
        })
      )
  );
  vi.stubGlobal('fetch', request);
  const supervise = vi.fn();
  await expect(run(input, { supervise })).rejects.toThrow('Could not verify authentication');
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    expect.stringContaining('/hosted/provider-credential'),
    expect.anything()
  );
  expect(supervise).not.toHaveBeenCalled();
});
