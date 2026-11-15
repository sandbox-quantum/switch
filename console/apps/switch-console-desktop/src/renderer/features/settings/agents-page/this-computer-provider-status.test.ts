import type * as ReactQuery from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { MachineProvider } from '@shared/core/managed-agents/managed-agents';

const report = vi.hoisted(() => ({ provider: null as MachineProvider | null }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('@renderer/lib/stores/use-this-computer-report', () => ({
  useThisComputerReport: () => ({
    isPending: false,
    data: { serverId: 'server', providers: report.provider ? [report.provider] : [] },
  }),
  recheckThisComputer: async () => {},
}));
vi.mock('@tanstack/react-query', async (actual) => ({
  ...(await actual<typeof ReactQuery>()),
  useQueryClient: () => ({}),
  useMutation: () => ({ isPending: false, mutate: () => {} }),
}));
vi.mock('@shared/core/providers/agent-provider-registry', () => ({
  getProvider: () => ({ name: 'Codex', loginCommand: 'codex login' }),
}));

const { ThisComputerProviderStatus } = await import('./this-computer-provider-status');

const render = () =>
  renderToStaticMarkup(React.createElement(ThisComputerProviderStatus, { providerId: 'codex' }));

const notSignedIn = (patch: Partial<MachineProvider>): MachineProvider => ({
  provider: 'codex',
  ready: false,
  problem: 'not logged in',
  detail: null,
  loginHelps: true,
  ...patch,
});

beforeEach(() => {
  report.provider = null;
});

it('suggests the login command for a provider that is not signed in', () => {
  report.provider = notSignedIn({});
  expect(render()).toContain('codex login');
});

it('does not suggest it when the controller says signing in would not help', () => {
  report.provider = notSignedIn({
    detail: 'An administrator pins where Codex keeps logins.',
    loginHelps: false,
  });
  const html = render();
  expect(html).toContain('An administrator pins where Codex keeps logins.');
  expect(html).toContain('Can’t be used yet');
  expect(html).not.toContain('codex login');
});
