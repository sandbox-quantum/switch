import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSidecarTmuxName } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import type { Agent } from '@shared/core/agents/agents';

const h = vi.hoisted(() => {
  const state: { dbNames: string[]; hostListing: string | Error } = {
    dbNames: [],
    hostListing: '',
  };
  const reap = vi.fn<
    (host: unknown, repoDir: string, expected: readonly string[], log: unknown) => Promise<void>
  >(async () => {});
  return { state, reap, warn: vi.fn() };
});

vi.mock('@main/core/agent-runtime/impl/remote-sidecar-launcher', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reapStaleAgentSidecars: h.reap,
}));
vi.mock('./getAgents', () => ({
  getAgents: vi.fn(async () => h.state.dbNames.map((name) => ({ name }))),
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: h.warn, error: vi.fn() } }));

const { reapStaleSidecarsForAgent } = await import('./reap-stale-sidecars');

const REPO = '/srv/repo';
const agent = { id: 'a-1', name: 'mine', locationId: 'loc-1' } as Agent;

function host() {
  return {
    exec: vi.fn(async () => {
      if (h.state.hostListing instanceof Error) throw h.state.hostListing;
      return { stdout: h.state.hostListing, stderr: '' };
    }),
    putFile: vi.fn(async () => {}),
  };
}

/** The expected-set the reaper was handed, as agent slugs rather than hashes. */
function expectedSlugs(candidates: string[]): string[] {
  const passed = new Set(h.reap.mock.calls[0]?.[2] ?? []);
  return candidates.filter((slug) => passed.has(agentSidecarTmuxName(REPO, slug)));
}

describe('reapStaleSidecarsForAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.dbNames = ['mine'];
    h.state.hostListing = '';
  });

  it('spares a co-located agent this Switch Console does not manage', async () => {
    // The shared-host case: someone else onboarded `theirs` in the same
    // directory. It is absent from this install's database, and reaping against
    // that alone would kill a sidecar doing real work for another person.
    h.state.hostListing = 'mine.json\ntheirs.json\n.gitignore\n';

    await reapStaleSidecarsForAgent(agent, host(), REPO);

    expect(expectedSlugs(['mine', 'theirs'])).toEqual(['mine', 'theirs']);
  });

  it('still reaps a generation the directory no longer has credentials for', async () => {
    // A rename deletes the old credentials file, so the host's view marks the
    // previous name reapable — which is the whole point of this function.
    h.state.hostListing = 'mine.json\n';

    await reapStaleSidecarsForAgent(agent, host(), REPO);

    expect(expectedSlugs(['mine', 'old-name'])).toEqual(['mine']);
  });

  it('always protects the invoking agent, even when the host lists nothing', async () => {
    h.state.dbNames = [];
    h.state.hostListing = '';

    await reapStaleSidecarsForAgent(agent, host(), REPO);

    expect(expectedSlugs(['mine'])).toEqual(['mine']);
  });

  it('falls back to the local view when the host cannot be listed', async () => {
    // Narrower is the safe direction: it can only spare a sidecar, never kill
    // an extra one.
    h.state.hostListing = new Error('ssh down');
    h.state.dbNames = ['mine', 'sibling'];

    await reapStaleSidecarsForAgent(agent, host(), REPO);

    expect(expectedSlugs(['mine', 'sibling'])).toEqual(['mine', 'sibling']);
  });

  it('ignores non-JSON entries in the credentials directory', async () => {
    h.state.hostListing = '.gitignore\nREADME\n';

    await reapStaleSidecarsForAgent(agent, host(), REPO);

    expect(expectedSlugs(['.gitignore', 'README', 'mine'])).toEqual(['mine']);
  });

  it('reads the credentials directory of the repo dir it was given', async () => {
    const h2 = host();
    await reapStaleSidecarsForAgent(agent, h2, REPO);

    expect(h2.exec).toHaveBeenCalledWith('ls', ['-1A', '/srv/repo/.switch/agents']);
  });
});
