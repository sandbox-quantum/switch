/**
 * What the creating screen says when a template run outlasts Switch Console's
 * wait (bug 14): each step as the server reports it, never "Nothing was
 * created" while something exists, and Retry to finish the rest.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemplateRunSoFar } from '@main/core/switch-servers/gateway-client';
import { CreatingScreen } from '@renderer/features/templates/use/creating-screen';
import { reconcileRun } from '@renderer/features/templates/use/reconcile-run';
import {
  type CreateStep,
  createStepStatus,
} from '@renderer/features/templates/use/use-template-model';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

const AGENTS = ['acme-triage-assistant', 'acme-repro-helper'];

/** The screen as the Use page shows it after reading the run back. */
async function showReadBack(soFar: TemplateRunSoFar | null, onRetry = vi.fn()) {
  const run = reconcileRun({ agentNames: AGENTS, roomCount: 1, soFar });
  const steps: CreateStep[] = [
    ...AGENTS.map((name) => ({
      key: name,
      label: `Create ${name}`,
      status: createStepStatus(run.agents.get(name)!.status),
      error: run.agents.get(name)!.error,
    })),
    { key: 'room', label: 'Create the room', status: createStepStatus(run.room!.status) },
  ];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <CreatingScreen
        templateName="Bug Triage Room"
        phase="failed"
        steps={steps}
        error={run.message}
        outlasted={run.state}
        doneDetail={null}
        onRetry={onRetry}
        onBack={() => {}}
      />
    )
  );
  return container;
}

function stepWords(el: HTMLElement): string[] {
  return [...el.querySelectorAll('li')].map((li) => li.textContent ?? '');
}

describe('a template run that outlasted the wait', () => {
  it('claims nothing either way when the server could not be asked', async () => {
    const el = await showReadBack(null);

    expect(el.textContent).toContain('The server did not answer in time');
    expect(el.textContent).not.toContain('Nothing was created');
    expect(el.textContent).toContain('Retry remaining steps');
  });

  it('shows the agents made and the room still being made', async () => {
    const el = await showReadBack({
      inFlight: true,
      agents: [
        { agentId: 'a1', name: 'acme-triage-assistant' },
        { agentId: 'a2', name: 'acme-repro-helper' },
      ],
      rooms: [],
    });

    expect(el.textContent).toContain('Bug Triage Room is still being created');
    expect(el.textContent).not.toContain('Nothing was created');
    const [triage, repro, room] = stepWords(el);
    expect(triage).toMatch(/done$/);
    expect(repro).toMatch(/done$/);
    expect(room).toMatch(/working$/);
  });

  it('keeps what was made and offers to finish the rest once no attempt is going', async () => {
    const onRetry = vi.fn();
    const el = await showReadBack(
      {
        inFlight: false,
        agents: [
          { agentId: 'a1', name: 'acme-triage-assistant' },
          { agentId: 'a2', name: 'acme-repro-helper' },
        ],
        rooms: [],
      },
      onRetry
    );

    expect(el.textContent).toContain('Stopped at one step');
    expect(el.textContent).toContain('What was created stays created.');
    expect(el.textContent).not.toContain('Nothing was created');
    const retry = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Retry remaining steps'
    );
    await act(async () => retry!.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
