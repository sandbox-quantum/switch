import { beforeEach, describe, expect, it, vi } from 'vitest';
import { menuSelectAllChannel } from '@shared/events/appEvents';

const mocks = vi.hoisted(() => ({
  getFocusedWebContents: vi.fn(),
  getMainWindow: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('electron', () => ({
  webContents: { getFocusedWebContents: mocks.getFocusedWebContents },
}));
vi.mock('@main/app/window', () => ({ getMainWindow: mocks.getMainWindow }));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));

const { selectAll } = await import('./select-all');

function fakeContents(destroyed = false) {
  return { selectAll: vi.fn(), isDestroyed: () => destroyed };
}

function fakeWindow(destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: fakeContents(destroyed) };
}

describe('Edit > Select All routing (CHOO-4120)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards to the renderer when the main window is focused', () => {
    const win = fakeWindow();
    mocks.getMainWindow.mockReturnValue(win);
    mocks.getFocusedWebContents.mockReturnValue(win.webContents);
    selectAll();
    expect(mocks.emit).toHaveBeenCalledWith(menuSelectAllChannel, undefined);
    expect(win.webContents.selectAll).not.toHaveBeenCalled();
  });

  it('forwards to the renderer when nothing is focused', () => {
    mocks.getMainWindow.mockReturnValue(fakeWindow());
    mocks.getFocusedWebContents.mockReturnValue(null);
    selectAll();
    expect(mocks.emit).toHaveBeenCalledWith(menuSelectAllChannel, undefined);
  });

  it('lets other web contents (DevTools, the room webview) select all natively', () => {
    const win = fakeWindow();
    const other = fakeContents();
    mocks.getMainWindow.mockReturnValue(win);
    mocks.getFocusedWebContents.mockReturnValue(other);
    selectAll();
    expect(other.selectAll).toHaveBeenCalledOnce();
    expect(win.webContents.selectAll).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('does nothing when the main window is destroyed', () => {
    const win = fakeWindow(true);
    mocks.getMainWindow.mockReturnValue(win);
    mocks.getFocusedWebContents.mockReturnValue(null);
    selectAll();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(win.webContents.selectAll).not.toHaveBeenCalled();
  });

  it('does nothing when there is no main window and nothing focused', () => {
    mocks.getMainWindow.mockReturnValue(null);
    mocks.getFocusedWebContents.mockReturnValue(null);
    selectAll();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
