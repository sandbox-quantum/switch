import type * as ReactQuery from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { MachineProvider } from '@shared/core/managed-agents/managed-agents';
import type { AgentPayload } from '@shared/core/providers/agent-payload';

const report = vi.hoisted(() => ({ provider: null as MachineProvider | null }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));
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
  useIsMutating: () => 0,
}));
vi.mock('@shared/core/providers/agent-provider-registry', () => ({
  getProvider: () => ({ name: 'Codex', loginCommand: 'codex login' }),
  asAgentProviderId: (id: string) => id,
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

it('says a sign-in could not be checked, with the reason and Recheck, rather than spinning', () => {
  report.provider = notSignedIn({
    problem: 'login could not be checked',
    detail: 'The sign-in check failed: the probe exited 1',
  });
  const html = render();
  expect(html).toContain('Sign-in couldn’t be checked');
  expect(html).toContain('The sign-in check failed: the probe exited 1');
  expect(html).toContain('Recheck');
  expect(html).not.toContain('animate-spin');
});

it('gives the compact line the reason a sign-in could not be checked, without a spinner', () => {
  report.provider = notSignedIn({
    problem: 'login could not be checked',
    detail: 'The sign-in check failed: the probe exited 1',
  });
  const html = renderToStaticMarkup(
    React.createElement(ThisComputerProviderStatus, { providerId: 'codex', compact: true })
  );
  expect(html).toContain(
    'Sign-in couldn’t be checked: The sign-in check failed: the probe exited 1'
  );
  expect(html).not.toContain('animate-spin');
});

it('puts Recheck on the providers list row whose sign-in could not be checked', async () => {
  const { AgentRow } = await import('./AgentRow');
  const row = (problem: string) => {
    report.provider = notSignedIn({ problem });
    return renderToStaticMarkup(
      React.createElement(AgentRow, {
        agent: { id: 'codex', name: 'Codex', status: 'available' } as AgentPayload,
        onClick: () => {},
      })
    );
  };
  expect(row('login could not be checked')).toContain('aria-label="Recheck Codex sign-in"');
  expect(row('not logged in')).not.toContain('Recheck');
});
