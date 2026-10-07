import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
import { hostedSkillsDirectory } from './hosted-skills';
import type { superviseSharedHost } from './supervisor';

const WORKER_DEPLOYMENT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../deploy/hosted/worker/testdata/deployment.json'
);

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
    version: 2,
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

const mirrorPath = (input: { root: string }) => join(input.root, 'repos', 'example', 'project.git');

async function configureGitHub(
  input: Awaited<ReturnType<typeof fixture>>,
  token = 'github-secret-value'
): Promise<string> {
  const credentialPath = join(input.root, 'mounted-secrets', 'github');
  await writeFile(credentialPath, `${token}\n`, { mode: 0o600 });
  input.spec.github = { credentialPath, mirrorPath: mirrorPath(input) };
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
  input.spec.github = { credentialPath: stateCredential, mirrorPath: mirrorPath(input) };
  const request = mockGitHubValidation();

  await expect(prepareHostedDeployment(input.state, input.spec)).rejects.toThrow(
    'GitHub credential file must be mounted outside'
  );
  const workspaceCredential = join(input.workspace, 'github');
  await writeFile(workspaceCredential, 'github-secret-value\n', { mode: 0o600 });
  input.spec.github = { credentialPath: workspaceCredential, mirrorPath: mirrorPath(input) };
  await expect(prepareHostedDeployment(input.state, input.spec)).rejects.toThrow(
    'GitHub credential file must be mounted outside'
  );
  expect(request).not.toHaveBeenCalled();
  await expect(readFile(join(input.state, 'hosted-deployment.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

/** A deployment of a repository granted to the agent, as the worker writes it. */
async function grantedRepository(input: Awaited<ReturnType<typeof fixture>>) {
  const workspace = join(input.root, 'worktrees', 'agent-id', 'example', 'project');
  await mkdir(workspace, { recursive: true });
  input.spec.workspacePath = workspace;
  input.spec.github = {
    credentialPath: join(input.root, 'run', 'agents', 'agent-id', 'github'),
    repository: 'example/project',
    refresh: true,
    mirrorPath: mirrorPath(input),
  };
  return workspace;
}

const GRANTED_TOKEN_ROUTE =
  'https://switch.invalid/api/agent/agents/agent-id/service-tokens/github';

function grantedToken(token = 'granted-github-secret') {
  return new Response(
    JSON.stringify({
      token,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      resources: { installation_id: 1, repository_ids: [2] },
    })
  );
}

it("clones a granted repository with a token from the agent's grant, and saves none of it", async () => {
  const input = await fixture();
  const agents = join(input.root, 'agents', 'agent-id');
  await grantedRepository(input);
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    String(url) === GRANTED_TOKEN_ROUTE && init?.method === 'POST'
      ? grantedToken()
      : new Response('{}')
  );
  vi.stubGlobal('fetch', request);

  const prepared = await prepareHostedDeployment(agents, input.spec);
  expect(request.mock.calls.map(([url]) => String(url))).toEqual([
    GRANTED_TOKEN_ROUTE,
    'https://api.github.com/repos/example/project',
  ]);
  expect(request.mock.calls[0]![1]?.headers).toEqual({
    Authorization: 'Bearer switch-secret-value',
  });
  expect(prepared.cloneToken).toBe('granted-github-secret');
  expect(prepared.logRedactions).toContain('granted-github-secret');
  // Sessions set GitHub up from the grant themselves: nothing of it is saved.
  expect(prepared.providerEnvironment.GH_TOKEN).toBeUndefined();
  expect(prepared.config.start.input.env.GIT_CONFIG_COUNT).toBeUndefined();
  expect(prepared.config.start.input.env.SWITCH_HOSTED_GITHUB_REPOSITORY).toBeUndefined();
  const persisted = await readFile(join(prepared.root, 'hosted-deployment.json'), 'utf8');
  expect(persisted).not.toContain('granted-github-secret');
});

it("says why when Switch will not give the agent's GitHub access", async () => {
  const input = await fixture();
  await grantedRepository(input);
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'grant_missing',
            message: 'This agent has no GitHub grant.',
            retryable: false,
          },
        }),
        { status: 403 }
      )
  );
  vi.stubGlobal('fetch', request);
  await expect(prepareHostedDeployment(input.state, input.spec)).rejects.toThrow(
    "Could not get the agent's GitHub access for the cloud repository: This agent has no GitHub grant."
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it('upgrades a plan an earlier build saved with its own GitHub renewal, once', async () => {
  const input = await fixture();
  await grantedRepository(input);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) =>
      String(url) === GRANTED_TOKEN_ROUTE ? grantedToken() : new Response('{}')
    )
  );
  const first = await prepareHostedDeployment(input.state, input.spec);
  // What the earlier build saved for the same revision.
  const earlier = structuredClone(first.config);
  Object.assign(earlier.start.input.env, githubLaunchEnvironment('/opt/old/hosted-bootstrap.mjs'), {
    SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS: '/run/switch.json',
    SWITCH_HOSTED_GITHUB_REPOSITORY: 'example/project',
    PATH: `${join(first.root, 'bin')}:/usr/bin:/bin`,
  });
  const planPath = join(first.root, 'hosted-deployment.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  await writeFile(planPath, JSON.stringify({ ...plan, config: earlier }));
  await writeFile(join(first.root, 'config.json'), JSON.stringify(earlier));
  await mkdir(join(first.root, 'bin'), { recursive: true });
  await writeFile(join(first.root, 'bin', 'gh'), '#!/bin/sh\n');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const upgraded = await prepareHostedDeployment(input.state, input.spec);
  expect(upgraded.config).toEqual(first.config);
  expect(JSON.parse(await readFile(join(first.root, 'config.json'), 'utf8'))).toEqual(first.config);
  await expect(readFile(join(first.root, 'bin', 'gh'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(warn).toHaveBeenCalledOnce();
  await prepareHostedDeployment(input.state, input.spec);
  expect(warn).toHaveBeenCalledOnce();

  // Any other difference is still refused.
  const other = structuredClone(first.config);
  other.start.input.env.SOMETHING_ELSE = '1';
  await writeFile(planPath, JSON.stringify({ ...plan, config: other }));
  await expect(prepareHostedDeployment(input.state, input.spec)).rejects.toThrow(
    'does not match its deployment specification'
  );
  warn.mockRestore();
});

it('still requires the mounted GitHub file when the credential is not refreshed', async () => {
  const input = await fixture();
  input.spec.github = {
    credentialPath: join(input.root, 'mounted-secrets', 'github'),
    repository: 'example/project',
    mirrorPath: mirrorPath(input),
  };
  const request = mockGitHubValidation();
  await expect(prepareHostedDeployment(input.state, input.spec)).rejects.toThrow(
    'GitHub credential file is missing or invalid.'
  );
  expect(request).not.toHaveBeenCalled();
});

it('accepts only version 2 and requires an absolute mirror path with a repository', async () => {
  const { spec, root } = await fixture();
  const github = {
    credentialPath: join(root, 'mounted-secrets', 'github'),
    repository: 'example/project',
    refresh: true as const,
  };
  expect(hostedDeploymentSpecSchema.safeParse(spec).success).toBe(true);
  expect(hostedDeploymentSpecSchema.safeParse({ ...spec, version: 1 }).success).toBe(false);
  expect(hostedDeploymentSpecSchema.safeParse({ ...spec, github }).success).toBe(false);
  expect(
    hostedDeploymentSpecSchema.safeParse({
      ...spec,
      github: { ...github, mirrorPath: 'repos/example/project.git' },
    }).success
  ).toBe(false);
  expect(
    hostedDeploymentSpecSchema.safeParse({
      ...spec,
      github: { ...github, mirrorPath: join(root, 'repos', 'example', 'project.git') },
    }).success
  ).toBe(true);
});

it('accepts the deployment the root supervisor writes for the Core agent list', async () => {
  const written: unknown = JSON.parse(await readFile(WORKER_DEPLOYMENT, 'utf8'));
  const parsed = hostedDeploymentSpecSchema.safeParse(written);
  expect(parsed.error).toBeUndefined();
  expect(parsed.data).toEqual(written);
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

it('installs granted connection skills into the provider skills directory before launch', async () => {
  const input = await fixture();
  input.spec.skills = [
    {
      slug: 'github',
      files: { 'SKILL.md': '---\nname: github\n---\n', 'reference/gh.md': 'gh pr list\n' },
    },
  ];
  await writeFile(input.specPath, JSON.stringify(input.spec));
  const stale = join(input.state, 'provider-home', 'claude', 'skills', 'github');
  await mkdir(input.state, { mode: 0o700 });
  await mkdir(stale, { recursive: true, mode: 0o700 });
  await writeFile(join(stale, 'old.md'), 'stale');
  mockHosted();
  const supervise = vi.fn<typeof superviseSharedHost>(async () => {
    expect(await readFile(join(stale, 'SKILL.md'), 'utf8')).toBe('---\nname: github\n---\n');
  });
  await run(input, { supervise });
  expect(supervise).toHaveBeenCalledOnce();
  expect((await readdir(stale)).sort()).toEqual(['SKILL.md', 'reference']);
  expect(await readFile(join(stale, 'reference', 'gh.md'), 'utf8')).toBe('gh pr list\n');
  expect(await readdir(join(input.state, 'provider-home', 'claude', 'skills'))).toEqual(['github']);
});

it('removes a connection skill an earlier bootstrap installed when none is listed', async () => {
  const input = await fixture();
  delete input.spec.skills;
  await writeFile(input.specPath, JSON.stringify(input.spec));
  const skills = join(input.state, 'provider-home', 'claude', 'skills');
  await mkdir(input.state, { mode: 0o700 });
  await mkdir(join(skills, 'github'), { recursive: true, mode: 0o700 });
  await writeFile(join(skills, 'github', 'SKILL.md'), '---\nname: github\n---\n');
  await mkdir(join(skills, 'own-skill'), { recursive: true, mode: 0o700 });
  mockHosted();
  const supervise = vi.fn<typeof superviseSharedHost>(async () => {
    expect(await readdir(skills)).toEqual(['own-skill']);
  });
  await run(input, { supervise });
  expect(supervise).toHaveBeenCalledOnce();
});

it('rejects unsafe, oversized or unsupported connection skills', async () => {
  const { spec } = await fixture();
  const skill = (files: Record<string, string>, slug = 'github') => ({ slug, files });
  const valid = skill({ 'SKILL.md': 'x' });
  expect(hostedDeploymentSpecSchema.safeParse({ ...spec, skills: [valid] }).success).toBe(true);
  for (const skills of [
    [],
    [skill({ 'README.md': 'x' })],
    [skill({ 'SKILL.md': 'x', '../escape.md': 'x' })],
    [skill({ 'SKILL.md': 'x', '/abs.md': 'x' })],
    [skill({ 'SKILL.md': 'x', 'a/../b.md': 'x' })],
    [skill({ 'SKILL.md': 'x\0' })],
    [skill({ 'SKILL.md': 'x'.repeat(32 * 1024 + 1) })],
    [skill({ 'SKILL.md': 'x' }, '../github')],
    [valid, valid],
    [{ ...valid, extra: true }],
  ])
    expect(hostedDeploymentSpecSchema.safeParse({ ...spec, skills }).success).toBe(false);
  for (const kind of ['cursor', 'antigravity'] as const)
    expect(
      hostedDeploymentSpecSchema.safeParse({
        ...spec,
        provider: { ...spec.provider, kind },
        skills: [valid],
      }).success
    ).toBe(false);
});

it('maps each skills-capable provider to the directory its agent reads', () => {
  const env = { HOME: '/r/home', CLAUDE_CONFIG_DIR: '/r/claude', XDG_CONFIG_HOME: '/r/xdg' };
  expect(hostedSkillsDirectory('claude', env)).toBe('/r/claude/skills');
  expect(hostedSkillsDirectory('codex', { ...env, CODEX_HOME: '/r/codex' })).toBe(
    '/r/codex/skills'
  );
  expect(hostedSkillsDirectory('codex', env)).toBe('/r/home/.codex/skills');
  expect(hostedSkillsDirectory('opencode', env)).toBe('/r/xdg/opencode/skills');
  expect(() => hostedSkillsDirectory('opencode', { HOME: '/r/home' })).toThrow(/not configured/);
});

it('adds the worktree on a later revision after the first repository setup failed', async () => {
  const input = await fixture();
  const workspace = join(input.root, 'worktrees', 'agent-id', 'example', 'project');
  await mkdir(workspace, { recursive: true });
  input.spec.workspacePath = workspace;
  input.spec.provider.definition = { name: 'helper', content: 'helper definition' };
  input.spec.github = {
    credentialPath: join(input.root, 'run', 'agents', 'agent-id', 'github'),
    repository: 'example/project',
    refresh: true,
    mirrorPath: mirrorPath(input),
  };
  await writeFile(input.specPath, JSON.stringify(input.spec));
  const bin = join(input.root, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'flock'),
    [
      '#!/usr/bin/env python3',
      'import fcntl, os, sys',
      'fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)',
      'os.set_inheritable(fd, True)',
      'fcntl.flock(fd, fcntl.LOCK_EX)',
      'os.execvp(sys.argv[2], sys.argv[2:])',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  const upstream = join(input.root, 'upstream');
  await mkdir(join(input.state, 'home'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(input.state, 'home', '.gitconfig'),
    `[url "file://${upstream}/"]\n\tinsteadOf = https://github.com/\n`
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
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
      if (path === GRANTED_TOKEN_ROUTE) return grantedToken();
      return new Response('{}');
    })
  );
  const supervise = vi.fn<typeof superviseSharedHost>(async () => {});

  await expect(run(input, { supervise })).rejects.toThrow(
    'Could not prepare the selected GitHub repository'
  );
  expect(await readdir(workspace)).toEqual([]);

  const git = (...args: string[]) =>
    promisify(execFile)('git', args, {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
      },
    });
  const remote = join(upstream, 'example', 'project.git');
  const seed = join(input.root, 'seed');
  await git('init', '--bare', '-b', 'main', remote);
  await git('init', '-b', 'main', seed);
  await writeFile(join(seed, 'README.md'), 'seed\n');
  await git('-C', seed, 'add', 'README.md');
  await git('-C', seed, 'commit', '-m', 'seed');
  await git('-C', seed, 'push', '-q', remote, 'main');
  input.spec.revision = 4;
  await writeFile(input.specPath, JSON.stringify(input.spec));

  await run(input, { supervise });
  expect(supervise).toHaveBeenCalledOnce();
  expect(await readFile(join(workspace, 'README.md'), 'utf8')).toBe('seed\n');
  expect(await readFile(join(workspace, '.claude', 'agents', 'helper.md'), 'utf8')).toBe(
    'helper definition'
  );
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

it('migrates a saved deployment from before the cutover and keeps its identity', async () => {
  const input = await fixture();
  const first = await prepareHostedDeployment(input.state, input.spec);
  expect(JSON.parse(await readFile(join(input.state, 'state-version.json'), 'utf8'))).toEqual({
    version: 1,
  });
  const planPath = join(input.state, 'hosted-deployment.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  delete plan.spec.revision;
  delete plan.spec.workerCapabilityPath;
  plan.config.roomConnection.rooms = [];
  await writeFile(planPath, JSON.stringify(plan));
  await rm(join(input.state, 'state-version.json'));
  const second = await prepareHostedDeployment(input.state, input.spec);
  expect(second.config).toEqual(first.config);
  expect(JSON.parse(await readFile(planPath, 'utf8')).spec).toEqual(input.spec);
  expect(
    JSON.parse(await readFile(join(input.state, 'cutover', 'manifest.json'), 'utf8')).items
  ).toEqual([]);
});
