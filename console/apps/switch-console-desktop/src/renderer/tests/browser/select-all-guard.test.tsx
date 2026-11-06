/**
 * Cmd+A / Ctrl+A selects inside the focused text field only, never the whole
 * window as on a web page (CHOO-4120).
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { wireSelectAll } from '@renderer/lib/select-all';

let container: HTMLDivElement;
let unwire: () => void;
let menuSelectAll: () => void;

// App chrome only: Chromium's page-wide select-all is what this guards against.
const CHROME = '<p>Some app chrome text</p><button type="button">Click</button>';
const FIELDS = `
  <input type="text" value="input text" />
  <textarea>textarea text</textarea>
  <div contenteditable="true">editable text</div>`;

function mount(html: string): void {
  container.innerHTML = html;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  unwire = wireSelectAll(window, (cb) => {
    menuSelectAll = cb;
    return () => {};
  });
});

afterEach(() => {
  unwire();
  container.remove();
  window.getSelection()?.removeAllRanges();
});

const selectedText = () => window.getSelection()?.toString() ?? '';
const pressSelectAll = () => userEvent.keyboard('{Control>}a{/Control}');

it('Ctrl+A on a focused button selects nothing', async () => {
  mount(CHROME);
  container.querySelector('button')!.focus();
  await pressSelectAll();
  expect(selectedText()).toBe('');
});

it('Ctrl+A with nothing focused selects nothing', async () => {
  mount(CHROME);
  (document.activeElement as HTMLElement | null)?.blur();
  await pressSelectAll();
  expect(selectedText()).toBe('');
});

it('Ctrl+A in a text input selects only its value', async () => {
  mount(CHROME + FIELDS);
  const input = container.querySelector('input')!;
  input.focus();
  await pressSelectAll();
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
});

it('Ctrl+A in a textarea selects only its value', async () => {
  mount(CHROME + FIELDS);
  const textarea = container.querySelector('textarea')!;
  textarea.focus();
  await pressSelectAll();
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, textarea.value.length]);
});

it('Ctrl+A in a contenteditable selects only its text', async () => {
  mount(CHROME + FIELDS);
  (container.querySelector('[contenteditable]') as HTMLElement).focus();
  await pressSelectAll();
  expect(selectedText()).toBe('editable text');
});

it('Ctrl+Q on AZERTY (physical KeyA) is left alone so Quit still works', () => {
  mount(CHROME);
  const button = container.querySelector('button')!;
  button.focus();
  const event = new KeyboardEvent('keydown', {
    key: 'q',
    code: 'KeyA',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  button.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});

function ctrlKeyDown(target: Element, key: string, code: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    code,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

it('Ctrl+A on a Cyrillic layout (physical KeyA types ф) is claimed on a button', () => {
  mount(CHROME);
  const button = container.querySelector('button')!;
  button.focus();
  expect(ctrlKeyDown(button, 'ф', 'KeyA').defaultPrevented).toBe(true);
});

it('Ctrl+A on a Cyrillic layout is left to a focused text field', () => {
  mount(CHROME + FIELDS);
  const input = container.querySelector('input')!;
  input.focus();
  expect(ctrlKeyDown(input, 'ф', 'KeyA').defaultPrevented).toBe(false);
});

it('menu Select All leaves Monaco alone', () => {
  mount('<div class="monaco-editor"><textarea>monaco hidden input</textarea></div>');
  const textarea = container.querySelector('textarea')!;
  textarea.focus();
  textarea.setSelectionRange(3, 3);
  menuSelectAll();
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 3]);
});

it('menu Select All on a focused button selects nothing', () => {
  mount(CHROME);
  container.querySelector('button')!.focus();
  menuSelectAll();
  expect(selectedText()).toBe('');
});

it('menu Select All in a text input selects only its value', () => {
  mount(CHROME + FIELDS);
  const input = container.querySelector('input')!;
  input.focus();
  menuSelectAll();
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
});

it('menu Select All in a contenteditable selects only its text', () => {
  mount(CHROME + FIELDS);
  (container.querySelector('[contenteditable]') as HTMLElement).focus();
  menuSelectAll();
  expect(selectedText()).toBe('editable text');
});
