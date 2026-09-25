import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  githubLaunchEnvironment,
  githubRedactions,
  gitHubCredentialResponse,
  readGitHubCredential,
  renewGitHubCredential,
  validateGitHubCredential,
} from './hosted-github';
import { redactHostedText } from './hosted-log';

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

it('renews only the assigned repository credential and hides failed response bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hosted-github-refresh-'));
  roots.push(root);
  const credentials = join(root, 'switch.json');
  await writeFile(
    credentials,
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'https://switch.example.com/api/agent',
        SWITCH_API_TOKEN: 'synthetic-switch-credential',
      },
    })
  );
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          token,
          repository: 'example/project',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
      )
  );
  vi.stubGlobal('fetch', request);
  expect(await renewGitHubCredential(credentials, 'example/project')).toBe(token);
  expect(request.mock.calls[0]).toEqual([
    'https://switch.example.com/api/agent/hosted/github-credential',
    expect.objectContaining({ method: 'POST', redirect: 'error' }),
  ]);
  await expect(renewGitHubCredential(credentials, 'example/other')).rejects.toThrow(
    'Could not renew'
  );
  request.mockImplementation(async () => new Response('remote-secret-body', { status: 403 }));
  await expect(renewGitHubCredential(credentials, 'example/project')).rejects.toThrow(
    'Could not renew'
  );
});

it('keeps raw and common transport encodings out of redacted output', () => {
  const secrets = githubRedactions(token);
  for (const value of secrets) expect(redactHostedText(value, secrets)).toBe('[REDACTED]');
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
  await expect(readFile(join(root, '.git-credentials'))).rejects.toMatchObject({ code: 'ENOENT' });
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

it.each([409, 503, 422])('retries a token renewal only for retryable status %s', async (status) => {
  const root = await mkdtemp(join(tmpdir(), 'hosted-github-retry-'));
  roots.push(root);
  const path = join(root, 'switch.json');
  await writeFile(
    path,
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'https://switch.example.com/api/agent',
        SWITCH_API_TOKEN: 'synthetic-switch-credential',
      },
    })
  );
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response('unavailable', { status }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token,
          repository: 'example/project',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
      )
    );
  vi.stubGlobal('fetch', request);
  if (status === 422) {
    await expect(renewGitHubCredential(path, 'example/project')).rejects.toThrow('Could not renew');
    expect(request).toHaveBeenCalledTimes(1);
  } else {
    expect(await renewGitHubCredential(path, 'example/project')).toBe(token);
    expect(request).toHaveBeenCalledTimes(2);
  }
});
