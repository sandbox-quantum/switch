import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
/**
 * The permission switches a brand-new agent starts on (CHOO-3775).
 *
 * Room text reaches an agent as a prompt, so an agent whose auto mode nothing
 * reviews (OpenCode's answers every ask itself) would run whatever anyone who
 * can post in its rooms asks for. Such an agent starts asking its owner; auto
 * mode stays an explicit choice, and a choice made for one provider does not
 * follow the form to another.
 */
import {
  type ConfigureAgentFormState,
  useConfigureAgentForm,
} from '@renderer/features/locations/components/add-agent-modal/modes';
import { autoModeDescription } from '@renderer/features/locations/components/settings-view/sections/permission-settings-section';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** Renders the real hook for `providerId` and returns a way to read and re-render it. */
async function renderForm(providerId: AgentProviderId | null) {
  let latest: ConfigureAgentFormState | null = null;
  function Probe({ provider }: { provider: AgentProviderId | null }) {
    latest = useConfigureAgentForm(null, provider);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const render = (provider: AgentProviderId | null) =>
    act(async () =>
      root!.render(
        <QueryClientProvider client={client}>
          <Probe provider={provider} />
        </QueryClientProvider>
      )
    );
  await render(providerId);
  return {
    form: () => latest!,
    switchProvider: render,
  };
}

describe('a new agent’s permission switches', () => {
  it('start with auto mode on for Claude Code', async () => {
    const { form } = await renderForm('claude');
    expect([form().autoMode, form().autoApprove]).toEqual([true, false]);
  });

  it('start with auto mode off for OpenCode, so it asks before running commands', async () => {
    const { form } = await renderForm('opencode');
    expect([form().autoMode, form().autoApprove]).toEqual([false, false]);
  });

  it('let the owner turn auto mode on for OpenCode', async () => {
    const { form } = await renderForm('opencode');
    await act(async () => form().setAutoMode(true));
    expect(form().autoMode).toBe(true);
  });

  it('do not carry auto mode chosen for another provider over to OpenCode', async () => {
    const { form, switchProvider } = await renderForm('claude');
    await act(async () => form().setAutoMode(true));
    await switchProvider('opencode');
    expect(form().autoMode).toBe(false);
  });
});

describe('the auto mode description', () => {
  it('warns for OpenCode that commands then run without review', () => {
    expect(autoModeDescription(['opencode'], false)).toBe(
      'OpenCode has no automatic review: with this on, every action runs without asking, commands included.'
    );
  });

  it('keeps the usual line for a provider with its own review', () => {
    expect(autoModeDescription(['claude'], false)).toBe(
      'Safe actions run on their own; risky ones ask you first.'
    );
  });
});
