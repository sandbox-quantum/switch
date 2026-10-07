/**
 * Connecting several providers names the step each Continue leads to: the next
 * provider while any are left, and the step after them only once none are.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const switchServers = vi.hoisted(() => ({
  getClaudeConnection: vi.fn(async () => ({
    status: 'connected',
    kind: 'api-key',
    verified_at: '2026-01-01T00:00:00Z',
  })),
  getCloudProviderConnection: vi.fn(async () => ({ status: 'connected' })),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers },
}));

import { ManagedProviderConnectionSequence } from '@renderer/features/switch-servers/managed-provider-connection-step';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

function Harness({ providers }: { providers: AgentProviderId[] }) {
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);
  if (done) return <p>GitHub step</p>;
  return (
    <ManagedProviderConnectionSequence
      serverId="server"
      providers={providers}
      index={index}
      onIndexChange={setIndex}
      onBack={() => {}}
      onDone={() => setDone(true)}
      doneStepName="GitHub"
    />
  );
}

async function render(providers: AgentProviderId[]): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Dialog open>
          <DialogContent>
            <Harness providers={providers} />
          </DialogContent>
        </Dialog>
      </QueryClientProvider>
    )
  );
  return document.body;
}

async function continueButton(el: HTMLElement): Promise<HTMLButtonElement> {
  await vi.waitFor(() => {
    const button = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Continue to')
    );
    expect(button?.disabled).toBe(false);
  });
  return [...el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Continue to'))!;
}

it('names the next provider, then GitHub, and goes where it says', async () => {
  const el = await render(['claude', 'codex']);

  const first = await continueButton(el);
  expect(el.textContent).toContain('Claude Code connected');
  expect(first.textContent).toBe('Continue to Codex');
  await act(async () => first.click());

  const second = await continueButton(el);
  expect(el.textContent).toContain('Connect Codex');
  expect(second.textContent).toBe('Continue to GitHub');
  await act(async () => second.click());

  expect(el.textContent).toContain('GitHub step');
});

it('names Claude Code when it is chosen after another provider', async () => {
  const el = await render(['codex', 'claude']);

  const first = await continueButton(el);
  expect(el.textContent).toContain('Connect Codex');
  expect(first.textContent).toBe('Continue to Claude Code');
  await act(async () => first.click());

  const second = await continueButton(el);
  expect(el.textContent).toContain('Claude Code connected');
  expect(second.textContent).toBe('Continue to GitHub');
});

it('asks to reconnect a login the cloud controller can no longer use, and does not continue', async () => {
  switchServers.getClaudeConnection.mockResolvedValueOnce({
    status: 'reconnect_required',
    kind: 'setup-token',
    verified_at: '2026-01-01T00:00:00Z',
  });
  const el = await render(['claude', 'cursor']);

  await vi.waitFor(() => expect(el.textContent).toContain('Reconnect Claude Code'));
  const buttons = () => [...el.querySelectorAll('button')].map((b) => b.textContent);
  expect(buttons()).toContain('Reconnect');
  expect(buttons().some((label) => label?.startsWith('Continue to'))).toBe(false);
});

it('offers Reconnect, not Continue, for another provider', async () => {
  switchServers.getCloudProviderConnection.mockResolvedValueOnce({
    status: 'reconnect_required',
    kind: 'api-key',
    verified_at: '2026-01-01T00:00:00Z',
  } as never);
  const el = await render(['cursor']);

  await vi.waitFor(() =>
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toContain('Reconnect')
  );
  const next = [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Continue to')
  );
  expect(next?.disabled).toBe(true);
});
