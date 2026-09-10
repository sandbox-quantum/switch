import { beforeEach, expect, it, vi } from 'vitest';
import { buildAgentRuntime } from './location-runtime-factory';

const construct = vi.hoisted(() => vi.fn());
vi.mock('@main/db/client', () => ({ db: {}, sqlite: {} }));
vi.mock('@main/core/sdk-host/shared-agent-runtime', () => ({
  SharedAgentRuntime: vi.fn(function (transport: unknown, options: unknown) {
    construct(transport, options);
  }),
}));
beforeEach(() => construct.mockClear());

it.each([
  { kind: 'local' as const },
  { kind: 'ssh' as const, host: 'example.test', dir: '/workspace', connectionId: 'ssh-example' },
])('uses the persistent shared host for $kind sessions', async (transport) => {
  const options = {
    locationId: 'location',
    sessionId: 'session',
    sessionPath: '/workspace',
    tmuxEnabled: true,
    sessionEnvVars: {},
    credsRelPaths: [],
    runtime: 'pty' as const,
  };
  await buildAgentRuntime(transport, options);
  expect(construct).toHaveBeenCalledWith(transport, options);
});
