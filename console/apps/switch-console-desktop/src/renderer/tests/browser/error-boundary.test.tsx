/**
 * A component that throws after the app has mounted is caught by the
 * boundary, which shows the crash screen with the error and a Reload that
 * drops the saved view state first.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const { reset } = vi.hoisted(() => ({
  // Never settles, so clicking Reload does not reload the test page.
  reset: vi.fn(() => new Promise<void>(() => {})),
}));

vi.mock('@renderer/lib/ipc', () => ({ rpc: { viewState: { reset } } }));
vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));

import { ErrorBoundary } from '@renderer/lib/components/error-boundary';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  reset.mockClear();
});

function Throws({ message }: { message: string }): never {
  throw new Error(message);
}

async function renderCrash(message: string): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // React reports a caught render error to the console as well; it is expected.
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => {
      root!.render(
        <ErrorBoundary>
          <Throws message={message} />
        </ErrorBoundary>
      );
    });
  } finally {
    consoleError.mockRestore();
  }
  return container;
}

it('shows the crash screen with the error the component threw', async () => {
  const el = await renderCrash('Cannot read properties of undefined');

  expect(el.querySelector('h1')?.textContent).toBe('Switch Console hit an error and stopped');
  expect(el.textContent).toContain('Reloading usually recovers it.');
  expect(el.textContent).toContain('Cannot read properties of undefined');
});

it('drops the saved view state when Reload is pressed', async () => {
  const el = await renderCrash('boom');

  const button = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Reload');
  await act(async () => button!.click());

  expect(reset).toHaveBeenCalledOnce();
});
