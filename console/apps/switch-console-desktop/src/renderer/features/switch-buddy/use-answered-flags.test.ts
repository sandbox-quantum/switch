// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  allFeatureFlagsOff,
  type ServerFeatureFlags,
} from '@shared/core/feature-flags/feature-flags';

// Add agent turns a machine on by itself only after a flags read that worked
// and says hosted agents v2 is off. A read that fails while signed in answers
// with every flag off, so it must not count as "v2 is off" (B38).

const listeners = new Set<(state: ServerFeatureFlags) => void>();
const flagsState = new Map<string, ServerFeatureFlags>();
const refresh = vi.fn(async () => ({ success: true as const, data: undefined }));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (_channel: unknown, listener: (state: ServerFeatureFlags) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  rpc: {
    featureFlags: {
      get: async (serverId: string) => ({ success: true, data: flagsState.get(serverId) }),
      refresh,
    },
  },
}));
vi.mock('@renderer/features/cloud-agents/use-cloud-agents', () => ({
  useCloudMachines: () => ({ data: undefined }),
}));
vi.mock(
  '@renderer/features/locations/components/add-agent-modal/server-run-locations',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    boxBackends: () => new Map(),
    hasSharedCloudBox: () => false,
  })
);
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  MANAGED_AGENTS_KEY: 'managed-agents',
}));

const { useAnsweredFlags } = await import('./use-this-computer');
const { autoEnablesMachine } =
  await import('@renderer/features/locations/components/add-agent-modal/server-run-locations');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = (
  serverId: string,
  over: { hostedV2?: boolean; fetchedAt?: number | null; error?: string | null } = {}
): ServerFeatureFlags => ({
  serverId,
  flags: { ...allFeatureFlagsOff(), hosted_v2: over.hostedV2 ?? false },
  fetchedAt: over.fetchedAt ?? null,
  error: over.error ?? null,
});
const emit = (next: ServerFeatureFlags) => {
  flagsState.set(next.serverId, next);
  for (const listener of [...listeners]) listener(next);
};

// The form's own rule, from the hook's one answer.
async function open(serverId: string) {
  const seen: { autoEnable: boolean } = { autoEnable: true };
  const root = createRoot(document.createElement('div'));
  function Form() {
    const answer = useAnsweredFlags(serverId);
    seen.autoEnable = autoEnablesMachine(answer.readOk, answer.hostedV2 ?? true);
    return null;
  }
  await act(async () => root.render(createElement(Form)));
  return { seen, root };
}

describe('useAnsweredFlags: Add agent turns on by itself only after a good read', () => {
  it('a read that fails while signed in never turns anything on by itself', async () => {
    flagsState.set('down', state('down', { error: 'The server did not answer in time.' }));
    const { seen, root } = await open('down');
    expect(seen.autoEnable).toBe(false);
    act(() => root.unmount());
  });

  it('nothing before sign-in, nor when the read after signing in fails', async () => {
    flagsState.set('first', state('first', { error: 'Not signed in to this Switch server.' }));
    const { seen, root } = await open('first');
    expect(seen.autoEnable).toBe(false);
    await act(async () => emit(state('first', { error: 'The server did not answer in time.' })));
    expect(seen.autoEnable).toBe(false);
    act(() => root.unmount());
  });

  it('a good read with hosted_v2 off turns on by itself, as upstream', async () => {
    flagsState.set('v1', state('v1', { fetchedAt: 1 }));
    const { seen, root } = await open('v1');
    expect(seen.autoEnable).toBe(true);
    act(() => root.unmount());
  });

  it('a good read with hosted_v2 on never does', async () => {
    flagsState.set('v2', state('v2', { hostedV2: true, fetchedAt: 1 }));
    const { seen, root } = await open('v2');
    expect(seen.autoEnable).toBe(false);
    act(() => root.unmount());
  });

  it('a later failed read takes it back: the form follows the newest answer', async () => {
    flagsState.set('flaky', state('flaky', { fetchedAt: 1 }));
    const { seen, root } = await open('flaky');
    expect(seen.autoEnable).toBe(true);
    await act(async () =>
      emit(state('flaky', { fetchedAt: 1, error: 'The server did not answer in time.' }))
    );
    expect(seen.autoEnable).toBe(false);
    act(() => root.unmount());
  });
});
