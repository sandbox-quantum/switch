import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HttpMcpServerSpec } from '../adapter';
import { Redactions } from './redaction';
import type { CliTool, ServiceGrant, ServiceTokenAnswer } from './service-access';
import type { HostAsk } from './session-channel';
import {
  checkCommand,
  CommandRefused,
  refusedToken,
  runEnvironment,
  startVendorClis,
} from './vendor-cli';

const GOOD = 'synthetic-cli-token-the-vendor-takes';
const STALE = 'stale-synthetic-cli-token-the-vendor-refuses';

/**
 * A stand-in for a vendor's tool, never the real one: it answers by its
 * second argument, refuses a token that starts with `stale`, and says what it
 * was given, its token only as a hash unless asked to leak it.
 */
const FAKE = `
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const [, , , what, ...rest] = process.argv;
const token = process.env.EXCLI_TOKEN ?? '';
if (token.startsWith('stale')) {
  console.log(JSON.stringify({ error: { code: 401, message: 'Invalid credentials' } }));
  process.exit(1);
}
const after = (flag) => rest[rest.indexOf(flag) + 1];
switch (what) {
  case 'env':
    console.log(JSON.stringify({
      keys: Object.keys(process.env).sort(),
      token: createHash('sha256').update(token).digest('hex'),
      config: process.env.EXCLI_CONFIG_DIR,
      home: process.env.HOME,
      cwd: process.cwd(),
      dotenv: existsSync('.env') ? statSync('.env').size : null,
    }));
    break;
  case 'argv':
    console.log(JSON.stringify(process.argv.slice(2)));
    break;
  case 'leak':
    console.log('stdout ' + token);
    console.error('stderr ' + token);
    process.exit(3);
  case 'big':
    process.stdout.write('x'.repeat(Number(rest[0])));
    break;
  case 'sleep':
    setTimeout(() => console.log('woke'), Number(rest[0]));
    break;
  case 'write': {
    const flag = rest.find((arg) => arg.startsWith('-o') || arg.startsWith('--output'));
    const path = flag === '--output' || flag === '-o' ? after(flag) : flag.replace(/^(--output=|-o=?)/, '');
    writeFileSync(path, 'report from the vendor');
    console.log('saved ' + path);
    break;
  }
  case 'read': {
    const path = after('--upload');
    console.log(basename(path) + ' ' + readFileSync(path, 'utf8'));
    break;
  }
  case '+put':
    console.log(basename(rest[0]) + ' ' + readFileSync(rest[0], 'utf8'));
    break;
  case 'download':
    writeFileSync('download.pdf', '%PDF');
    console.log(JSON.stringify({ saved_file: 'download.pdf' }));
    break;
  case 'fail':
    console.log(JSON.stringify({ error: { code: 403, message: 'Forbidden' } }));
    process.exit(1);
  default:
    console.log('ok ' + what);
}
`;

const TOOL: CliTool = {
  name: 'example-cli',
  binary: 'excli',
  token_env: 'EXCLI_TOKEN',
  config_env: 'EXCLI_CONFIG_DIR',
  allow: ['items', 'boards'],
  deny: ['auth', '--profile'],
  path_flags: { '--upload': 'read', '--output': 'write', '-o': 'write' },
  path_args: [{ after: '+put', direction: 'read' }],
  output_cap_bytes: 2048,
  timeout_s: 30,
  token_refused: { exit_code: 1, json_path: 'error.code', value: 401 },
  release: { version: '1.2.3', targets: {} },
};

function grant(tool: CliTool = TOOL): ServiceGrant {
  return {
    service: 'example',
    access: 'write',
    tool_mode: 'deny',
    tools: [],
    resources: {},
    skill: null,
    mcp_servers: [],
    cli_tools: [tool],
  };
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Variables a POSIX shell sets for itself, which the test's wrapper adds. */
const SHELL_SETS = ['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING'];

describe('checkCommand', () => {
  const refused = (args: unknown) => () => checkCommand(TOOL, args);

  it('takes an allowed command and finds its file arguments in every form', () => {
    const checked = checkCommand(TOOL, [
      'items',
      'get',
      '--output',
      'a.bin',
      '--output=b.bin',
      '-o',
      'c.bin',
      '-o=d.bin',
      '-oe.bin',
      '--upload',
      'in.txt',
      '--params',
      '{"q":"--output"}',
    ]);
    expect(checked.paths.map(({ prefix, path, direction }) => [prefix, path, direction])).toEqual([
      ['', 'a.bin', 'write'],
      ['--output=', 'b.bin', 'write'],
      ['', 'c.bin', 'write'],
      ['-o=', 'd.bin', 'write'],
      ['-o', 'e.bin', 'write'],
      ['', 'in.txt', 'read'],
    ]);
  });

  it.each([
    [['auth', 'login'], 'not available'],
    [['gmail', 'users'], 'not available'],
    [['items:v2', 'list'], 'not available'],
    [['--profile', 'x', 'items'], 'not available'],
    [['items', '--profile=work'], '`--profile` is not available'],
    [['items', '--profile', 'work'], '`--profile` is not available'],
    [['items', '-ho', 'x.bin'], 'may not be combined'],
    [['items', '--output'], 'needs a file path'],
    [['items', '--output='], 'needs a file path'],
    [['items', '--', '--output', 'x'], '`--` is not accepted'],
    [[], 'Give a command'],
    ['items list', 'list of strings'],
    [['items', 'a\0b'], 'NUL'],
  ])('refuses %j', (args, message) => {
    expect(refused(args)).toThrow(CommandRefused);
    expect(refused(args)).toThrow(message);
  });

  it('finds a positional file argument after its word, wherever the word stands', () => {
    expect(checkCommand(TOOL, ['items', '+put', 'a.txt', '--name', 'A']).paths).toEqual([
      { index: 2, prefix: '', path: 'a.txt', direction: 'read' },
    ]);
    expect(checkCommand(TOOL, ['items', '--format', 'json', '+put', '/etc/hosts']).paths).toEqual([
      { index: 4, prefix: '', path: '/etc/hosts', direction: 'read' },
    ]);
  });

  it.each([[['items', '+put']], [['items', '+put', '--name', 'x', 'a.txt']]])(
    'refuses a positional file argument that is not right after its word: %j',
    (args) => {
      expect(refused(args)).toThrow('takes a file path right after it');
    }
  );

  it('lets a negative number through as a value', () => {
    expect(checkCommand(TOOL, ['items', 'list', '--offset', '-10']).paths).toEqual([]);
  });
});

describe('refusedToken', () => {
  it('reads the catalog’s exit code and JSON value, and nothing else', () => {
    expect(refusedToken(TOOL, 1, '{"error":{"code":401}}')).toBe(true);
    expect(refusedToken(TOOL, 1, '{"error":{"code":403}}')).toBe(false);
    expect(refusedToken(TOOL, 2, '{"error":{"code":401}}')).toBe(false);
    expect(refusedToken(TOOL, 1, 'error 401')).toBe(false);
  });
});

describe('runEnvironment', () => {
  it('holds the token, the folders and the host’s network settings, and nothing else', () => {
    const env = runEnvironment({
      tool: TOOL,
      token: GOOD,
      home: '/h',
      config: '/c',
      tmp: '/t',
      hostEnv: {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://proxy.example.test:3128',
        SSL_CERT_FILE: '/etc/ca.pem',
        SWITCH_API_TOKEN: 'switch-secret',
        GH_TOKEN: 'other-secret',
      },
      platform: 'linux',
    });
    expect(env).toEqual({
      HTTPS_PROXY: 'http://proxy.example.test:3128',
      SSL_CERT_FILE: '/etc/ca.pem',
      HOME: '/h',
      TMPDIR: '/t',
      EXCLI_CONFIG_DIR: '/c',
      EXCLI_TOKEN: GOOD,
    });
  });
});

describe.skipIf(process.platform === 'win32')('startVendorClis', () => {
  let root: string;
  let binary: string;
  const closers: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vendor-cli-'));
    const fake = join(root, 'fake-excli.mjs');
    await writeFile(fake, FAKE);
    binary = join(root, 'excli');
    // Run directly, as the real binary would be: the wrapper only hands
    // every argument on as it came.
    await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    await chmod(binary, 0o755);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  let session: string;
  let state: string;
  beforeEach(async () => {
    session = await mkdtemp(join(root, 'session-'));
    state = await mkdtemp(join(root, 'state-'));
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function started(answers: ServiceTokenAnswer[], tool: CliTool = TOOL) {
    const asked: HostAsk[] = [];
    const redactions = new Redactions();
    const servers = await startVendorClis({
      grants: [grant(tool)],
      ask: async (ask) => {
        asked.push(ask);
        const next = answers.shift();
        if (!next) throw new Error('no answer left');
        return next;
      },
      redactions,
      cwd: session,
      stateDir: state,
      binary: async () => binary,
      hostEnv: { PATH: process.env.PATH, HTTPS_PROXY: 'http://proxy.example.test:3128' },
      platform: process.platform,
    });
    closers.push(servers.close);
    const spec = servers.specs['example-cli'] as HttpMcpServerSpec;
    const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: spec.headers },
    });
    const client = new Client({ name: 'coding-tool', version: '1.0.0' });
    await client.connect(transport);
    closers.push(() => client.close());
    const run = async (args: unknown) => {
      const result = (await client.callTool({ name: 'excli', arguments: { args } })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      return { isError: result.isError ?? false, text: result.content[0].text };
    };
    return { asked, redactions, servers, client, run, spec };
  }

  const token = (value: string): ServiceTokenAnswer => ({
    kind: 'token',
    token: value,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  it('offers one tool, behind a bearer the coding tool is given, with no token in sight', async () => {
    const { client, spec, asked } = await started([]);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['excli']);
    expect(tools[0].description).toContain('items, boards');
    expect(JSON.stringify(spec)).not.toContain(GOOD);
    expect(asked).toEqual([]);
  });

  it('runs in a folder of its own with only its token, folders and the host’s network settings', async () => {
    const { run, asked, redactions } = await started([token(GOOD)]);
    const result = await run(['items', 'env']);
    expect(result.isError).toBe(false);
    const seen = JSON.parse(result.text);
    expect(seen.token).toBe(sha(GOOD));
    // Less what the test's /bin/sh wrapper sets for itself.
    expect(seen.keys.filter((key: string) => !SHELL_SETS.includes(key))).toEqual(
      ['EXCLI_CONFIG_DIR', 'EXCLI_TOKEN', 'HOME', 'HTTPS_PROXY', 'TMPDIR'].sort()
    );
    expect(seen.cwd).not.toBe(session);
    expect(seen.cwd.startsWith(state) || seen.cwd.includes('/runs/run-')).toBe(true);
    expect(seen.dotenv).toBe(0);
    expect(seen.config).toBe(join(state, 'example-cli', 'config'));
    expect(asked).toEqual([{ type: 'service-token', service: 'example', rejected: null }]);
    expect(redactions.list()).toContain(GOOD);
    // The run's own folder is gone once it is answered.
    expect(await readdir(join(state, 'example-cli', 'runs'))).toEqual([]);
  });

  it('gives shell metacharacters to the tool as plain arguments', async () => {
    const { run } = await started([token(GOOD)]);
    const args = ['items', 'argv', '$(touch pwned)', '; rm -rf .', '`id`', 'a\'b"c', '*'];
    const result = await run(args);
    expect(JSON.parse(result.text)).toEqual(args);
    expect(await readdir(session)).toEqual([]);
  });

  it('never passes the token on, even when the tool prints it', async () => {
    const { run } = await started([token(GOOD)]);
    const result = await run(['items', 'leak']);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('exited with code 3');
    expect(result.text).not.toContain(GOOD);
    expect(result.text).toContain('stdout [REDACTED]');
    expect(result.text).toContain('stderr [REDACTED]');
  });

  it('asks again once when the vendor refuses the token, naming the refused one', async () => {
    const { run, asked } = await started([token(STALE), token(GOOD)]);
    const result = await run(['items', 'hello']);
    expect(result).toEqual({ isError: false, text: 'ok hello\n' });
    expect(asked.map((ask) => (ask.type === 'service-token' ? ask.rejected : null))).toEqual([
      null,
      STALE,
    ]);
  });

  it('stops after a second refusal, saying so', async () => {
    const { run, asked } = await started([token(STALE), token(STALE)]);
    const result = await run(['items', 'hello']);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('refused this agent’s token again'.replace('’', "'"));
    expect(asked).toHaveLength(2);
  });

  it('passes on a refusal from Switch', async () => {
    const { run } = await started([
      { kind: 'refused', code: 'grant_missing', message: 'This agent has no grant.', final: true },
    ]);
    const result = await run(['items', 'hello']);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('This agent has no grant.');
  });

  it('answers a vendor error as an error, without asking again', async () => {
    const { run, asked } = await started([token(GOOD)]);
    const result = await run(['items', 'fail']);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('"code":403');
    expect(asked).toHaveLength(1);
  });

  it('refuses a command before asking for a token', async () => {
    const { run, asked } = await started([]);
    const result = await run(['auth', 'login']);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not available');
    expect(asked).toEqual([]);
  });

  it('stops a run that outlives its timeout', async () => {
    const { run } = await started([token(GOOD)], { ...TOOL, timeout_s: 1 });
    const started_ = Date.now();
    const result = await run(['items', 'sleep', '10000']);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('did not finish within 1 s');
    expect(Date.now() - started_).toBeLessThan(8_000);
  });

  it('saves output past the cap to a file git ignores, and returns its path', async () => {
    const { run } = await started([token(GOOD)]);
    const result = await run(['items', 'big', '5000']);
    expect(result.isError).toBe(false);
    const path = /saved at (\S+)\./.exec(result.text)?.[1];
    expect(path).toMatch(/^\.switch\/example-cli\/output-/);
    expect(await readFile(join(session, path!), 'utf8')).toBe('x'.repeat(5000));
    expect(await readFile(join(session, '.switch', 'example-cli', '.gitignore'), 'utf8')).toBe(
      '*\n'
    );
    expect(Buffer.byteLength(result.text)).toBeLessThan(5000);
  });

  it.each([
    [['--output', 'out/report.txt']],
    [['--output=out/report.txt']],
    [['-o', 'out/report.txt']],
    [['-oout/report.txt']],
  ])('writes a file the command names into the session’s folder: %j', async (flag) => {
    await mkdir(join(session, 'out'));
    const { run } = await started([token(GOOD)]);
    const result = await run(['items', 'write', ...flag]);
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/Wrote (out\/report.txt)\./);
    expect(await readFile(join(session, 'out', 'report.txt'), 'utf8')).toBe(
      'report from the vendor'
    );
  });

  it('reads a file the command names from the session’s folder', async () => {
    await writeFile(join(session, 'notes.md'), 'hello drive');
    const { run } = await started([token(GOOD)]);
    const result = await run(['items', 'read', '--upload', 'notes.md']);
    expect(result).toEqual({ isError: false, text: 'notes.md hello drive\n' });
  });

  it.each([
    [['--upload', '../outside.txt'], 'outside this session'],
    [['--upload', '/etc/hosts'], 'outside this session'],
    [['--upload', 'missing.txt'], 'There is no file'],
    [['--output', '../outside.txt'], 'outside this session'],
    [['--output', 'no-such-folder/x.txt'], 'does not exist'],
    [['--output', 'out/'], 'names a folder'],
    [['--upload', 'escape'], 'outside this session'],
  ])('refuses a path outside the session’s folder: %j', async (flag, message) => {
    await mkdir(join(session, 'out'));
    await writeFile(join(root, 'outside.txt'), 'secret');
    await symlink(join(root, 'outside.txt'), join(session, 'escape'));
    const { run, asked } = await started([token(GOOD)]);
    const result = await run(['items', 'read', ...flag]);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
    expect(result.text).not.toContain('secret');
    expect(asked).toEqual([]);
  });

  it('reads a positional file from the session’s folder, and nothing outside it', async () => {
    await writeFile(join(session, 'deck.md'), 'slides');
    const { run } = await started([token(GOOD)]);
    expect(await run(['items', '+put', 'deck.md'])).toEqual({
      isError: false,
      text: 'deck.md slides\n',
    });
    const outside = await run(['items', '--format', 'json', '+put', '/etc/hosts']);
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('outside this session');
  });

  it('keeps what a run leaves behind unasked, and says where', async () => {
    const { run } = await started([token(GOOD)]);
    const result = await run(['items', 'download']);
    const saved = /Saved (\S+)\./.exec(result.text)?.[1];
    expect(saved).toMatch(/^\.switch\/example-cli\/\d+-download\.pdf$/);
    expect(await readFile(join(session, saved!), 'utf8')).toBe('%PDF');
  });

  it('leaves no token in any file, the session’s or its own', async () => {
    const { run } = await started([token(GOOD), token(GOOD), token(GOOD)]);
    await run(['items', 'env']);
    await run(['items', 'big', '5000']);
    await run(['items', 'leak']);
    for (const folder of [session, state])
      for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const content = await readFile(join(entry.parentPath, entry.name), 'utf8');
        expect(content).not.toContain(GOOD);
      }
  });
});
