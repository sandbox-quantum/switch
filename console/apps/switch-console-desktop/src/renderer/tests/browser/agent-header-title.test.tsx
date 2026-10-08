/**
 * The agent page title stays on one line. A short name used to break mid-word
 * ("yod" / "a", "mt-" / "test") to leave room for the badges beside it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
// Line breaks are the subject, so the real utility classes must be present.
import '@renderer/index.css';
import { AgentHeaderLayout } from '@renderer/features/locations/components/main-panel/agent-page-header';
import { InlineEditableText } from '@renderer/features/managed-agents/inline-editable-text';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderHeader(name: string, width: number): Promise<HTMLButtonElement> {
  container = document.createElement('div');
  container.style.width = `${width}px`;
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <AgentHeaderLayout
        avatar={<span />}
        title={
          <InlineEditableText
            value=""
            placeholder={name}
            mutedPlaceholder={false}
            label="Display name"
            className="text-3xl font-semibold tracking-tight"
            onChange={() => {}}
          />
        }
        badges={
          <>
            <span className="rounded px-2 text-[11px]">Claude Code</span>
            <span className="rounded px-2 text-xs">on a-machine-with-a-long-name</span>
          </>
        }
        machineName={null}
        description="A Claude Code agent."
        actions={null}
      />
    )
  );
  return container.querySelector<HTMLButtonElement>('button[aria-label="Edit display name"]')!;
}

function lines(element: HTMLElement): number {
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  return Math.round(element.getBoundingClientRect().height / lineHeight);
}

describe('the agent page title', () => {
  it.each([
    ['yoda', [900, 560, 420]],
    ['mt-test', [900, 560, 420]],
    ['opencode.qnav_cc.lamaudruz', [900, 640]],
  ] as const)('keeps %s on one line, beside its badges or above them', async (name, widths) => {
    for (const width of widths) {
      const title = await renderHeader(name, width);
      expect(lines(title), `${name} at ${width}px`).toBe(1);
      await act(async () => root!.unmount());
      container?.remove();
      root = null;
    }
  });
});
