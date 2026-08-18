import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const back = vi.hoisted(() => vi.fn());
const forward = vi.hoisted(() => vi.fn());
const eventsOn = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock('@renderer/lib/components/nav-buttons', () => ({ applyHistoryEntry: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: eventsOn } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { history: { back, forward } } }));

const { wireMouseNavigation } = await import('./mouse-navigation');

let dom: JSDOM;
let teardown: () => void;

function press(button: number): MouseEvent {
  const event = new dom.window.MouseEvent('mouseup', { button, bubbles: true, cancelable: true });
  dom.window.document.body.dispatchEvent(event);
  return event as unknown as MouseEvent;
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.clearAllMocks();
  teardown = wireMouseNavigation();
});

afterEach(() => {
  teardown();
  vi.unstubAllGlobals();
});

describe('mouse back and forward buttons', () => {
  it('sends button 3 back and button 4 forward, not the other way round', () => {
    press(3);
    expect(back).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();

    press(4);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('leaves the ordinary buttons alone', () => {
    for (const button of [0, 1, 2]) press(button);
    expect(back).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it('claims the event so nothing underneath also acts on it', () => {
    // A side button pressed over a row must navigate without also opening that
    // row — the press is consumed, not merely observed.
    expect(press(3).defaultPrevented).toBe(true);
    expect(press(0).defaultPrevented).toBe(false);
  });

  it('stops listening once torn down', () => {
    teardown();
    press(3);
    expect(back).not.toHaveBeenCalled();
  });
});
