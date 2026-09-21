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
