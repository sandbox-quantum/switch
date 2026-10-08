import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One "Advanced configuration" per agent, in the add-agent modal, built from
 * the agent's Switch server's fields for its provider.
 *
 * A provider keeps its per-agent settings in exactly one place — a repo-agent
 * definition (Claude Code) or a launch profile (Codex, OpenCode) — and the
 * definition section and the launch-profile section render side by side, each
 * only for its own surface, so no provider gets the same section twice.
 */

const advancedSettings = vi.hoisted(() => vi.fn());
const advancedConfigSchema = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    agents: {
      providerReadiness: vi.fn(() =>
        Promise.resolve({ status: 'unknown', message: 'Not checked in this test.', models: [] })
      ),
      advancedSettings,
      modelCatalogue: vi.fn(() =>
        Promise.resolve({ kind: 'unavailable', reason: 'not asked in this test' })
      ),
    },
    managedAgents: { advancedConfigSchema },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { AgentAdvancedConfig } from '@renderer/features/locations/components/add-agent-modal/agent-advanced-config';
import { LaunchProfileConfig } from '@renderer/features/locations/components/add-agent-modal/launch-profile-config';

const EFFORT = {
  key: 'effort',
  label: 'Reasoning effort',
  type: 'select' as const,
  options: [
    { value: '', label: 'Default' },
    { value: 'high', label: 'high' },
  ],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  advancedSettings.mockReset();
  advancedConfigSchema.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** Renders the pair exactly as the modal does, for an agent of `providerId` on `server-1`. */
async function render(providerId: string): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <AgentAdvancedConfig
          serverId="server-1"
          cloud={false}
          sshHost={null}
          dir=""
          providerId={providerId as never}
          initial={{}}
          onChange={() => {}}
        />
        <LaunchProfileConfig
          serverId="server-1"
          providerId={providerId as never}
          sshHost={null}
          dir="/tmp/repo"
          onChange={() => {}}
        />
      </QueryClientProvider>
    )
  );
  // The plugin's settings and the server's fields load over RPC, so the first
  // paint has neither.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

/** The "Advanced configuration" sections on screen. */
function sections(on: HTMLElement): HTMLButtonElement[] {
  // Matched on the opening words rather than the whole string: the disclosure
  // also summarises what it holds ("Claude Code · 1 field"), and how it is
  // summarised is not what this test is about.
  return [...on.querySelectorAll('button')].filter((b) =>
    b.textContent?.trim().startsWith('Advanced configuration')
  );
}

/** The field labels of the one section, opened. */
async function openedLabels(on: HTMLElement): Promise<string[]> {
  const [section] = sections(on);
  await act(async () => section!.click());
  return [...on.querySelectorAll('label')].map((label) => label.textContent?.trim() ?? '');
}

function alertText(on: HTMLElement): string | null {
  return on.querySelector('[role="alert"]')?.textContent ?? null;
}

describe('the add-agent modal’s advanced sections', () => {
  it('shows one for a provider that keeps its settings in a definition', async () => {
    advancedSettings.mockResolvedValue({ surface: 'definition', keys: ['effort'] });
    advancedConfigSchema.mockResolvedValue({ claude: [EFFORT] });

    const on = await render('claude');
    expect(sections(on)).toHaveLength(1);
    expect(await openedLabels(on)).toEqual(['Model (optional)', 'Reasoning effort (optional)']);
    expect(alertText(on)).toBeNull();
  });

  it('shows one for a provider that keeps them in a launch profile', async () => {
    advancedSettings.mockResolvedValue({ surface: 'launch-profile', keys: ['effort'] });
    advancedConfigSchema.mockResolvedValue({ codex: [EFFORT] });

    const on = await render('codex');
    expect(sections(on)).toHaveLength(1);
    expect(await openedLabels(on)).toEqual(['Model (optional)', 'Reasoning effort (optional)']);
  });

  it('shows none for a provider the server lists with no fields and that keeps no settings', async () => {
    advancedSettings.mockResolvedValue({ surface: 'none', keys: [] });
    advancedConfigSchema.mockResolvedValue({ newcli: [] });

    const on = await render('newcli');
    expect(sections(on)).toHaveLength(0);
    expect(alertText(on)).toBeNull();
  });

  it('names a server field for a provider that keeps no settings, without a section', async () => {
    advancedSettings.mockResolvedValue({ surface: 'none', keys: [] });
    advancedConfigSchema.mockResolvedValue({ newcli: [EFFORT] });

    const on = await render('newcli');
    expect(sections(on)).toHaveLength(0);
    expect(alertText(on)).toMatch(/cannot apply for newcli: Reasoning effort/);
  });

  it('offers only the model for a launch-profile provider the server lists with no fields', async () => {
    advancedSettings.mockResolvedValue({ surface: 'launch-profile', keys: [] });
    advancedConfigSchema.mockResolvedValue({ cursor: [] });

    const on = await render('cursor');
    expect(await openedLabels(on)).toEqual(['Model (optional)']);
    expect(alertText(on)).toBeNull();
  });

  it('says so when the server’s fields cannot be read, and offers only the model', async () => {
    advancedSettings.mockResolvedValue({ surface: 'launch-profile', keys: ['effort'] });
    advancedConfigSchema.mockRejectedValue(new Error('Switch is unreachable.'));

    const on = await render('codex');
    expect(alertText(on)).toContain('Switch is unreachable.');
    expect(await openedLabels(on)).toEqual(['Model (optional)']);
  });

  it('says so when the server does not list the provider', async () => {
    advancedSettings.mockResolvedValue({ surface: 'launch-profile', keys: ['effort'] });
    advancedConfigSchema.mockResolvedValue({ claude: [] });

    const on = await render('codex');
    expect(alertText(on)).toMatch(/does not list Codex/);
  });

  it('names a server field this Console cannot apply, rather than offering it', async () => {
    advancedSettings.mockResolvedValue({ surface: 'launch-profile', keys: [] });
    advancedConfigSchema.mockResolvedValue({ codex: [EFFORT] });

    const on = await render('codex');
    expect(alertText(on)).toMatch(/cannot apply for Codex: Reasoning effort/);
    expect(await openedLabels(on)).toEqual(['Model (optional)']);
  });
});
