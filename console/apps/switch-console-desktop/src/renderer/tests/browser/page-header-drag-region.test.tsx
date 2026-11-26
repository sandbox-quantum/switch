import { PageHeader } from '@switch-console/chat-ui/primitives/page-header';
import { PageSidebarMenu } from '@switch-console/chat-ui/primitives/page-layout';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

it('leaves a scrolling page header out of the window drag region, so its buttons and the titlebar stay clickable', async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <div style={{ height: 200, overflow: 'auto' }}>
        <PageHeader sticky title="Template" back={<button type="button">All templates</button>}>
          <button type="button">Use template</button>
        </PageHeader>
        <div style={{ height: 2000 }} />
      </div>
    )
  );

  const regions = [container.querySelector('div')!, ...container.querySelectorAll('*')].map(
    (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') || 'none'
  );
  expect(regions.filter((region) => region === 'drag')).toEqual([]);
});

it('leaves the sticky settings sidebar out of the window drag region too', async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <div style={{ height: 200, overflow: 'auto' }}>
        <PageSidebarMenu
          items={[
            { id: 'a', label: 'Preferences' },
            { id: 'b', label: 'Guardrails' },
          ]}
          activeId="a"
          onSelect={() => {}}
        />
        <div style={{ height: 2000 }} />
      </div>
    )
  );

  const regions = [...container.querySelectorAll('*')].map(
    (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') || 'none'
  );
  expect(regions.filter((region) => region === 'drag')).toEqual([]);
});
