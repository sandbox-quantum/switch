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
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildSharedHostConfig } from './build-shared-config';
import {
  type HostedWorkspace,
  hostedUnitGitHubEnvironment,
  prepareHostedAgent,
} from './hosted-bootstrap';
import type { HostedCredential } from './hosted-provider';
import type { SharedHostConfig } from './shared-config';

const AGENT = 'agent-placeholder';

let base: string;
let agentRoot: string;
let credentials: string;
let binary: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hosted-agent-prepare-')));
  agentRoot = join(base, 'agents', AGENT);
  credentials = join(base, 'credentials');
  binary = join(base, 'provider-binary');
  await mkdir(join(agentRoot, 'watcher'), { recursive: true });
  await mkdir(credentials);
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o700);
  await writeFile(
    join(credentials, 'agent'),
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'http://127.0.0.1:47100',
        SWITCH_API_TOKEN: 'relay-token-placeholder',
        SWITCH_AGENT_ID: AGENT,
      },
    })
  );
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function config(provider: SharedHostConfig['start']['provider']): SharedHostConfig {
  return buildSharedHostConfig({
    session: { sessionId: `watcher-${AGENT}`, agentId: AGENT, provider },
    launch: {
      cwd: join(base, 'worktrees', AGENT, 'workspace'),
      runtimeMode: 'full-access',
      env: {},
      model: undefined,
    },
    capabilities: { approvals: true, userInput: true },
    execution: {
      credentialsPath: join(credentials, 'agent'),
      inheritEnv: ['PATH'],
      binaryPath: binary,
      codexConfig: '',
      skill: '',
      context: '',
      agentDefinition: undefined,
    },
    ids: { hostId: 'host', epoch: 'epoch', connectionId: 'connection' },
  });
}

async function arrange(input: {
  provider: SharedHostConfig['start']['provider'];
  credential: HostedCredential;
  workspace?: Partial<HostedWorkspace>;
  config?: SharedHostConfig;
}): Promise<HostedWorkspace> {
  const workspace: HostedWorkspace = {
    connections: [],
    workspacePath: join(base, 'worktrees', AGENT, 'workspace'),
    skills: [],
    instructions: 'Review pull requests.',
    ...input.workspace,
  };
  await writeFile(
    join(agentRoot, 'watcher', 'config.json'),
    JSON.stringify(input.config ?? config(input.provider))
  );
  await writeFile(join(credentials, 'provider'), JSON.stringify(input.credential));
  await writeFile(join(agentRoot, 'workspace.json'), JSON.stringify(workspace));
  return workspace;
}

function connected(
  provider: Exclude<HostedCredential, { status: 'revoked' }>['provider'],
  kind: 'api-key' | 'setup-token' | 'auth-json',
  credential: string
): HostedCredential {
  return { status: 'connected', revision: '3', provider, kind, credential };
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

it('writes a codex sign-in, makes the empty workspace, sets up gh for GitHub and installs skills', async () => {
  const login = JSON.stringify({ tokens: { access_token: 'codex-placeholder' } });
  const workspace = await arrange({
    provider: 'codex',
    credential: connected('codex', 'auth-json', login),
    workspace: {
      connections: ['github'],
      skills: [{ slug: 'github', files: { 'SKILL.md': '# GitHub\n' } }],
    },
  });

  await prepareHostedAgent({ agentRoot, credentialsDirectory: credentials });

  const auth = join(agentRoot, 'provider-home', 'auth.json');
  expect(await readFile(auth, 'utf8')).toBe(login);
  expect(await modeOf(auth)).toBe(0o600);
  expect(await readdir(workspace.workspacePath)).toEqual([]);
  await expect(stat(join(agentRoot, 'repos'))).rejects.toThrow();
  expect(
    await readFile(join(agentRoot, 'provider-home', 'skills', 'github', 'SKILL.md'), 'utf8')
  ).toBe('# GitHub\n');
  const wrapper = await readFile(join(agentRoot, 'bin', 'gh'), 'utf8');
  expect(wrapper).toContain('--github-cli');
  expect(wrapper).not.toContain('token');
});

it('removes a connection skill no longer granted and keeps skills it did not install', async () => {
  const credential = connected('claude', 'setup-token', 'token-placeholder');
  const skills = join(agentRoot, 'provider-home', 'claude', 'skills');
  await arrange({
    provider: 'claude',
    credential,
    workspace: {
      connections: ['github'],
      skills: [{ slug: 'github', files: { 'SKILL.md': '# GitHub\n' } }],
    },
  });
  await prepareHostedAgent({ agentRoot, credentialsDirectory: credentials });
  await mkdir(join(skills, 'own-notes'), { recursive: true });
  await writeFile(join(skills, 'own-notes', 'SKILL.md'), '# Mine\n');
  expect((await readdir(skills)).sort()).toEqual(['github', 'own-notes']);

  await arrange({ provider: 'claude', credential, workspace: { connections: [], skills: [] } });
  await prepareHostedAgent({ agentRoot, credentialsDirectory: credentials });

  expect(await readdir(skills)).toEqual(['own-notes']);
  expect(await readFile(join(skills, 'own-notes', 'SKILL.md'), 'utf8')).toBe('# Mine\n');
});

it('keeps a skill of a connection slug that it did not install', async () => {
  const skills = join(agentRoot, 'provider-home', 'claude', 'skills');
  await mkdir(join(skills, 'github'), { recursive: true });
  await writeFile(join(skills, 'github', 'SKILL.md'), '# Mine\n');
  await arrange({
    provider: 'claude',
    credential: connected('claude', 'setup-token', 'token-placeholder'),
  });

  await prepareHostedAgent({ agentRoot, credentialsDirectory: credentials });

  expect(await readFile(join(skills, 'github', 'SKILL.md'), 'utf8')).toBe('# Mine\n');
});

it('keeps what an existing workspace holds', async () => {
  const workspace = await arrange({
    provider: 'claude',
    credential: connected('claude', 'setup-token', 'token-placeholder'),
    workspace: { connections: ['github'] },
  });
  await mkdir(workspace.workspacePath, { recursive: true });
  await writeFile(join(workspace.workspacePath, 'notes.md'), 'kept\n');

  await prepareHostedAgent({ agentRoot, credentialsDirectory: credentials });

  expect(await readFile(join(workspace.workspacePath, 'notes.md'), 'utf8')).toBe('kept\n');
});

it("hands the unit's sessions its credentials and the gh wrapper when GitHub is granted", async () => {
  await arrange({
    provider: 'claude',
    credential: connected('claude', 'setup-token', 'token-placeholder'),
    workspace: { connections: ['github'] },
  });
  await prepareHostedAgent({ agentRoot, credentialsDirectory: credentials });

  const env = await hostedUnitGitHubEnvironment(agentRoot, config('claude'));

  expect(env).toEqual({
    SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS: join(credentials, 'agent'),
    SWITCH_HOSTED_GITHUB_CLI: join(agentRoot, 'bin'),
  });
  expect((await stat(join(env.SWITCH_HOSTED_GITHUB_CLI!, 'gh'))).isFile()).toBe(true);
});

it('hands sessions nothing, and writes no gh wrapper, without a GitHub grant', async () => {
  await arrange({
    provider: 'claude',
    credential: connected('claude', 'setup-token', 'token-placeholder'),
    workspace: { connections: ['linear'] },
  });
  await prepareHostedAgent({ agentRoot, credentialsDirectory: credentials });

  expect(await hostedUnitGitHubEnvironment(agentRoot, config('claude'))).toEqual({});
  await expect(stat(join(agentRoot, 'bin', 'gh'))).rejects.toThrow();
});

it.each([
  ['opencode', join('provider-data', 'opencode', 'auth.json')],
  ['antigravity', join('provider-home', 'antigravity-acp', 'acp_token.json')],
] as const)('writes a %s sign-in into its provider home', async (provider, relative) => {
  const login = JSON.stringify({ token: `${provider}-placeholder` });
  const workspace = await arrange({
    provider,
    credential: connected(provider, 'auth-json', login),
  });

  await prepareHostedAgent({ agentRoot, credentialsDirectory: credentials });

  expect(await readFile(join(agentRoot, relative), 'utf8')).toBe(login);
  expect(await modeOf(join(agentRoot, relative))).toBe(0o600);
  expect((await stat(workspace.workspacePath)).isDirectory()).toBe(true);
  await expect(stat(join(agentRoot, 'bin', 'gh'))).rejects.toThrow();
});

it.each([
  ['claude', 'setup-token'],
  ['cursor', 'api-key'],
] as const)(
  'writes nothing for a %s sign-in, which reaches the unit as environment',
  async (provider, kind) => {
    await arrange({ provider, credential: connected(provider, kind, 'token-placeholder') });

    await prepareHostedAgent({ agentRoot, credentialsDirectory: credentials });

    await expect(stat(join(agentRoot, 'provider-home', 'auth.json'))).rejects.toThrow();
    await expect(stat(join(agentRoot, 'provider-data', 'opencode'))).rejects.toThrow();
  }
);

it('refuses a disconnected provider', async () => {
  await arrange({ provider: 'codex', credential: { status: 'revoked' } });
  await expect(
    prepareHostedAgent({ agentRoot, credentialsDirectory: credentials })
  ).rejects.toThrow('The provider was disconnected');
});

it('refuses a sign-in for another provider', async () => {
  await arrange({ provider: 'codex', credential: connected('claude', 'api-key', 'placeholder') });
  await expect(
    prepareHostedAgent({ agentRoot, credentialsDirectory: credentials })
  ).rejects.toThrow('is for claude, not codex');
});

it('refuses a launch configuration that reads credentials from elsewhere', async () => {
  const other = config('claude');
  other.execution!.credentialsPath = join(base, 'elsewhere.json');
  await arrange({
    provider: 'claude',
    credential: connected('claude', 'api-key', 'placeholder'),
    config: other,
  });
  await expect(
    prepareHostedAgent({ agentRoot, credentialsDirectory: credentials })
  ).rejects.toThrow("reads its Switch credentials from somewhere other than this unit's");
});

it('refuses Switch credentials for another agent', async () => {
  await arrange({ provider: 'claude', credential: connected('claude', 'api-key', 'placeholder') });
  await writeFile(
    join(credentials, 'agent'),
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'http://127.0.0.1:47100',
        SWITCH_API_TOKEN: 'relay-token-placeholder',
        SWITCH_AGENT_ID: 'another-agent',
      },
    })
  );
  await expect(
    prepareHostedAgent({ agentRoot, credentialsDirectory: credentials })
  ).rejects.toThrow('belongs to a different agent');
});

it('refuses an invalid workspace description', async () => {
  await arrange({
    provider: 'claude',
    credential: connected('claude', 'api-key', 'placeholder'),
    workspace: { repository: 'example/project' } as Partial<HostedWorkspace>,
  });
  await expect(
    prepareHostedAgent({ agentRoot, credentialsDirectory: credentials })
  ).rejects.toThrow('is invalid');
});

it("seeds the watcher with a worker volume's assignments, once", async () => {
  await arrange({ provider: 'claude', credential: connected('claude', 'api-key', 'placeholder') });
  await writeFile(
    join(agentRoot, 'hosted-deployment.json'),
    JSON.stringify({ version: 1, spec: { revision: 2, session: { agentId: AGENT } }, config: {} })
  );
  await writeFile(join(agentRoot, 'state-version.json'), JSON.stringify({ version: 1 }));
  await writeFile(join(agentRoot, 'assignments.jsonl'), 'worker assignments\n');
  await writeFile(join(agentRoot, 'placements.json'), '{"placements":{}}');

  await prepareHostedAgent({ agentRoot, credentialsDirectory: credentials });
  expect(await readFile(join(agentRoot, 'watcher', 'assignments.jsonl'), 'utf8')).toBe(
    'worker assignments\n'
  );
  expect(await readFile(join(agentRoot, 'watcher', 'placements.json'), 'utf8')).toBe(
    '{"placements":{}}'
  );

  await writeFile(join(agentRoot, 'watcher', 'placements.json'), '{"placements":{"a":"b"}}');
  await rm(join(agentRoot, 'watcher', 'assignments.jsonl'));
  await prepareHostedAgent({ agentRoot, credentialsDirectory: credentials });
  await expect(stat(join(agentRoot, 'watcher', 'assignments.jsonl'))).rejects.toThrow();
});

it('refuses a worker volume that belongs to another agent', async () => {
  await arrange({ provider: 'claude', credential: connected('claude', 'api-key', 'placeholder') });
  await writeFile(
    join(agentRoot, 'hosted-deployment.json'),
    JSON.stringify({ version: 1, spec: { session: { agentId: 'another-agent' } } })
  );
  await expect(
    prepareHostedAgent({ agentRoot, credentialsDirectory: credentials })
  ).rejects.toThrow(`does not belong to agent ${AGENT}`);
});

it('refuses a worker volume whose layout migration never finished', async () => {
  await arrange({ provider: 'claude', credential: connected('claude', 'api-key', 'placeholder') });
  await writeFile(
    join(agentRoot, 'hosted-deployment.json'),
    JSON.stringify({ version: 1, spec: { session: { agentId: AGENT } } })
  );
  await expect(
    prepareHostedAgent({ agentRoot, credentialsDirectory: credentials })
  ).rejects.toThrow('layout migration never finished');
});
