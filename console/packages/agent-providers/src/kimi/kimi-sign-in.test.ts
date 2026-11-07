import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { writeNodeCli } from '../testing/node-cli';
import { JsonRpcError } from '../transport/stdio-json-rpc';
import { kimiAcp, parseKimiResumeProbe } from './kimi-acp';

describe('parseKimiResumeProbe', () => {
  it('reads auth_required as signed out, with the command that signs it in', () => {
    expect(parseKimiResumeProbe(new JsonRpcError(-32000, 'Authentication required'))).toEqual({
      status: 'unauthenticated',
      message: 'Sign in on the execution machine with kimi login.',
      models: [],
    });
  });
  it('reads an unknown session as signed in', () => {
    expect(
      parseKimiResumeProbe(
        new JsonRpcError(-32602, 'Invalid params: Unknown sessionId: switch-sign-in-check')
      )
    ).toEqual({ status: 'authenticated', message: 'Signed in to Kimi Code.', models: [] });
  });
  it.each([
    new JsonRpcError(-32602, 'Invalid params: cwd must be absolute'),
    new JsonRpcError(-32601, 'Method not found'),
    new Error('Provider process exited'),
  ])('reports anything else as unknown: %s', (error) => {
    expect(parseKimiResumeProbe(error).status).toBe('unknown');
  });
});

describe('the Kimi sign-in check', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  /**
   * A `kimi` that speaks ACP the way 2.3.3 does: it always lists the `login`
   * method, and answers `session/resume` with `resume`. It records each
   * request's method and arguments.
   */
  async function fakeKimi(resume: { code: number; message: string }) {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-sign-in-'));
    dirs.push(dir);
    const calls = join(dir, 'calls');
    const binaryPath = await writeNodeCli(
      dir,
      'kimi',
      `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    fs.appendFileSync(${JSON.stringify(calls)}, message.method + '\\n');
    if (message.method === 'initialize')
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'login', type: 'terminal', name: 'Login with Kimi account' }] } });
    else if (message.method === 'session/resume')
      send({ id: message.id, error: ${JSON.stringify(resume)} });
    else send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
process.stdin.on('end', () => process.exit(0));`
    );
    return {
      binaryPath,
      dir,
      calls: async () => (await readFile(calls, 'utf8')).trim().split('\n'),
    };
  }

  it('asks Kimi to resume a session that does not exist, and never signs in', async () => {
    const kimi = await fakeKimi({
      code: -32602,
      message: 'Invalid params: Unknown sessionId: switch-sign-in-check',
    });
    expect(
      await checkAcpSignIn(kimiAcp, { binaryPath: kimi.binaryPath, cwd: kimi.dir, env: {} })
    ).toMatchObject({ status: 'authenticated' });
    expect(await kimi.calls()).toEqual(['["acp"]', 'initialize', 'session/resume']);
  });

  it('reports a signed-out Kimi, whose method list alone cannot tell', async () => {
    const kimi = await fakeKimi({ code: -32000, message: 'Authentication required' });
    expect(
      await checkAcpSignIn(kimiAcp, { binaryPath: kimi.binaryPath, cwd: kimi.dir, env: {} })
    ).toEqual({
      status: 'unauthenticated',
      message: 'Sign in on the execution machine with kimi login.',
      models: [],
    });
    expect(await kimi.calls()).not.toContain('authenticate');
  });
});
