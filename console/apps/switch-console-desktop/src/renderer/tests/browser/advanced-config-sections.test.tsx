import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One "Advanced configuration" per agent, in the add-agent modal.
 *
 * A provider keeps its per-agent settings in exactly one place — a repo-agent
 * definition (Claude Code) or a launch profile (Codex, OpenCode) — and the
 * agent's Settings tab picks between them by asking which. The creation form
 * did not ask: it rendered the definition section and the launch-profile
 * section side by side, and the launch-profile one reads a "give me the fields,
 * from wherever they live" call that falls back to the definition fields. So a
 * Claude Code agent got the same section twice, offering to configure the same
 * thing in two boxes that wrote to different places.
 */

const definitionFields = vi.hoisted(() => vi.fn());
const advancedFields = vi.hoisted(() => vi.fn());
const advancedSurface = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    agents: {
      definitionFields,
      advancedFields,
      advancedSurface,
      modelCatalogue: vi.fn(() =>
        Promise.resolve({ kind: 'unavailable', reason: 'not asked in this test' })
      ),
    },
  },
}));

import { AgentAdvancedConfig } from '@renderer/features/locations/components/add-agent-modal/agent-advanced-config';
import { LaunchProfileConfig } from '@renderer/features/locations/components/add-agent-modal/launch-profile-config';

const FIELD = {
  key: 'model',
  label: 'Model',
  type: 'string' as const,
  required: false,
  advanced: true,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  definitionFields.mockReset();
  advancedFields.mockReset();
  advancedSurface.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** Renders the pair exactly as the modal does, and returns how many
 * "Advanced configuration" sections ended up on screen. */
async function sectionCount(): Promise<number> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <AgentAdvancedConfig providerId={'claude' as never} onChange={() => {}} />
        <LaunchProfileConfig
          providerId={'claude' as never}
          sshHost={null}
          dir="/tmp/repo"
          onChange={() => {}}
        />
      </QueryClientProvider>
    )
  );
  // Both sections load their fields over RPC, so the first paint has neither.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // Matched on the opening words rather than the whole string: the disclosure
  // also summarises what it holds ("Claude Code · 1 field"), and how it is
  // summarised is not what this test is about.
  return [...container.querySelectorAll('button')].filter((b) =>
    b.textContent?.trim().startsWith('Advanced configuration')
  ).length;
}

describe('the add-agent modal’s advanced sections', () => {
  it('shows one for a provider that keeps its settings in a definition', async () => {
    // Claude Code. Note both calls answer with fields — that overlap is the
    // whole bug, and it is what the surface has to arbitrate.
    advancedSurface.mockResolvedValue('definition');
    definitionFields.mockResolvedValue([FIELD]);
    advancedFields.mockResolvedValue([FIELD]);

    expect(await sectionCount()).toBe(1);
  });

  it('shows one for a provider that keeps them in a launch profile', async () => {
    // Codex: no definition fields, so only the profile section has anything.
    advancedSurface.mockResolvedValue('launch-profile');
    definitionFields.mockResolvedValue([]);
    advancedFields.mockResolvedValue([FIELD]);

    expect(await sectionCount()).toBe(1);
  });

  it('shows none for a provider with no per-agent settings at all', async () => {
    advancedSurface.mockResolvedValue('none');
    definitionFields.mockResolvedValue([]);
    advancedFields.mockResolvedValue([]);

    expect(await sectionCount()).toBe(0);
  });
});
