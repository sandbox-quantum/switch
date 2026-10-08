import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Redactions } from './redaction';
import { type ServiceEndpointServer, startServiceEndpoint } from './service-endpoint';
import {
  githubSessionEnvironment,
  parseCredentialRequest,
  sessionServiceToken,
  writeGitHubWrapper,
} from './service-github';
import type { HostAsk } from './session-channel';

const roots: string[] = [];
const servers: ServiceEndpointServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Git credential requests', () => {
  it('accepts the keys newer Git repeats, and no other repeated key', () => {
    expect(
      parseCredentialRequest(
        'capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=github.com\n\n'
      )?.get('capability[]')
    ).toEqual(['authtype', 'state']);
    expect(parseCredentialRequest('protocol=https\nhost=other.invalid\nhost=github.com\n')).toBe(
      null
    );
    expect(parseCredentialRequest('protocol=https\nhost=github.com\r\n')).toBe(null);
    expect(parseCredentialRequest('no equals sign\n')).toBe(null);
  });

  it('adds its entries after the Git configuration the environment already has', () => {
    const env = githubSessionEnvironment({
      env: { GIT_CONFIG_COUNT: '1', PATH: '/usr/bin' },
      execPath: '/usr/bin/node',
      entrypoint: '/opt/switch/shared-host.mjs',
      wrapperDirectory: '/state/bin',
      isolate: false,
    });
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_2:
        "!ELECTRON_RUN_AS_NODE=1 '/usr/bin/node' '/opt/switch/shared-host.mjs' --git-credential",
      PATH: '/state/bin:/usr/bin',
    });
  });

  it('asks only a loopback endpoint', async () => {
    for (const endpoint of [
      'http://switch.example.test:5555',
      'https://127.0.0.1:5555',
      'http://127.0.0.1:5555/elsewhere',
    ])
      await expect(
        sessionServiceToken('github', null, {
          SWITCH_SERVICE_ENDPOINT: endpoint,
          SWITCH_SERVICE_TOKEN: 'bearer',
        })
      ).rejects.toThrow('must be on 127.0.0.1');
  });
});

describe.skipIf(process.platform === 'win32')('a session with a GitHub grant', () => {
  async function session(isolate: boolean) {
    const root = await mkdtemp(join(tmpdir(), "service github's "));
    roots.push(root);
    const asks: HostAsk[] = [];
    const tokens = ['synthetic-first', 'synthetic-second'];
    const endpoint = await startServiceEndpoint({
      services: ['github'],
      unavailable: null,
      redactions: new Redactions(),
      ask: async (ask) => {
        asks.push(ask);
        return {
          kind: 'token',
          token: tokens[Math.min(asks.length - 1, tokens.length - 1)]!,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
      },
    });
    servers.push(endpoint);
    // What the session host's bundle does in its helper modes (`shared-daemon.ts`).
    const entrypoint = join(root, "host bundle's.mjs");
    const moduleUrl = new URL('./service-github.ts', import.meta.url).href;
    await writeFile(
      entrypoint,
      [
        `import { runGitCredentialHelper, runGitHubCli } from ${JSON.stringify(moduleUrl)};`,
        'const [mode, arg] = process.argv.slice(2);',
        'try {',
        "  if (mode === '--git-credential') await runGitCredentialHelper(arg, { stdin: process.stdin, stdout: process.stdout, env: process.env });",
        '  else process.exitCode = await runGitHubCli(arg, process.argv.slice(4), process.env);',
        '} catch (error) { process.stderr.write(`switch: ${error.message}\\n`); process.exitCode = 1; }',
      ].join('\n')
    );
    // The user's own helper, which answers for every host it is asked about.
    await writeFile(
      join(root, '.gitconfig'),
      '[credential]\n\thelper = "!f() { echo username=user; echo password=user-password; }; f"\n'
    );
    const wrapperDirectory = join(root, 'bin');
    await writeGitHubWrapper({
      directory: wrapperDirectory,
      execPath: process.execPath,
      entrypoint,
    });
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      ...githubSessionEnvironment({
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        execPath: process.execPath,
        entrypoint,
        wrapperDirectory,
        isolate,
      }),
      SWITCH_SERVICE_ENDPOINT: endpoint.url,
      SWITCH_SERVICE_TOKEN: endpoint.token,
    };
    const git = (operation: string, input: string) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = execFile('git', ['credential', operation], { env }, (error, stdout, stderr) =>
          resolve({ code: error ? 1 : 0, stdout, stderr })
        );
        child.stdin!.end(input);
      });
    return { root, env, asks, git, wrapperDirectory };
  }

  it("answers Git for github.com with the agent's token, leaving other hosts to the user", async () => {
    const s = await session(false);
    const github = await s.git(
      'fill',
      'capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=github.com\n\n'
    );
    expect(github.code, github.stderr).toBe(0);
    expect(github.stdout).toContain('username=x-access-token\npassword=synthetic-first');
    expect(github.stdout).not.toContain('user-password');
    expect(s.asks).toEqual([{ type: 'service-token', service: 'github', rejected: null }]);

    const other = await s.git('fill', 'protocol=https\nhost=other.invalid\n\n');
    expect(other.stdout).toContain('password=user-password');

    await s.git(
      'reject',
      'protocol=https\nhost=github.com\nusername=x-access-token\npassword=synthetic-first\n\n'
    );
    expect(s.asks.at(-1)).toEqual({
      type: 'service-token',
      service: 'github',
      rejected: 'synthetic-first',
    });
    await expect(readFile(join(s.root, '.git-credentials'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps every other credential helper out in the cloud', async () => {
    const s = await session(true);
    const github = await s.git('fill', 'protocol=https\nhost=github.com\n\n');
    expect(github.stdout).toContain('password=synthetic-first');
    const other = await s.git('fill', 'protocol=https\nhost=other.invalid\n\n');
    expect(other.code).toBe(1);
    expect(other.stdout).not.toContain('user-password');
  });

  async function fakeGitHubCli(root: string, script: string): Promise<string> {
    const directory = join(root, 'real-gh');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'gh'), `#!/bin/sh\n${script}\n`);
    await chmod(join(directory, 'gh'), 0o755);
    return directory;
  }

  function runWrapper(s: Awaited<ReturnType<typeof session>>, directory: string, args: string[]) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(join(s.wrapperDirectory, 'gh'), args, {
        env: { ...s.env, PATH: `${s.wrapperDirectory}:${directory}:/usr/bin:/bin` },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }

  it('runs the real gh with the token, passing over itself on PATH', async () => {
    const s = await session(false);
    const directory = await fakeGitHubCli(
      s.root,
      'echo "args=$* token=$GH_TOKEN node=${ELECTRON_RUN_AS_NODE:-unset}"'
    );
    const ran = await runWrapper(s, directory, ['pr', 'list']);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout.trim()).toBe('args=pr list token=synthetic-first node=unset');
  });

  it('reports a token GitHub refused, so the next command has another', async () => {
    const s = await session(false);
    const directory = await fakeGitHubCli(
      s.root,
      'echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2; exit 1'
    );
    const ran = await runWrapper(s, directory, ['pr', 'view']);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('HTTP 401: Bad credentials');
    expect(ran.stderr).toContain('the next git or gh command has a new one');
    expect(s.asks).toEqual([
      { type: 'service-token', service: 'github', rejected: null },
      { type: 'service-token', service: 'github', rejected: 'synthetic-first' },
    ]);
  });
});
