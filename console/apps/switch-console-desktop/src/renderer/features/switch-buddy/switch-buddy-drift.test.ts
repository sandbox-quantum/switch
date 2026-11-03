/**
 * What Switch Console assumes about switch-buddy's template, which the server
 * ships: kept equal here, so a change on one side that the other does not
 * follow fails a test rather than a person's onboarding.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_RUNTIMES } from '@switch-console/agent-providers';
import { load } from 'js-yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUDDY_ICON_URL } from '@shared/core/agents/switch-buddy';

const runTemplateDocument = vi.hoisted(() => vi.fn());
const report = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    managedAgents: { list: async () => [] },
    workspaces: {
      getTemplateDetail: async () => ({ name: 'switch-buddy', definition: 'version: 2' }),
      runTemplateDocument,
    },
  },
}));
vi.mock('@renderer/lib/telemetry/report', () => ({ report }));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'ws-1' },
}));

const { createBuddy } = await import('./create-buddy');
const { reportBuddyStep } = await import('./buddy-telemetry');

type BuddyTemplate = {
  params: Record<string, unknown>;
  resources: { buddy: { icon_url: string } };
};

const template = load(
  readFileSync(
    join(
      __dirname,
      '../../../../../../../core/switch_core/official_templates/switch-buddy/template.yaml'
    ),
    'utf8'
  )
) as BuddyTemplate;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("switch-buddy's template, as Console uses it", () => {
  it('carries the icon Console shows its bundled copy for', () => {
    expect(template.resources.buddy.icon_url).toBe(BUDDY_ICON_URL);
  });

  it('declares every input Console fills when it creates the buddy', async () => {
    runTemplateDocument.mockResolvedValue({
      kind: 'created',
      createdAgents: [{ agentId: 'a-1', name: 'switch-buddy-max' }],
    });

    await createBuddy({
      serverId: 'srv-1',
      workspaceId: 'ws-1',
      machineId: 'm-1',
      provider: 'claude',
      person: { name: 'Max', email: null },
      entryPoint: 'onboarding',
    });

    const sent = Object.keys(runTemplateDocument.mock.calls[0]![1].inputs);
    expect(sent.length).toBeGreaterThan(0);
    // The server refuses an input the template does not declare, and with it
    // the whole buddy.
    expect(sent.filter((name) => !(name in template.params))).toEqual([]);
  });

  it("reports every provider Console runs by its own name in the buddy's telemetry", () => {
    for (const runtime of PROVIDER_RUNTIMES) reportBuddyStep('start', runtime.id);

    expect(report.mock.calls.map(([, payload]) => payload.provider)).toEqual(
      PROVIDER_RUNTIMES.map((runtime) => runtime.id)
    );
  });
});
