import { runInAction } from 'mobx';
import '@renderer/index.css';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { LocalServerStatus } from '@shared/core/managed-switch-server/managed-switch-server';

const start = vi.hoisted(() => vi.fn());
vi.mock('@renderer/features/switch-servers/local-server-store', async () => {
  const { observable } = await import('mobx');
  return {
    localServerStore: observable({
      status: null as LocalServerStatus | null,
      logs: [] as string[],
      isTransitioning: false,
      start,
    }),
  };
});
vi.mock('@renderer/features/switch-servers/switch-servers-store', async () => {
  const { observable } = await import('mobx');
  return { switchServersStore: observable({ activeServerId: 'local' }) };
});
const { localServerStore } = await import('@renderer/features/switch-servers/local-server-store');
const { switchServersStore } =
  await import('@renderer/features/switch-servers/switch-servers-store');
const { LocalServerUpgradeNotice } =
  await import('@renderer/features/switch-servers/LocalServerUpgradeNotice');
let element: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  element.style.width = '660px';
  document.body.append(element);
  root = createRoot(element);
  runInAction(() => {
    switchServersStore.activeServerId = 'local';
    localServerStore.status = {
      phase: 'starting',
      serverId: 'local',
      version: '1.0.0',
      deployedVersion: '0.9.0',
      drift: null,
      checkoutBuild: null,
      message: 'Backing up your local server database…',
      error: null,
      upgrade: 'updating',
    };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
it('shows progress, expands activity, and gives an actionable retry after failure', async () => {
  await act(async () => root.render(createElement(LocalServerUpgradeNotice)));
  expect(element.textContent).toContain('Updating your local Switch server');
  expect(element.querySelector('[role="status"]')?.textContent).toContain('Backing up');
  await page.getByRole('button', { name: 'Show details' }).click();
  expect(element.textContent).toContain('Update activity will appear here');
  await act(async () =>
    runInAction(() => {
      localServerStore.status = {
        ...localServerStore.status!,
        upgrade: 'required',
        phase: 'error',
        error: 'Open Docker, then retry to finish updating your local server.',
      };
    })
  );
  expect(element.querySelector('[role="status"]')?.textContent).toContain('Open Docker');
  const retry = [...element.querySelectorAll('button')].find(
    (b) => b.textContent === 'Retry update'
  )!;
  expect(retry).toBeDefined();
  await page.getByRole('button', { name: 'Retry update' }).click();
  expect(start).toHaveBeenCalledOnce();
});
it('keeps other servers usable and removes the notice after success', async () => {
  await act(async () => root.render(createElement(LocalServerUpgradeNotice)));
  await act(async () =>
    runInAction(() => {
      switchServersStore.activeServerId = 'other';
    })
  );
  expect(element.textContent).toBe('');
  await act(async () =>
    runInAction(() => {
      switchServersStore.activeServerId = 'local';
      localServerStore.status = { ...localServerStore.status!, phase: 'running', upgrade: null };
    })
  );
  expect(element.textContent).toBe('');
});
it('never offers retrying a downgrade and leaves stopped servers as an explicit start', async () => {
  await act(async () =>
    runInAction(() => {
      localServerStore.status = {
        ...localServerStore.status!,
        upgrade: 'required',
        phase: 'stopped',
      };
    })
  );
  await act(async () => root.render(createElement(LocalServerUpgradeNotice)));
  expect(element.textContent).toContain('Update and start');
  await act(async () =>
    runInAction(() => {
      localServerStore.status = {
        ...localServerStore.status!,
        drift: { direction: 'downgrade', deployed: '2.0.0', expected: '1.0.0' },
      };
    })
  );
  expect(element.textContent).toContain('A newer Switch Console is needed');
  expect(element.textContent).not.toContain('Update and start');
});

it('keeps the retry button and long errors readable in a narrow panel', async () => {
  await page.viewport(720, 420);
  element.style.width = '360px';
  await act(async () => root.render(createElement(LocalServerUpgradeNotice)));
  await page.screenshot({ path: '__screenshots__/switch-upgrade-ui-progress.png' });
  await act(async () =>
    runInAction(() => {
      localServerStore.status = {
        ...localServerStore.status!,
        phase: 'error',
        upgrade: 'required',
        error:
          'Image download failed. Check your connection, then retry. Your database backup is safe.',
      };
    })
  );
  await page.getByRole('button', { name: 'Show details' }).click();
  const button = page
    .getByRole('button', { name: 'Retry update' })
    .element()
    .getBoundingClientRect();
  const title = element.querySelector('h2')!.getBoundingClientRect();
  expect(button.width).toBeGreaterThan(50);
  expect(title.right).toBeLessThanOrEqual(button.left);
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
  await page.screenshot({ path: '__screenshots__/switch-upgrade-ui-retry.png' });
});
