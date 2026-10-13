import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isStopMessage,
  onStopRequest,
  requestChildStop,
  requestStop,
  STOP_MESSAGE,
  stopFile,
} from './stop-request';

const platform = process.platform;
function pretend(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stop-request-'));
});
afterEach(async () => {
  pretend(platform);
  await rm(root, { recursive: true, force: true });
});

function fakeChild(connected: boolean) {
  return { connected, pid: 4242, send: vi.fn(() => true), kill: vi.fn(() => true) };
}

describe('requestChildStop', () => {
  it('sends SIGTERM on macOS and Linux', async () => {
    pretend('linux');
    const child = fakeChild(true);
    await requestChildStop(child, root);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.send).not.toHaveBeenCalled();
  });

  it('sends the stop message over IPC on Windows', async () => {
    pretend('win32');
    const child = fakeChild(true);
    await requestChildStop(child, root);
    expect(child.send).toHaveBeenCalledWith(STOP_MESSAGE);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('writes the stop file for a child with no IPC channel on Windows', async () => {
    pretend('win32');
    const child = fakeChild(false);
    await requestChildStop(child, root);
    expect(child.kill).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['.stop-4242']);
  });
});

describe('onStopRequest', () => {
  it('stops once on the stop message', () => {
    const stop = vi.fn();
    const dispose = onStopRequest(stop, null);
    try {
      process.emit('message', { kind: 'other' }, undefined);
      expect(stop).not.toHaveBeenCalled();
      process.emit('message', STOP_MESSAGE, undefined);
      process.emit('message', STOP_MESSAGE, undefined);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it('stops when its stop file is written on Windows', async () => {
    pretend('win32');
    const stop = vi.fn();
    const dispose = onStopRequest(stop, root);
    try {
      await requestStop(root, process.pid);
      for (let waited = 0; waited < 3000 && !stop.mock.calls.length; waited += 50) await delay(50);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(await readdir(root)).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('ignores a stop file left for an earlier process with the same id', async () => {
    pretend('win32');
    await writeFile(stopFile(root, process.pid), JSON.stringify({ pid: process.pid, at: 1 }));
    const stop = vi.fn();
    const dispose = onStopRequest(stop, root);
    try {
      await delay(600);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});

it('tells the stop message apart from session traffic', () => {
  expect(isStopMessage(STOP_MESSAGE)).toBe(true);
  expect(isStopMessage({ kind: 'answer', id: 1 })).toBe(false);
  expect(isStopMessage(null)).toBe(false);
});
