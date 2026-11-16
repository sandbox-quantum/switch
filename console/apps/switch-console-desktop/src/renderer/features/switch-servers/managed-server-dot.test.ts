import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { ManagedServerState } from './managed-server-state';

const state = vi.hoisted(() => ({ current: null as ManagedServerState | null }));
vi.mock('./managed-server-state', () => ({ managedServerState: () => state.current }));

const { ManagedServerDot } = await import('./managed-server-dot');

const render = () =>
  renderToStaticMarkup(
    React.createElement(ManagedServerDot, { server: {} as SwitchServer, size: 7 })
  );

it('says the dot is the server’s status, in its tooltip and to screen readers', () => {
  state.current = {
    tone: 'running',
    reason: 'running',
    label: 'Running',
    answering: true,
    known: true,
  };
  const html = render();
  expect(html).toContain('aria-label="Server status: Running"');
  expect(html).toContain('title="Server status: Running"');
});

it('shows nothing before the server’s state is known', () => {
  state.current = {
    tone: 'stopped',
    reason: 'stopped',
    label: 'Not running',
    answering: false,
    known: false,
  };
  expect(render()).toBe('');
});
