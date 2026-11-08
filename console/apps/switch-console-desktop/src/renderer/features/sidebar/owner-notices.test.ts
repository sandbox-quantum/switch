import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {},
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({ workspacesStore: {} }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));

const { OwnerNoticesContent } = await import('./owner-notices');
const base = {
  notices: [],
  loading: false,
  loadError: false,
  unsupported: false,
  dismissError: false,
  dismissingId: null,
  onRetry: () => {},
  onDismiss: () => {},
};

it('renders nothing for an owner with no notices', () => {
  expect(renderToStaticMarkup(createElement(OwnerNoticesContent, base))).toBe('');
});

it('announces loading and errors, with a retry action', () => {
  const loading = renderToStaticMarkup(
    createElement(OwnerNoticesContent, { ...base, loading: true })
  );
  expect(loading).toContain('role="status"');
  const failed = renderToStaticMarkup(
    createElement(OwnerNoticesContent, { ...base, loadError: true, dismissError: true })
  );
  expect(failed).toContain('Couldn’t check agent invitation notices');
  expect(failed).toContain('Couldn’t dismiss the notice');
  expect(failed).toContain('Retry');
  const unsupported = renderToStaticMarkup(
    createElement(OwnerNoticesContent, { ...base, unsupported: true })
  );
  expect(unsupported).toContain('Update it to see them');
  expect(unsupported).not.toContain('Retry');
});

it('renders names as text and identifies the notice being dismissed', () => {
  const markup = renderToStaticMarkup(
    createElement(OwnerNoticesContent, {
      ...base,
      notices: [
        {
          id: 'n1',
          kind: 'unverified_agent_invite',
          agentName: '<Agent>',
          roomName: 'Room & team',
          createdAt: '2026-11-08T00:00:00Z',
        },
      ],
      dismissingId: 'n1',
    })
  );
  expect(markup).toContain('&lt;Agent&gt;');
  expect(markup).toContain('Room &amp; team');
  expect(markup).toContain('Dismissing…');
  expect(markup).toContain('disabled');
});
