import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AccountSettingsPage } from '@renderer/features/settings/pages/account-page';
import type { SignedInServer } from '@renderer/features/settings/pages/settings-server';

const capability = vi.hoisted(() => ({ enabled: undefined as boolean | undefined, dev: true }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('@renderer/lib/dev-tools', () => ({ showDevTools: () => capability.dev }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    authConfigFor: () => ({ testAccountResetEnabled: capability.enabled }),
  },
}));
vi.mock('@renderer/features/settings/pages/settings-server', () => ({
  OnSignedInServer: ({ children }: { children: (state: SignedInServer) => ReactNode }) =>
    children({
      server: {
        id: 's',
        name: 'Server',
        url: 'https://switch.example.com',
        dashboardUrl: null,
        managed: false,
        managementKind: null,
        sshHost: null,
        createdAt: '',
        updatedAt: '',
      },
      user: { id: 'u', name: 'Viewer', email: 'viewer@example.com', role: 'user', server: null },
    }),
}));

describe('test-account reset visibility', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [true, undefined, false],
    [false, true, false],
  ] as const)('dev build %s, server capability %s', (dev, enabled, visible) => {
    Object.assign(capability, { dev, enabled });
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(AccountSettingsPage)
      )
    );
    expect(html.includes('Reset test account')).toBe(visible);
    expect(html).toContain('Delete my account');
  });
});
