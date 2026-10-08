/**
 * A cloud agent whose worker cannot be asked says why: a sleeping machine reads
 * as asleep and says a message wakes it, or offers Wake where there is no
 * composer, and any other relay refusal is an alert.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CloudProblem } from '@renderer/features/cloud-agents/cloud-problem';
import type { CloudProblemAction } from '@renderer/features/cloud-agents/use-cloud-agents';
import type { CloudRelayProblem } from '@shared/core/cloud-agents/cloud-agents';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(
  problem: CloudRelayProblem,
  action: CloudProblemAction | null = null,
  machineReady = false,
  compact = true
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <CloudProblem
        problem={problem}
        machineReady={machineReady}
        compact={compact}
        action={action}
      />
    )
  );
  return container;
}

it('reads a sleeping machine as asleep and says a message wakes it', async () => {
  const el = await render({
    code: 'worker_sleeping',
    message: 'The cloud machine is asleep.',
    wakeAvailable: true,
  });
  const status = el.querySelector('[role="status"]');
  expect(status?.textContent).toContain('asleep');
  expect(status?.textContent).toContain('Send a message to wake it.');
  expect(el.querySelector('[role="alert"]')).toBeNull();
  expect(el.querySelector('button')).toBeNull();
});

it('shows any other refusal as an alert', async () => {
  const el = await render({
    code: 'worker_busy',
    message: 'The worker has too many requests in flight.',
    wakeAvailable: false,
  });
  const alert = el.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('busy');
  expect(alert?.textContent).not.toContain('wake');
  expect(el.querySelector('button')).toBeNull();
});

it('offers Wake in place of the hint where there is no composer', async () => {
  const run = vi.fn();
  const el = await render(
    { code: 'worker_sleeping', message: 'The cloud machine is asleep.', wakeAvailable: true },
    { label: 'Wake', pending: false, error: null, run }
  );
  expect(el.textContent).not.toContain('Send a message to wake it.');
  const wake = el.querySelector('button');
  expect(wake?.textContent).toBe('Wake');
  await act(async () => wake!.click());
  expect(run).toHaveBeenCalledOnce();
});

it('says nothing about waking a sleeping machine that a message would not wake', async () => {
  const el = await render({
    code: 'worker_sleeping',
    message: 'The cloud machine is asleep.',
    wakeAvailable: false,
  });
  expect(el.textContent).not.toContain('wake it');
  expect(el.querySelector('button')).toBeNull();
});

it('shows a machine in error with Retry and why a retry failed', async () => {
  const el = await render(
    { code: 'machine_error', message: 'The machine did not connect.', wakeAvailable: false },
    {
      label: 'Retry machine',
      pending: false,
      error: 'Could not retry the machine: boom',
      run: vi.fn(),
    }
  );
  expect(el.textContent).toContain('The cloud machine is in error.');
  expect(el.textContent).toContain('Could not retry the machine: boom');
  expect(el.querySelector('button')?.textContent).toBe('Retry machine');
});

const waking: CloudRelayProblem = {
  code: 'worker_waking',
  message: 'The cloud machine is starting.',
  wakeAvailable: false,
};

it('says only the agent is starting when its machine is already running', async () => {
  const el = await render(waking, null, true);
  expect(el.textContent).toContain('The agent is starting.');
  expect(el.textContent).not.toContain('cloud machine');
});

it('says the machine is starting while the machine itself wakes', async () => {
  const el = await render(waking, null, false);
  expect(el.textContent).toContain('The cloud machine is starting.');
  expect(el.textContent).not.toContain('The agent is starting.');
});

const unknownCode: CloudRelayProblem = {
  code: 'quota_exceeded',
  message: 'The account has used its cloud hours for this month.',
  wakeAvailable: false,
};

it('shows the server’s reason for a code it has no title for', async () => {
  const el = await render(unknownCode);
  expect(el.textContent).toContain('The account has used its cloud hours for this month.');
  expect(el.textContent).not.toContain('could not be reached');
});

it('shows the server’s reason beside the generic title outside the compact view', async () => {
  const el = await render(unknownCode, null, false, false);
  expect(el.textContent).toContain('The cloud worker could not be reached.');
  const detail = el.querySelector('[role="alert"] .text-foreground-muted');
  expect(detail?.textContent).toContain('The account has used its cloud hours for this month.');
});
