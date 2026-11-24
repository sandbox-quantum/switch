import { ok } from '@switch-console/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ProviderUsageBar } from '@renderer/features/provider-usage/ProviderUsageBar';
import type { ProviderUsageState } from '@shared/core/provider-usage/provider-usage';
import type { AgentProviderDefinition } from '@shared/core/providers/agent-provider-registry';
import '@renderer/index.css';

const fixture = vi.hoisted(() => {
  const providers: AgentProviderDefinition[] = ['first', 'second', 'third'].map((id) => ({
    id,
    name: id,
    shortName: id,
    description: '',
    docUrl: 'https://example.test',
    cliLabel: id,
    loginCommand: `${id} login`,
    knownAgentType: id,
    supportsAutoMode: false,
    supportsSubscriptionUsage: true,
  }));
  const state: ProviderUsageState = {
    revision: 1,
    installedProviderIds: providers.map(({ id }) => id),
    refreshingProviderIds: [],
    snapshots: providers.map(({ id }) => ({
      providerId: id,
      status: 'ok',
      updatedAt: null,
      windows: [
        { id: 'week', label: '7d', usedPercent: 40, windowMinutes: 10_080, resetsAt: null },
      ],
    })),
  };
  return { providers, state };
});

vi.mock('@shared/core/providers/agent-provider-registry', () => ({
  agentProviders: () => fixture.providers,
}));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({
    value: { showProviderUsageBar: true, usagePercentageDisplay: 'used' },
    update: vi.fn(),
    isSaving: false,
  }),
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: vi.fn() }),
}));
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    providerUsage: {
      setActive: async () => ok<void>(),
      getSnapshots: async () => ok(fixture.state),
    },
  },
}));

it('opens the overflow roster by keyboard and returns focus on Escape', async () => {
  const container = document.createElement('div');
  container.style.width = '210px';
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ProviderUsageBar />));

    const overflow = page.getByRole('button', { name: 'Show all local usage, 3 more' });
    await expect.element(overflow).toBeVisible();
    await userEvent.tab();
    await expect.element(overflow).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.element(page.getByRole('heading', { name: 'Local machine usage' })).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'third' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect
      .element(page.getByRole('heading', { name: 'Local machine usage' }))
      .not.toBeInTheDocument();
    await expect.element(overflow).toHaveFocus();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
