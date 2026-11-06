import { events } from '@renderer/lib/ipc';
import { menuSelectAllChannel } from '@shared/events/appEvents';

/** Input types whose value is text the user can select. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

/**
 * Whether select-all has something of its own to act on in `el`: a text input,
 * a textarea or a contenteditable region. Everywhere else, select-all would
 * select every piece of text in the window, as on a web page (CHOO-4120).
 */
export function isSelectAllTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/** Monaco handles Cmd/Ctrl+A itself; selecting its hidden textarea would desync it. */
function isInMonaco(el: Element | null): boolean {
  return el?.closest('.monaco-editor') != null;
}

function isSelectAllShortcut(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
  const key = event.key.toLowerCase();
  if (key === 'a') return true;
  // Chromium's own Ctrl+A goes by the physical key, so on Cyrillic, Greek,
  // Hebrew or Arabic layouts (physical A types ф, α, ...) claim KeyA too. Only
  // when the typed key is not a Latin letter: on AZERTY the KeyA position types
  // Q, and claiming it would swallow Ctrl/Cmd+Q (Quit).
  return event.code === 'KeyA' && !/^[a-z]$/.test(key);
}

/**
 * Select all inside the focused field, and do nothing when focus is elsewhere.
 * Returns whether anything was selected.
 */
export function selectAllInFocusedField(doc: Document = document): boolean {
  const el = doc.activeElement;
  if (!isSelectAllTarget(el) || isInMonaco(el)) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select();
  } else {
    // Inside a contenteditable host this selects that host's contents only.
    doc.execCommand('selectAll');
  }
  return true;
}

/**
 * Make Cmd+A / Ctrl+A behave like a desktop app: select-all acts only inside
 * the focused text field.
 *
 * Two paths reach a select-all. Chromium's own Ctrl+A (Windows, Linux) selects
 * the whole page when focus is not in a field, so the keydown is claimed there.
 * The Edit menu's Select All (Cmd+A on macOS, or a click on the menu item) is
 * forwarded here by the main process instead of running Chromium's page-wide
 * select-all.
 */
export function wireSelectAll(
  win: Window = window,
  onMenuSelectAll: (cb: () => void) => () => void = (cb) => events.on(menuSelectAllChannel, cb)
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isSelectAllShortcut(event)) return;
    if (isSelectAllTarget(win.document.activeElement)) return;
    event.preventDefault();
  };
  win.addEventListener('keydown', onKeyDown, true);
  const unlisten = onMenuSelectAll(() => selectAllInFocusedField(win.document));
  return () => {
    win.removeEventListener('keydown', onKeyDown, true);
    unlisten();
  };
}
