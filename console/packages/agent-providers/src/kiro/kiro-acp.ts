import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acpInitialize, createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';
import { JsonRpcError, noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

const KIRO_LOGIN = 'kiro-cli login';
// ACP's `auth_required`, which an agent answers `session/new` with when signed out.
const AUTH_REQUIRED = -32000;

/** Kiro CLI's `kiro-cli acp`. Its extra methods are read from what it advertises. */
export const kiroAcp: AcpProviderHooks = {
  provider: 'kiro',
  label: 'Kiro CLI',
  defaultBinary: 'kiro-cli',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['acp'], env }),
  loginCommand: KIRO_LOGIN,
  // The handshake does not say whether Kiro is signed in; a session opened in
  // an empty directory of its own does, and is closed again. Nothing signs in
  // and no model is called.
  checkSignIn: async (input) => {
    const cwd = await mkdtemp(join(tmpdir(), 'switch-kiro-'));
    const client = new StdioJsonRpcClient({
      ...(await kiroAcp.launch(input)),
      cwd,
      logger: noopLogger,
      onExit: () => {},
    });
    try {
      await acpInitialize(client, {});
      try {
        await client.request('session/new', { cwd, mcpServers: [] });
      } catch (error) {
        if (error instanceof JsonRpcError && error.code === AUTH_REQUIRED)
          return readiness('unauthenticated', signInWith(KIRO_LOGIN));
        throw error;
      }
      return readiness('authenticated', 'Signed in to Kiro.');
    } finally {
      await client.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  // Kiro's modes are taken from what its session advertises: full access asks
  // for one that trusts every tool where Kiro offers it.
  sessionMode: (mode, modes) => {
    if (mode !== 'full-access') return undefined;
    const ids = modes?.availableModes?.map((m) => m.id) ?? [];
    return ids.find((id) => /trust|yolo|always/i.test(id));
  },
  mcpServerOf: (toolCall) => /^mcp__(.+?)__/.exec(toolCall.title ?? '')?.[1],
};

export function createKiroAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kiroAcp, options);
}
