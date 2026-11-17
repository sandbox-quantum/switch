/**
 * A template run still going on the server is read back every few seconds
 * while the creating screen says so, and its steps update in place, instead
 * of waiting for Retry (found on the integration walk of #2047).
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemplateRunSoFar } from '@main/core/switch-servers/gateway-client';
import { CreatingScreen } from '@renderer/features/templates/use/creating-screen';
import { type OutlastedState, reconcileRun } from '@renderer/features/templates/use/reconcile-run';
import { createStepStatus } from '@renderer/features/templates/use/use-template-model';
import { useWhileRunning } from '@renderer/features/templates/use/use-while-running';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

const AGENTS = ['india-triage-assistant', 'india-repro-helper'];

/** The Use page's read-back loop around the creating screen, over `readBack`. */
function ReadBackScreen({ readBack }: { readBack: () => Promise<TemplateRunSoFar> }) {
  const [soFar, setSoFar] = useState<TemplateRunSoFar>({ inFlight: true, agents: [], rooms: [] });
  const run = reconcileRun({ agentNames: AGENTS, roomCount: 1, soFar });
  const outlasted: OutlastedState | null = run.complete ? null : run.state;
  useWhileRunning(outlasted === 'running', 20, async () => setSoFar(await readBack()));
  return (
    <CreatingScreen
      templateName="Bug Triage Room"
      phase={run.complete ? 'done' : 'failed'}
      steps={[
        ...AGENTS.map((name) => ({
          key: name,
          label: `Create ${name}`,
          status: createStepStatus(run.agents.get(name)!.status),
        })),
        { key: 'room', label: 'Create the room', status: createStepStatus(run.room!.status) },
      ]}
      error={run.message}
      outlasted={outlasted}
      doneDetail="Opening India - Bug Triage…"
      onRetry={() => {}}
      onBack={() => {}}
    />
  );
}

async function mount(readBack: () => Promise<TemplateRunSoFar>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ReadBackScreen readBack={readBack} />));
  return container;
}

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

describe('a template run still going on the server', () => {
  it('updates its steps in place as the server makes them, then opens', async () => {
    const answers: TemplateRunSoFar[] = [
      { inFlight: true, agents: [{ agentId: 'a1', name: 'india-triage-assistant' }], rooms: [] },
      {
        inFlight: true,
        agents: [
          { agentId: 'a1', name: 'india-triage-assistant' },
          { agentId: 'a2', name: 'india-repro-helper' },
        ],
        rooms: [],
      },
      {
        inFlight: false,
        agents: [
          { agentId: 'a1', name: 'india-triage-assistant' },
          { agentId: 'a2', name: 'india-repro-helper' },
        ],
        rooms: [{ roomId: 'r1', roomName: 'India - Bug Triage', kickoffPosted: true }],
      },
    ];
    const readBack = vi.fn(async () => answers[Math.min(readBack.mock.calls.length - 1, 2)]!);
    const el = await mount(readBack);
    expect(el.textContent).toContain('is still being created');

    await wait(30);
    expect([...el.querySelectorAll('li')].map((li) => li.textContent)[0]).toMatch(/done$/);
    await wait(30);
    await wait(30);

    expect(el.textContent).toContain('Bug Triage Room is ready');
    const calls = readBack.mock.calls.length;
    await wait(80);
    expect(readBack.mock.calls.length).toBe(calls);
  });

  it('keeps reading after a read-back that fails, one call at a time', async () => {
    let inFlightCalls = 0;
    let overlapped = false;
    const readBack = vi.fn(async () => {
      inFlightCalls += 1;
      if (inFlightCalls > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 30));
      inFlightCalls -= 1;
      if (readBack.mock.calls.length === 1) throw new Error('not answering');
      return { inFlight: true, agents: [], rooms: [] };
    });
    await mount(readBack);

    await wait(200);

    expect(readBack.mock.calls.length).toBeGreaterThan(2);
    expect(overlapped).toBe(false);
  });
});
