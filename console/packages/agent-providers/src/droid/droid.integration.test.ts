import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { acpInitialize, checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';
import { createDroidAdapter, droidAcp } from './droid-acp';

// The readiness hook bounds doctor at 20 s, including its network diagnostics.
vi.setConfig({ hookTimeout: 25_000 });

const probe = spawnSync('droid', ['--version'], { encoding: 'utf8', timeout: 10_000 });
const installed = !probe.error && probe.status === 0;
const version = installed ? probe.stdout.trim() : 'unavailable';
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
);
const input = { binaryPath: 'droid', cwd: process.cwd(), env };

// These checks run without credentials and never call authenticate or session/new.
describe(`Droid ${version} real CLI protocol`, () => {
  it('answers the ACP initialize handshake', async (ctx) => {
    if (!installed) return ctx.skip('the droid binary is not on PATH');
    const client = new StdioJsonRpcClient({
      ...(await droidAcp.launch(input)),
      cwd: input.cwd,
      logger: noopLogger,
      onExit: () => {},
    });
    try {
      const initialized = await acpInitialize(client, droidAcp);
      expect(initialized.protocolVersion).toBe(1);
      expect(initialized.agentInfo?.name).toBe('@factory/cli');
      expect(initialized.agentCapabilities?.mcpCapabilities?.http).toBe(true);
      expect(initialized.agentCapabilities?.loadSession).toBe(true);
    } finally {
      await client.dispose();
    }
  }, 75_000);

  it('reports readiness through the non-interactive auth check', async (ctx) => {
    if (!installed) return ctx.skip('the droid binary is not on PATH');
    const result = await checkAcpSignIn(droidAcp, input);
    expect(['authenticated', 'unauthenticated', 'unknown']).toContain(result.status);
    expect(result.message).not.toMatch(/user code|authenticated as|@/i);
  }, 25_000);
});

describeConformance('droid', {
  createAdapter: async () => createDroidAdapter(),
  unavailableReason: async () => {
    if (!installed) return 'the droid binary is not on PATH';
    const result = await checkAcpSignIn(droidAcp, input);
    return result.status === 'authenticated'
      ? null
      : `Droid ${version}: ${result.message} Authenticated conformance was not run.`;
  },
  // Choose a real advertised model to check the create-agent model path.
  ...(process.env.DROID_TEST_MODEL ? { model: { id: process.env.DROID_TEST_MODEL } } : {}),
  mcpServers: { echo: echoMcpServerSpec() },
  env: Object.fromEntries(
    [
      ...droidAcp.inheritEnv!,
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'NODE_EXTRA_CA_CERTS',
    ].flatMap((key) => (env[key] !== undefined ? [[key, env[key]]] : []))
  ),
});
