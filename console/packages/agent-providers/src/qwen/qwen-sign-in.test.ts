import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { writeNodeCli } from '../testing/node-cli';
import { JsonRpcError } from '../transport/stdio-json-rpc';
import { parseQwenSessionNew, qwenAcp } from './qwen-acp';

/** What qwen-code 0.26.1 answers `session/new` with when no provider is set up. */
const SIGNED_OUT = {
  code: -32000,
  message: 'Authentication required: Use Qwen Code CLI to authenticate first.',
  data: { authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }] },
};
const EXPIRED = {
  ...SIGNED_OUT,
  message:
    'Authentication required: Authentication failed: Qwen OAuth credentials expired. Please use /auth to re-authenticate with qwen-oauth.',
};
const SESSION = {
  sessionId: 'b8f5f3d4-1c1e-4d0e-9a51-1f8a4f9f2c10',
  models: {
    currentModelId: '$runtime|openai|qwen3-coder-plus(openai)',
    availableModels: [
      { modelId: '$runtime|openai|qwen3-coder-plus(openai)', name: 'qwen3-coder-plus' },
    ],
  },
};

describe('parseQwenSessionNew', () => {
  it('reads a session as signed in, naming its model', () => {
    expect(parseQwenSessionNew(SESSION)).toEqual({
      status: 'authenticated',
      message: 'Signed in to Qwen Code (qwen3-coder-plus).',
      models: [],
    });
  });
  it('reads "Authentication required" as signed out, with the command that signs it in', () => {
    expect(
      parseQwenSessionNew(new JsonRpcError(SIGNED_OUT.code, SIGNED_OUT.message, SIGNED_OUT.data))
    ).toEqual({
      status: 'unauthenticated',
      message: 'Sign in on the device the agent runs on with qwen.',
      models: [],
    });
  });
  it("passes on Qwen's reason when the configured sign-in failed", () => {
    expect(parseQwenSessionNew(new JsonRpcError(EXPIRED.code, EXPIRED.message))).toEqual({
      status: 'unauthenticated',
      message:
        'Sign in on the device the agent runs on with qwen. Qwen Code said: Qwen OAuth credentials expired. Please use /auth to re-authenticate with qwen-oauth.',
      models: [],
    });
  });
  it.each([
    ['another protocol error', new JsonRpcError(-32603, 'Internal error')],
    ['a timeout', new Error('Provider request session/new timed out')],
    ['a session without an id', {}],
  ])('reports %s as unknown', (_case, answer) => {
    expect(parseQwenSessionNew(answer).status).toBe('unknown');
  });
});

describe('the Qwen sign-in check', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  /** A qwen that records its arguments and every request, and answers like the real one. */
  async function fakeQwen(sessionNew: { result: unknown } | { error: unknown }) {
    const dir = await mkdtemp(join(tmpdir(), 'qwen-sign-in-'));
    dirs.push(dir);
    const calls = join(dir, 'calls');
    const binaryPath = await writeNodeCli(
      dir,
      'qwen',
      `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const answers = {
  initialize: { result: { protocolVersion: 1, authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }], agentCapabilities: { loadSession: true } } },
  'session/new': ${JSON.stringify(sessionNew)},
};
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(calls)}, message.method + '\\n');
  const answer = answers[message.method] ?? { error: { code: -32601, message: 'Method not found' } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...answer }) + '\\n');
});`
    );
    return {
      binaryPath,
      dir,
      calls: async () => (await readFile(calls, 'utf8')).trim().split('\n'),
    };
  }

  it('starts a session and nothing else, so the check never signs in', async () => {
    const qwen = await fakeQwen({ result: SESSION });
    expect(
      await checkAcpSignIn(qwenAcp, { binaryPath: qwen.binaryPath, cwd: qwen.dir, env: {} })
    ).toMatchObject({ status: 'authenticated' });
    expect(await qwen.calls()).toEqual(['["--acp"]', 'initialize', 'session/new']);
  });

  it('reads the error a signed-out qwen answers session/new with', async () => {
    const qwen = await fakeQwen({ error: SIGNED_OUT });
    expect(
      await checkAcpSignIn(qwenAcp, { binaryPath: qwen.binaryPath, cwd: qwen.dir, env: {} })
    ).toMatchObject({ status: 'unauthenticated' });
    expect(await qwen.calls()).not.toContain('authenticate');
  });
});
