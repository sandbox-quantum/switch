import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type GitHubInstallation,
  type GrantedGitHubInstallation,
  githubLaunchEnvironment,
  gitHubCredentialResponse,
  hostedGitHubEnvironment,
  listGitHubInstallations,
  ownerFromCredentialPath,
  ownerFromRemoteUrl,
  ownerFromRepoArgument,
  readGitHubCredential,
  renewGitHubCredential,
  repoArgument,
  runGitHubList,
  selectCliInstallation,
  validateGitHubCredential,
} from './hosted-github';

const roots: string[] = [];
const token = 'synthetic-github-credential';
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

it('provides credentials only for the exact GitHub HTTPS host', () => {
  expect(gitHubCredentialResponse('get', 'protocol=https\nhost=github.com\n\n', token)).toBe(
    `username=x-access-token\npassword=${token}\n\n`
  );
  for (const input of [
    'protocol=http\nhost=github.com\n',
    'protocol=https\nhost=github.com.evil.invalid\n',
    'protocol=https\nhost=github.com:443\n',
    'protocol=https\nhost=other.invalid\nhost=github.com\n',
    'protocol=https\nhost=github.com\r\n',
    'url=https://github.com\n',
  ])
    expect(gitHubCredentialResponse('get', input, token)).toBe('');
  expect(gitHubCredentialResponse('get', 'protocol=https\nhost=github.com\n', undefined)).toBe('');
  expect(gitHubCredentialResponse('store', 'protocol=https\nhost=github.com\n', token)).toBe('');
  expect(gitHubCredentialResponse('erase', 'protocol=https\nhost=github.com\n', token)).toBe('');
});

it('puts no credential in the launch environment', () => {
  expect(JSON.stringify(githubLaunchEnvironment())).not.toContain(token);
});

it.each([401, 403, 429, 500, 302])(
  'rejects GitHub status %s without exposing response content',
  async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(token, { status })));
    await expect(validateGitHubCredential(token)).rejects.toThrow(/GitHub/);
    try {
      await validateGitHubCredential(token);
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  }
);

it('uses only GitHub identity validation and refuses redirects', async () => {
  const request = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', request);
  await validateGitHubCredential(token);
  expect(request).toHaveBeenCalledWith(
    'https://api.github.com/user',
    expect.objectContaining({
      redirect: 'error',
      headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      signal: expect.any(AbortSignal),
    })
  );
});

it('sanitizes transport failures', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(token)));
  await expect(validateGitHubCredential(token)).rejects.toThrow('could not reach GitHub');
});

it('rejects invalid credentials before a request', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  for (const invalid of ['', 'two words', 'one\ntwo', 'é', 'x'.repeat(16385)])
    await expect(validateGitHubCredential(invalid)).rejects.toThrow('credential is invalid');
  expect(request).not.toHaveBeenCalled();
});

it('reads a mounted token and reports a missing file without its path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-token-'));
  roots.push(root);
  const path = join(root, 'credential');
  await writeFile(path, token + '\n', { mode: 0o600 });
  expect(await readGitHubCredential(path)).toBe(token);
  await expect(readGitHubCredential(join(root, token))).rejects.toThrow(
    'GitHub credential file is missing or invalid.'
  );
});

it('authenticates real Git credential requests without writing credentials or consulting stored helpers', async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted github's "));
  roots.push(root);
  const script = join(root, "credential helper's.mjs");
  const moduleUrl = new URL('./hosted-github.ts', import.meta.url).href;
  await writeFile(
    script,
    `import { runGitHubCredentialHelper } from ${JSON.stringify(moduleUrl)}; await runGitHubCredentialHelper(process.argv.at(-1));`
  );
  const marker = join(root, 'unexpected-helper');
  const config = join(root, '.gitconfig');
  await writeFile(config, `[credential]\n\thelper = "!touch '${marker}'"\n`);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    ...githubLaunchEnvironment(script),
    GH_TOKEN: token,
  };
  const git = (operation: string, input: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile('git', ['credential', operation], { env }, (error, stdout, stderr) =>
        resolve({ code: error ? 1 : 0, stdout, stderr })
      );
      child.stdin!.end(input);
    });
  const success = await git('fill', 'protocol=https\nhost=github.com\n\n');
  expect(success.code, success.stderr).toBe(0);
  expect(success.stdout).toContain(`password=${token}`);
  const rejected = await git('fill', 'protocol=https\nhost=other.invalid\n\n');
  expect(rejected.code).toBe(1);
  expect(rejected.stdout + rejected.stderr).not.toContain(token);
  await git(
    'approve',
    `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n\n`
  );
  await git('reject', `protocol=https\nhost=github.com\n\n`);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(config, 'utf8')).not.toContain(token);
  await expect(readFile(join(root, '.git-credentials'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('validates installation tokens against the selected repository instead of a user identity', async () => {
  const request = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', request);
  await validateGitHubCredential(token, 'example/project');
  expect(request).toHaveBeenCalledWith(
    'https://api.github.com/repos/example/project',
    expect.objectContaining({ redirect: 'error' })
  );
});

it.each([
  '../project',
  'example/..',
  'example/project?token=secret',
  'example/project/extra',
  'https://example.com/project',
])('rejects unsafe repository selection %s', async (repository) => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  await expect(validateGitHubCredential(token, repository)).rejects.toThrow('repository');
  expect(request).not.toHaveBeenCalled();
});

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

const INSTALLATIONS: GitHubInstallation[] = [
  { installation_id: 123, account: 'acme', repositories: 'all' },
  { installation_id: 456, account: 'example-user', repositories: ['example-user/demo'] },
];

const UNAVAILABLE: GrantedGitHubInstallation[] = [
  ...INSTALLATIONS,
  {
    installation_id: 789,
    account: 'stale-org',
    error: 'Your GitHub account cannot push to any repository of stale-org.',
  },
  {
    installation_id: 321,
    account: null,
    error: 'Your GitHub account no longer has access to GitHub installation 321.',
  },
];

function listing(installations: GrantedGitHubInstallation[] = INSTALLATIONS) {
  return { connections: [{ slug: 'github', installations }] };
}

function credential(installationId: number, overrides: Record<string, unknown> = {}) {
  return {
    token,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    installation_id: installationId,
    account: 'acme',
    repositories: 'all',
    ...overrides,
  };
}

async function switchCredentials(endpoint: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-github-switch-'));
  roots.push(root);
  const path = join(root, 'agent');
  await writeFile(
    path,
    JSON.stringify({
      env: { SWITCH_API_ENDPOINT: endpoint, SWITCH_API_TOKEN: 'synthetic-switch-credential' },
    })
  );
  return path;
}

describe('listing and renewal through Switch', () => {
  it('lists the granted GitHub installations, ignoring other connections', async () => {
    const credentials = await switchCredentials('https://switch.example.com/api/agent');
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            connections: [{ slug: 'linear', installations: 'whatever' }, ...listing().connections],
          })
        )
    );
    vi.stubGlobal('fetch', request);
    expect(await listGitHubInstallations(credentials)).toEqual(INSTALLATIONS);
    expect(request.mock.calls[0]).toEqual([
      'https://switch.example.com/api/agent/hosted/connections',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    ]);
  });

  it('lists a granted installation Switch could not confirm with its reason', async () => {
    const credentials = await switchCredentials('https://switch.example.com/api/agent');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(listing(UNAVAILABLE))))
    );
    expect(await listGitHubInstallations(credentials)).toEqual(UNAVAILABLE);
  });

  it.each([
    [
      403,
      { detail: 'This GitHub installation is not granted to the agent.' },
      'Could not renew GitHub access: Switch answered 403: This GitHub installation is not granted to the agent.',
    ],
    [
      422,
      { detail: 'The owner must reconnect GitHub.', code: 'github_reconnect_required' },
      "Could not renew GitHub access: Switch answered 422 (github_reconnect_required): The owner must reconnect GitHub. The agent's owner must reconnect GitHub in Switch.",
    ],
    [
      409,
      { detail: 'The agent or its GitHub connection changed.\nPlease retry.' },
      'Could not renew GitHub access: Switch answered 409: The agent or its GitHub connection changed. Please retry.',
    ],
  ])('names the reason Switch gives for refusing with %s', async (status, body, message) => {
    const credentials = await switchCredentials('https://switch.example.com/api/agent');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status }))
    );
    await expect(renewGitHubCredential(credentials, 123)).rejects.toThrow(message);
  });

  it('names the status, and only the status, when Switch gives no JSON reason', async () => {
    const credentials = await switchCredentials('https://switch.example.com/api/agent');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>remote-secret-body</html>', { status: 503 }))
    );
    const failure = listGitHubInstallations(credentials);
    await expect(failure).rejects.toThrow(
      'Could not read the GitHub access granted to this agent: Switch answered 503'
    );
    await expect(failure).rejects.not.toThrow('remote-secret-body');
  });

  it('prints each granted account for --list, with the reason for one that is unavailable', async () => {
    vi.stubEnv(
      'SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS',
      await switchCredentials('https://switch.example.com/api/agent')
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(listing(UNAVAILABLE))))
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runGitHubList();
      expect(log.mock.calls.map(([line]) => line)).toEqual([
        'acme: all repositories',
        'example-user: example-user/demo',
        'stale-org: unavailable: Your GitHub account cannot push to any repository of stale-org.',
        'installation 321: unavailable: Your GitHub account no longer has access to GitHub installation 321.',
      ]);
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('lists nothing when GitHub is not among the grants', async () => {
    const credentials = await switchCredentials('https://switch.example.com/api/agent');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ connections: [] })))
    );
    expect(await listGitHubInstallations(credentials)).toEqual([]);
  });

  it('renews a token for exactly the installation asked for, and hides failed bodies', async () => {
    const credentials = await switchCredentials('https://switch.example.com/api/agent');
    const request = vi.fn(async () => new Response(JSON.stringify(credential(123))));
    vi.stubGlobal('fetch', request);
    expect(await renewGitHubCredential(credentials, 123)).toBe(token);
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://switch.example.com/api/agent/hosted/connections/github/credential');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(init.body))).toEqual({ installation_id: 123 });
    await expect(renewGitHubCredential(credentials, 456)).rejects.toThrow('Could not renew');
    request.mockImplementation(async () => new Response('remote-secret-body', { status: 403 }));
    await expect(renewGitHubCredential(credentials, 123)).rejects.toThrow('Could not renew');
    try {
      await renewGitHubCredential(credentials, 123);
    } catch (error) {
      expect(String(error)).not.toContain('remote-secret-body');
    }
  });

  it('refuses a token about to expire', async () => {
    const credentials = await switchCredentials('https://switch.example.com/api/agent');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              credential(123, { expires_at: new Date(Date.now() + 1_000).toISOString() })
            )
          )
      )
    );
    await expect(renewGitHubCredential(credentials, 123)).rejects.toThrow('Could not renew');
  });

  it("reaches Switch over plain HTTP only through an agents controller's relay on this machine", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(credential(123))));
    vi.stubGlobal('fetch', request);
    expect(
      await renewGitHubCredential(await switchCredentials('http://127.0.0.1:47100'), 123)
    ).toBe(token);
    expect((request.mock.calls as unknown[][])[0]?.[0]).toBe(
      'http://127.0.0.1:47100/hosted/connections/github/credential'
    );
    for (const remote of ['http://switch.example.com', 'http://127.0.0.1.example.com:47100']) {
      const credentials = await switchCredentials(remote);
      await expect(renewGitHubCredential(credentials, 123)).rejects.toThrow('Could not renew');
      await expect(listGitHubInstallations(credentials)).rejects.toThrow('Could not read');
    }
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([409, 503, 422])('retries only for retryable status %s', async (status) => {
    const credentials = await switchCredentials('https://switch.example.com/api/agent');
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('unavailable', { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify(credential(123))));
    vi.stubGlobal('fetch', request);
    if (status === 422) {
      await expect(renewGitHubCredential(credentials, 123)).rejects.toThrow('Could not renew');
      expect(request).toHaveBeenCalledTimes(1);
    } else {
      expect(await renewGitHubCredential(credentials, 123)).toBe(token);
      expect(request).toHaveBeenCalledTimes(2);
    }
  });
});

describe('hostedGitHubEnvironment', () => {
  const host = {
    SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS: '/run/credentials/unit/agent',
    SWITCH_HOSTED_GITHUB_CLI: '/data/agents/agent/bin',
  };

  it('gives nothing on a host that is not an agent unit granted GitHub', () => {
    expect(hostedGitHubEnvironment({}, '/usr/bin:/bin')).toEqual({});
  });

  it("points git's helper and gh at the unit's credentials, ahead of anything else on PATH", () => {
    const env = hostedGitHubEnvironment(host, '/data/agents/agent/bin:/usr/local/bin:/usr/bin');
    expect(env).toMatchObject({
      ...githubLaunchEnvironment(),
      SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS: '/run/credentials/unit/agent',
      PATH: '/data/agents/agent/bin:/usr/local/bin:/usr/bin',
    });
    expect(env).not.toHaveProperty('SWITCH_HOSTED_GITHUB_REPOSITORY');
    expect(env.GIT_CONFIG_VALUE_1).toContain('--git-credential');
    expect(env).toMatchObject({
      GIT_CONFIG_KEY_3: 'credential.https://github.com.useHttpPath',
      GIT_CONFIG_VALUE_3: 'true',
    });
    expect(hostedGitHubEnvironment(host, undefined).PATH).toBe('/data/agents/agent/bin');
  });

  it('refuses a host that sets only some of its variables', () => {
    expect(() =>
      hostedGitHubEnvironment({ SWITCH_HOSTED_GITHUB_CLI: '/data/agents/agent/bin' }, '/bin')
    ).toThrow('set together');
  });
});

describe('owners', () => {
  it('reads the owner from a credential request path', () => {
    expect(ownerFromCredentialPath('acme/project.git')).toBe('acme');
    expect(ownerFromCredentialPath('Acme/project')).toBe('Acme');
    expect(ownerFromCredentialPath(undefined)).toBeNull();
    expect(ownerFromCredentialPath('../x')).toBeNull();
  });

  it('reads the owner from the -R forms gh accepts, and from github.com remotes only', () => {
    expect(ownerFromRepoArgument('acme/project')).toBe('acme');
    expect(ownerFromRepoArgument('github.com/acme/project')).toBe('acme');
    expect(ownerFromRepoArgument('https://github.com/acme/project.git')).toBe('acme');
    expect(ownerFromRepoArgument('gitlab.example.com/acme/project')).toBeNull();
    expect(ownerFromRepoArgument('project')).toBeNull();
    expect(ownerFromRemoteUrl('git@github.com:acme/project.git')).toBe('acme');
    expect(ownerFromRemoteUrl('ssh://git@github.com/acme/project.git')).toBe('acme');
    expect(ownerFromRemoteUrl('https://github.com/acme/project')).toBe('acme');
    expect(ownerFromRemoteUrl('https://gitlab.example.com/acme/project.git')).toBeNull();
    expect(ownerFromRemoteUrl('git@gitlab.example.com:acme/project.git')).toBeNull();
  });

  it('finds -R/--repo in a gh command line, before any --', () => {
    expect(repoArgument(['pr', 'list', '-R', 'acme/x'])).toBe('acme/x');
    expect(repoArgument(['pr', 'list', '-Racme/x'])).toBe('acme/x');
    expect(repoArgument(['pr', 'list', '--repo', 'acme/x'])).toBe('acme/x');
    expect(repoArgument(['pr', 'list', '--repo=acme/x'])).toBe('acme/x');
    expect(repoArgument(['pr', 'create', '--', '-R', 'acme/x'])).toBeUndefined();
    expect(repoArgument(['pr', 'list'])).toBeUndefined();
  });
});

describe('selectCliInstallation', () => {
  const select = (input: {
    args?: string[];
    ghRepo?: string;
    origin?: string | null;
    installations?: GrantedGitHubInstallation[];
  }) => {
    const originUrl = vi.fn(async () => input.origin ?? null);
    return {
      originUrl,
      result: selectCliInstallation({
        installations: input.installations ?? INSTALLATIONS,
        args: input.args ?? ['pr', 'list'],
        ghRepo: input.ghRepo,
        originUrl,
      }),
    };
  };

  it('picks by the -R owner first, without regard to case', async () => {
    const { result, originUrl } = select({
      args: ['pr', 'list', '-R', 'Example-User/demo'],
      ghRepo: 'acme/x',
      origin: 'https://github.com/acme/x.git',
    });
    expect((await result).installation_id).toBe(456);
    expect(originUrl).not.toHaveBeenCalled();
  });

  it('picks by the repository a gh repo command names', async () => {
    const { result } = select({ args: ['repo', 'clone', 'example-user/demo', '--', '--depth=1'] });
    expect((await result).installation_id).toBe(456);
  });

  it('picks by GH_REPO next', async () => {
    const { result, originUrl } = select({
      ghRepo: 'example-user/demo',
      origin: 'https://github.com/acme/x.git',
    });
    expect((await result).installation_id).toBe(456);
    expect(originUrl).not.toHaveBeenCalled();
  });

  it("picks by the current directory's github.com origin next", async () => {
    expect((await select({ origin: 'git@github.com:acme/x.git' }).result).installation_id).toBe(
      123
    );
  });

  it('uses the only granted installation when nothing names an owner', async () => {
    const { result } = select({
      installations: [INSTALLATIONS[1]!],
      origin: 'https://gitlab.example.com/acme/x.git',
    });
    expect((await result).installation_id).toBe(456);
  });

  it('fails naming the granted accounts when several are granted and nothing names one', async () => {
    await expect(select({}).result).rejects.toThrow(
      /Several GitHub accounts are granted to this agent \(acme, example-user\); pass -R owner\/repo/
    );
  });

  it('fails naming the granted accounts for an owner that is not granted', async () => {
    await expect(select({ args: ['pr', 'list', '-R', 'other/x'] }).result).rejects.toThrow(
      "GitHub account 'other' is not granted to this agent. Granted accounts: acme, example-user."
    );
  });

  it("fails with Switch's reason for a granted installation it could not confirm", async () => {
    await expect(
      select({ installations: UNAVAILABLE, args: ['pr', 'list', '-R', 'Stale-Org/x'] }).result
    ).rejects.toThrow(
      'GitHub access to stale-org granted to this agent is unavailable: Your GitHub account cannot push to any repository of stale-org.'
    );
    await expect(select({ installations: [UNAVAILABLE[3]!] }).result).rejects.toThrow(
      'GitHub access to installation 321 granted to this agent is unavailable'
    );
  });

  it('still picks a healthy installation beside one Switch could not confirm', async () => {
    const { result } = select({ installations: UNAVAILABLE, ghRepo: 'acme/x' });
    expect((await result).installation_id).toBe(123);
  });

  it('names an installation Switch could not confirm among the granted accounts', async () => {
    await expect(
      select({ installations: UNAVAILABLE, args: ['pr', 'list', '-R', 'other/x'] }).result
    ).rejects.toThrow(
      'Granted accounts: acme, example-user, stale-org (unavailable: Your GitHub account cannot push to any repository of stale-org.), installation 321 (unavailable: Your GitHub account no longer has access to GitHub installation 321.).'
    );
  });

  it('fails when no installation is granted', async () => {
    await expect(select({ installations: [] }).result).rejects.toThrow(
      'No GitHub account is granted to this agent.'
    );
  });
});

describe('the git credential helper against a relay', () => {
  async function relay(installations: GrantedGitHubInstallation[] = INSTALLATIONS) {
    const requests: { method: string; url: string; body: string; auth: string }[] = [];
    const server = createServer(async (req: IncomingMessage, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      requests.push({
        method: req.method!,
        url: req.url!,
        body,
        auth: req.headers.authorization ?? '',
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/hosted/connections')
        return res.end(JSON.stringify(listing(installations)));
      if (req.method === 'POST' && req.url === '/hosted/connections/github/credential') {
        const installationId = (JSON.parse(body) as { installation_id: number }).installation_id;
        return res.end(
          JSON.stringify(credential(installationId, { token: `${token}-${installationId}` }))
        );
      }
      res.statusCode = 404;
      res.end('{}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    return { requests, credentials: await switchCredentials(`http://127.0.0.1:${port}`) };
  }

  async function helperGit(credentials: string) {
    const root = await mkdtemp(join(tmpdir(), 'hosted-github-helper-'));
    roots.push(root);
    const script = join(root, 'helper.mjs');
    const moduleUrl = new URL('./hosted-github.ts', import.meta.url).href;
    await writeFile(
      script,
      `import { runGitHubCredentialHelper } from ${JSON.stringify(moduleUrl)}; await runGitHubCredentialHelper(process.argv.at(-1));`
    );
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      ...githubLaunchEnvironment(script),
      SWITCH_HOSTED_GITHUB_REFRESH_CREDENTIALS: credentials,
    };
    return (input: string) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = execFile('git', ['credential', 'fill'], { env }, (error, stdout, stderr) =>
          resolve({ code: error ? 1 : 0, stdout, stderr })
        );
        child.stdin!.end(input);
      });
  }

  it('answers the token of the installation that owns the repository in the path', async () => {
    const { requests, credentials } = await relay();
    const git = await helperGit(credentials);
    const result = await git('url=https://github.com/Example-User/demo.git\n\n');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`password=${token}-456`);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /hosted/connections',
      'POST /hosted/connections/github/credential',
    ]);
    expect(JSON.parse(requests[1]!.body)).toEqual({ installation_id: 456 });
    expect(requests[0]!.auth).toBe('Bearer synthetic-switch-credential');
  });

  it('answers nothing for an owner that is not granted, and says which accounts are', async () => {
    const { requests, credentials } = await relay();
    const git = await helperGit(credentials);
    const result = await git('url=https://github.com/other/project.git\n\n');
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('password=');
    expect(result.stderr).toContain(
      "GitHub account 'other' is not granted to this agent. Granted accounts: acme, example-user."
    );
    expect(requests.map((request) => request.method)).toEqual(['GET']);
  });

  it("answers nothing for an installation Switch could not confirm, and gives Switch's reason", async () => {
    const { requests, credentials } = await relay(UNAVAILABLE);
    const git = await helperGit(credentials);
    const result = await git('url=https://github.com/stale-org/project.git\n\n');
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('password=');
    expect(result.stderr).toContain(
      'GitHub access to stale-org granted to this agent is unavailable: Your GitHub account cannot push to any repository of stale-org.'
    );
    expect(requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('answers a healthy installation beside one Switch could not confirm', async () => {
    const { credentials } = await relay(UNAVAILABLE);
    const git = await helperGit(credentials);
    const result = await git('url=https://github.com/acme/project.git\n\n');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`password=${token}-123`);
  });
});
