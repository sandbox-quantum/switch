import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const readiness = vi.hoisted(() => ({ data: undefined as unknown, enabled: [] as boolean[] }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('./provider-connection-status', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProviderReadiness: (_p: string, _h: string | null, _d: string, enabled: boolean) => {
    readiness.enabled.push(enabled);
    return { data: readiness.data };
  },
}));

const { ProviderIssueIndicator } = await import('./provider-issue-indicator');
const { providerProblem } = await import('./provider-connection-status');

const render = (hostReachable = true) =>
  renderToStaticMarkup(
    React.createElement(ProviderIssueIndicator, {
      providerId: 'claude',
      sshHost: 'box',
      hostReachable,
      onOpen: () => {},
    })
  );

beforeEach(() => {
  readiness.data = undefined;
  readiness.enabled.length = 0;
});

it('warns when the provider is not signed in or not installed', () => {
  readiness.data = { installed: true, status: 'unauthenticated', message: null };
  expect(render()).toContain('Not signed in on box');
  readiness.data = { installed: false, status: 'unknown', message: null };
  expect(render()).toContain('CLI not installed on box');
});

it('shows nothing when the provider is ready or the check could not tell', () => {
  readiness.data = { installed: true, status: 'authenticated', message: null };
  expect(render()).toBe('');
  readiness.data = { installed: true, status: 'unknown', message: 'Could not tell' };
  expect(render()).toBe('');
  readiness.data = undefined;
  expect(render()).toBe('');
});

it('does not probe a host already known to be unreachable', () => {
  render(false);
  expect(readiness.enabled).toEqual([false]);
});

it('names the problem only for states that stop a session', () => {
  expect(providerProblem({ installed: true, status: 'unconfigured' })).toBe(
    'No backend configured'
  );
  expect(providerProblem({ installed: null, status: 'unknown' })).toBeNull();
});
