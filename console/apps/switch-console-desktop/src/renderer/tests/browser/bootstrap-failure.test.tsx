/**
 * A renderer whose bootstrap fails shows why, instead of a blank window
 * (CHOO-3384: a schema mismatch failed the first query, and the only trace of
 * it was a line in the log).
 */
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { renderBootstrapFailure } from '@renderer/bootstrap-failure';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(error: unknown): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = renderBootstrapFailure(container!, error);
  });
  return container;
}

it('says the app could not start and shows the error it failed on', async () => {
  const el = await render(
    new Error('no such column: "server_id" - should this be a string literal in single-quotes?')
  );

  expect(el.querySelector('h1')?.textContent).toBe('Switch Console could not start');
  expect(el.textContent).toContain('no such column: "server_id"');
});

it('offers a reload', async () => {
  const el = await render(new Error('boom'));

  const button = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Reload');
  expect(button).toBeDefined();
});

it('shows a thrown value that is not an Error', async () => {
  const el = await render('RpcError: database is locked');

  expect(el.textContent).toContain('RpcError: database is locked');
});

it('says so when the failure carried no message', async () => {
  const el = await render(new Error(''));

  expect(el.textContent).toContain('No further detail was reported.');
});
