import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GIT_EXECUTABLE } from '@main/core/utils/exec';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

const { LocalExecutionContext } = await import('./local-execution-context');

class FakeChildProcess extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });

  kill = vi.fn();
}

describe('LocalExecutionContext', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    spawnMock.mockReset();
  });

  it('resolves logical git command for buffered local execution', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
    });
    const ctx = new LocalExecutionContext({ root: '/repo' });

    await ctx.exec('git', ['status']);

    expect(execFileMock).toHaveBeenCalledWith(
      GIT_EXECUTABLE,
      ['status'],
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({
          GIT_ASKPASS: '',
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          SSH_ASKPASS: '',
        }),
      }),
      expect.any(Function)
    );
  });

  it('explains when git is missing during buffered local execution', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(
        Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', path: GIT_EXECUTABLE })
      );
    });
    const ctx = new LocalExecutionContext({ root: '/repo' });

    await expect(ctx.exec('git', ['status'])).rejects.toThrow(
      'Git is not installed or Switch Console cannot find it'
    );
  });

  it('resolves logical git command for streaming local execution', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const ctx = new LocalExecutionContext({ root: '/repo' });

    const promise = ctx.execStreaming('git', ['status'], () => true);
    child.emit('close', 0);
    await promise;

    expect(spawnMock).toHaveBeenCalledWith(
      GIT_EXECUTABLE,
      ['status'],
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({
          GIT_ASKPASS: '',
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          SSH_ASKPASS: '',
        }),
      })
    );
  });

  it('routes a Windows .cmd shim through cmd.exe instead of failing with EINVAL', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: '', stderr: '' });
    });

    try {
      await new LocalExecutionContext().exec('D:\\tools\\npm.cmd', ['root', '-g']);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }

    expect(execFileMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'D:\\tools\\npm.cmd root -g'],
      expect.objectContaining({ windowsVerbatimArguments: true }),
      expect.any(Function)
    );
  });

  it('explains when git is missing during streaming local execution', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const ctx = new LocalExecutionContext({ root: '/repo' });

    const promise = ctx.execStreaming('git', ['status'], () => true);
    child.emit(
      'error',
      Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', path: GIT_EXECUTABLE })
    );

    await expect(promise).rejects.toThrow('Git is not installed or Switch Console cannot find it');
  });
});
