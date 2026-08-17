import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
/**
 * What "Who can send instructions" starts on for a brand-new agent (CHOO-2137).
 *
 * This is the ticket's whole point — an agent created in Switch Console answers
 * only its owner unless someone says otherwise — and it lives in one line of
 * form state that nothing else would notice going wrong. An agent created open
 * to everyone still works perfectly, which is exactly why this needs pinning
 * rather than watching.
 */
import { useConfigureAgentForm } from '@renderer/features/locations/components/add-agent-modal/modes';
import { addressingModeOf } from '@shared/core/switch-servers/owner-policy';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** The mode the creation form starts on, read off the real hook. */
async function initialMode(): Promise<string> {
  let seen = '';
  function Probe() {
    const form = useConfigureAgentForm();
    seen = addressingModeOf(form.addressingPolicy);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    )
  );
  return seen;
}

describe('a new agent', () => {
  it('starts answering only its owner', async () => {
    expect(await initialMode()).toBe('owner');
  });

  it('does not start open to everyone', async () => {
    // Stated separately because this is the failure that looks like nothing:
    // an agent anyone can drive behaves normally right up until someone else
    // drives it.
    expect(await initialMode()).not.toBe('anyone');
  });
});
