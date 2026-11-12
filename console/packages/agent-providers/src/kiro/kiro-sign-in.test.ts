import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { writeNodeCli } from '../testing/node-cli';
import {
  KIRO_SIGN_IN,
  kiroAcp,
  kiroHandshakeReadiness,
  kiroPermissionKind,
  parseKiroWhoami,
} from './kiro-acp';

/** What a signed-out `kiro-cli acp` 3.0.0 answers `initialize` with, on every engine. */
const SIGNED_OUT_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    mcpCapabilities: { http: false, sse: false },
    sessionCapabilities: {},
    auth: {},
  },
  authMethods: [
    {
      id: 'kiro-login',
      name: 'Kiro Login',
      description: "Run 'kiro-cli login' in a terminal, then reconnect to this agent.",
    },
  ],
  agentInfo: { name: 'Kiro CLI Agent', title: 'Kiro CLI Agent', version: '3.0.0' },
};

/** What the V3 engine answers once it has credentials, trimmed. */
const ENGINE_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    _meta: { kiro: { extensionMethods: ['_kiro/session/compact'] } },
  },
  authMethods: [
    { id: 'aws-builder-id', name: 'AWS Builder ID' },
    { id: 'aws-iam-identity-center', name: 'AWS IAM Identity Center' },
  ],
};

/**
 * A stand-in `kiro-cli`: `whoami` answers as `FAKE_KIRO` says, and `acp`
 * answers `initialize` signed out unless it was given a key. Every invocation
 * and every request it receives is logged, so a test can show the check never
 * started a sign-in.
 */
const FAKE_KIRO = `
const { appendFileSync } = require('node:fs');
const log = (line) => appendFileSync(process.env.FAKE_KIRO_LOG, line + '\\n');
const args = process.argv.slice(2);
log('argv ' + args.join(' '));
const state = process.env.FAKE_KIRO;
if (args[0] === 'whoami') {
  if (state === 'old') { process.stderr.write("error: unexpected argument '--format' found\\n"); process.exit(2); }
  if (process.env.KIRO_API_KEY) { process.stdout.write(JSON.stringify({ accountType: 'ApiKey', email: null })); process.exit(0); }
  if (state === 'signed-in') { process.stdout.write(JSON.stringify({ accountType: 'BuilderId', email: 'user@example.com' })); process.exit(0); }
  process.stdout.write(JSON.stringify({ account: null })); process.exit(1);
}
if (args[0] === 'acp') {
  const signedIn = state === 'signed-in' || Boolean(process.env.KIRO_API_KEY);
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      log('request ' + message.method);
      if (message.method === 'initialize') {
        const result = signedIn ? ${JSON.stringify(ENGINE_INITIALIZE)} : ${JSON.stringify(SIGNED_OUT_INITIALIZE)};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
      } else if (message.id !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unexpected' } }) + '\\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  log('unexpected command');
  process.exit(3);
}
`;

describe('the Kiro sign-in check', () => {
  let dir: string;
  let binaryPath: string;
  let logPath: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kiro-sign-in-'));
    binaryPath = await writeNodeCli(dir, 'kiro-cli', FAKE_KIRO);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  let run = 0;
  async function check(state: string, extraEnv: Record<string, string> = {}) {
    logPath = join(dir, `log-${++run}.txt`);
    const result = await checkAcpSignIn(kiroAcp, {
      binaryPath,
      cwd: dir,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        FAKE_KIRO: state,
        FAKE_KIRO_LOG: logPath,
        ...extraEnv,
      },
    });
    const log = (await readFile(logPath, 'utf8')).trim().split('\n');
    return { result, log };
  }

  it('says signed out, with how to sign in, without starting the agent or a login', async () => {
    const { result, log } = await check('signed-out');
    expect(result).toEqual({ status: 'unauthenticated', message: KIRO_SIGN_IN, models: [] });
    expect(result.message).toContain('kiro-cli login');
    expect(log).toEqual(['argv whoami --format json']);
  });

  it('says signed in from whoami alone, without account details', async () => {
    const { result, log } = await check('signed-in');
    expect(result).toEqual({
      status: 'authenticated',
      message: 'Signed in to Kiro CLI.',
      models: [],
    });
    expect(log).toEqual(['argv whoami --format json']);
  });

  it('takes a KIRO_API_KEY whoami reports as signing it in', async () => {
    const { result, log } = await check('signed-out', { KIRO_API_KEY: 'synthetic-key' });
    expect(result).toEqual({
      status: 'authenticated',
      message: 'Signs in with the Kiro API key it was given.',
      models: [],
    });
    expect(log).toEqual(['argv whoami --format json']);
  });

  it('asks the agent, never sending authenticate, when whoami cannot answer for a key', async () => {
    const { result, log } = await check('old', { KIRO_API_KEY: 'synthetic-key' });
    expect(result.message).toBe('Signs in with the Kiro API key it was given.');
    expect(log).toEqual(['argv whoami --format json', 'argv acp', 'request initialize']);
  });

  it('asks the agent when whoami cannot answer, reading the signed-out handshake', async () => {
    const { result, log } = await check('old');
    expect(result).toEqual({ status: 'unauthenticated', message: KIRO_SIGN_IN, models: [] });
    expect(log).toEqual(['argv whoami --format json', 'argv acp', 'request initialize']);
    expect(log.join('\n')).not.toMatch(/login|authenticate/);
  });
});

describe('reading Kiro', () => {
  it('reads whoami JSON, signed out and signed in', () => {
    expect(parseKiroWhoami('{"account":null}\n')?.status).toBe('unauthenticated');
    expect(parseKiroWhoami('{"accountType":"BuilderId","email":"user@example.com"}')).toEqual({
      status: 'authenticated',
      message: 'Signed in to Kiro CLI.',
      models: [],
    });
    expect(parseKiroWhoami('{"accountType":"ApiKey","email":null}')?.message).toBe(
      'Signs in with the Kiro API key it was given.'
    );
    expect(parseKiroWhoami('{"account":{"id":"x"}}')?.status).toBe('authenticated');
  });

  it('reads whoami text output', () => {
    expect(parseKiroWhoami('Not logged in')?.status).toBe('unauthenticated');
    expect(parseKiroWhoami('Logged in with Builder ID')?.status).toBe('authenticated');
  });

  it('leaves output it cannot read to the handshake', () => {
    expect(parseKiroWhoami('')).toBeUndefined();
    expect(parseKiroWhoami('{"user":"someone"}')).toBeUndefined();
    expect(parseKiroWhoami('Usage: kiro-cli [OPTIONS]')).toBeUndefined();
  });

  it('takes the kiro-login method as signed out and anything else as signed in', () => {
    expect(kiroHandshakeReadiness(SIGNED_OUT_INITIALIZE, {}).status).toBe('unauthenticated');
    expect(kiroHandshakeReadiness(ENGINE_INITIALIZE, {}).status).toBe('authenticated');
    expect(kiroHandshakeReadiness({ authMethods: [] }, { KIRO_API_KEY: 'k' }).message).toBe(
      'Signs in with the Kiro API key it was given.'
    );
  });

  it('names the hint for headless machines', () => {
    expect(KIRO_SIGN_IN).toContain('--use-device-flow');
    expect(KIRO_SIGN_IN).toContain('KIRO_API_KEY');
  });

  it('reads the kind of tool a permission request is for', () => {
    expect(kiroPermissionKind({ toolId: 'anything', command: 'ls' })).toBe('execute');
    expect(kiroPermissionKind({ toolId: 'run_command' })).toBe('execute');
    expect(kiroPermissionKind({ toolId: 'fs_write' })).toBe('edit');
    expect(kiroPermissionKind({ toolId: 'str_replace' })).toBe('edit');
    expect(kiroPermissionKind({ toolId: 'web_fetch' })).toBeUndefined();
    expect(kiroPermissionKind({})).toBeUndefined();
  });
});
