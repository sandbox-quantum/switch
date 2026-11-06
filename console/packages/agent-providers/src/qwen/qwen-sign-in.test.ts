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
      message: 'Sign in on the execution machine with qwen.',
      models: [],
    });
  });

  it("passes on Qwen's reason when the configured sign-in failed", () => {
    expect(parseQwenSessionNew(new JsonRpcError(EXPIRED.code, EXPIRED.message))).toEqual({
      status: 'unauthenticated',
      message:
        'Sign in on the execution machine with qwen. Qwen Code said: Qwen OAuth credentials expired. Please use /auth to re-authenticate with qwen-oauth.',
      models: [],
    });
  });

  it.each([
    ['another protocol error', new JsonRpcError(-32603, 'Internal error')],
    ['a timeout', new Error('Provider request session/new timed out')],
    ['a session without an id', {} as never],
  ])('reports %s as unknown', (_case, answer) => {
    expect(parseQwenSessionNew(answer)).toEqual({
      status: 'unknown',
      message: 'Could not verify authentication. Check provider setup and try again.',
      models: [],
    });
  });
});

describe('checkAcpSignIn running checkQwenSignIn', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('reports signed in when the CLI answers session/new with a session', async () => {
    root = await mkdtemp(join(tmpdir(), 'qwen-sign-in-'));
    const cli = await writeNodeCli(
      root,
      `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            protocolVersion: 1,
            agentInfo: { name: 'qwen-code', version: '0.26.1' },
            authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }],
            agentCapabilities: { sessionCapabilities: { list: {}, resume: {} } }
          } }) + '\\n');
        } else if (msg.method === 'session/new') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            sessionId: 'ses-1',
            models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'qwen3-coder-plus' }] }
          } }) + '\\n');
        }
      });
      `
    );
    const result = await checkAcpSignIn(qwenAcp, {
      binaryPath: cli,
      cwd: root,
      env: {},
    });
    expect(result).toEqual({
      status: 'authenticated',
      message: 'Signed in to Qwen Code (qwen3-coder-plus).',
      models: [],
    });
  });

  it('reports signed out when the CLI answers session/new with Authentication required', async () => {
    root = await mkdtemp(join(tmpdir(), 'qwen-sign-in-'));
    const cli = await writeNodeCli(
      root,
      `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            protocolVersion: 1,
            agentInfo: { name: 'qwen-code', version: '0.26.1' },
            authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }],
            agentCapabilities: { sessionCapabilities: { list: {}, resume: {} } }
          } }) + '\\n');
        } else if (msg.method === 'session/new') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: {
            code: -32000,
            message: 'Authentication required: Use Qwen Code CLI to authenticate first.'
          } }) + '\\n');
        }
      });
      `
    );
    const result = await checkAcpSignIn(qwenAcp, {
      binaryPath: cli,
      cwd: root,
      env: {},
    });
    expect(result).toEqual({
      status: 'unauthenticated',
      message: 'Sign in on the execution machine with qwen.',
      models: [],
    });
  });
});
