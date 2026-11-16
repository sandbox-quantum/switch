/**
 * The Switch Trust settings say what Switch Trust does not check: the
 * kinds of file it cannot read, which are sent unchecked, and how much of a
 * message or a file's text it checks.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const switchServers = vi.hoisted(() => ({
  getTrustSettings: vi.fn(async () => ({
    kind: 'loaded',
    settings: {
      endpoint: 'https://trust.example',
      policyId: 'pol_1',
      hasApiKey: true,
      apiKeyLast4: '6789',
      enabled: true,
    },
  })),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { onServerInScope: () => ({ id: 'workspace', name: 'Acme' }) },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    statusFor: () => ({ connected: true, user: { role: 'admin' } }),
    serverById: () => ({ id: 'server', name: 'Dev Server' }),
  },
}));

import { GuardrailsSection } from '@renderer/features/switch-servers/GuardrailsSection';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('names the files Switch Trust cannot read and says they are sent unchecked', async () => {
  await act(async () => {
    root.render(<GuardrailsSection serverId="server" initiallyOpen />);
  });
  await vi.waitFor(() => expect(container.textContent).toContain('Switch Trust API key'));

  const text = container.textContent ?? '';
  expect(text).toContain(
    "Images, audio, video, archives, and Office files other than Word documents can't be read, so they are sent unchecked."
  );
  expect(text).toContain('Only the first 20,000 characters of each are checked');
});
