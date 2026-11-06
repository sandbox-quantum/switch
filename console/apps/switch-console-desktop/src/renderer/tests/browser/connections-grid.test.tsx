/** A catalog-only service must stay visibly unavailable, without a sign-in route. */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers: {} },
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

import { ConnectionsGrid } from '@renderer/features/switch-servers/connections-step';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

it('shows Zendesk as Coming soon and cannot open its connection flow', async () => {
  const connection: ConnectionCatalogEntry = {
    slug: 'zendesk',
    name: 'Zendesk',
    category: 'Support',
    description: 'Customer support tickets',
    enabled: false,
    auth_type: 'api_key',
    connectable: false,
    status: 'coming_soon',
    unavailable_reason: 'Coming soon',
    unavailable_code: 'coming_soon',
    pass_through: true,
    token_lifetime: null,
    loopback_ports: null,
    key: null,
    external_identity: null,
    consent: null,
    workspace_enabled: null,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onOpen = vi.fn();
  try {
    await act(async () =>
      root.render(
        <Dialog open>
          <DialogContent>
            <ConnectionsGrid
              catalog={{ connections: [connection], error: null, reload: async () => {} }}
              query=""
              onQueryChange={() => {}}
              onOpen={onOpen}
            />
          </DialogContent>
        </Dialog>
      )
    );
    const card = document.querySelector<HTMLButtonElement>(
      'button[title="Customer support tickets"]'
    );
    expect(card).not.toBeNull();
    expect(card!.disabled).toBe(true);
    expect(card!.textContent).toContain('Zendesk');
    expect(card!.textContent).toContain('Coming soon');
    card!.click();
    expect(onOpen).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
