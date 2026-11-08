import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { writeNodeCli } from '../testing/index';
import { kiroAcp } from './kiro-acp';

// A stand-in for `kiro-cli acp`: answers `initialize` with Kiro's one auth
// method either way, refuses everything else with `auth_required` while
// signed out, and logs every call it is sent.
const FAKE_KIRO = `
const { appendFileSync } = require('node:fs');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    appendFileSync(process.env.FAKE_KIRO_LOG, message.method + '\\n');
    const reply = (body) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body }) + '\\n');
    if (message.method === 'initialize')
      reply({ result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'kiro-login' }] } });
    else if (process.env.FAKE_KIRO_SIGNED_OUT)
      reply({ error: { code: -32000, message: 'Authentication required.' } });
    else if (message.method === 'session/list') reply({ result: { sessions: [] } });
    else reply({ error: { code: -32601, message: 'Method not found' } });
  }
});
`;

let root: string;
let kiro: string;
let log: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'switch-kiro-test-'));
  kiro = await writeNodeCli(root, 'kiro-cli', FAKE_KIRO);
  log = join(root, 'calls.log');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function check(extra: Record<string, string>) {
  const result = await checkAcpSignIn(kiroAcp, {
    binaryPath: kiro,
    cwd: root,
    env: { PATH: process.env.PATH ?? '', FAKE_KIRO_LOG: log, ...extra },
  });
  const calls = existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n') : [];
  return { result, calls };
}

describe('Kiro CLI ACP hooks', () => {
  it('runs kiro-cli acp, and never authenticates', async () => {
    const launch = await kiroAcp.launch({ binaryPath: 'kiro-cli', cwd: '.', env: {} });
    expect(launch.args).toEqual(['acp']);
    expect(kiroAcp.loginCommand).toBe('kiro-cli login');
    expect(kiroAcp.authMethodId).toBeUndefined();
    expect(kiroAcp.inheritEnv).toContain('KIRO_API_KEY');
  });

  it('sets no session mode, as Kiro modes are agent configurations', () => {
    expect(kiroAcp.sessionMode).toBeUndefined();
  });

  it('is signed in when Kiro answers a read-only session/list', async () => {
    const { result, calls } = await check({});
    expect(result.status).toBe('authenticated');
    expect(calls).toEqual(['initialize', 'session/list']);
  });

  it('is signed out, with the login command, when Kiro refuses it', async () => {
    const { result, calls } = await check({ FAKE_KIRO_SIGNED_OUT: '1' });
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('kiro-cli login');
    expect(calls).toEqual(['initialize', 'session/list']);
  });
});
