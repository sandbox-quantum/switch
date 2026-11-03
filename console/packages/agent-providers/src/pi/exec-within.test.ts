import { afterEach, describe, expect, it, vi } from 'vitest';

const execProvider = vi.hoisted(() => vi.fn());
vi.mock('../provider-process', () => ({ execProvider }));

const { execWithin, OUT_OF_TIME } = await import('./exec-within');

afterEach(() => {
  execProvider.mockReset();
});

describe('execWithin', () => {
  it('answers out of time and runs nothing when its budget is already spent', async () => {
    const budget = new AbortController();
    budget.abort();

    await expect(
      execWithin('pi', ['--version'], { timeout: 1000, budget: budget.signal })
    ).resolves.toBe(OUT_OF_TIME);
    expect(execProvider).not.toHaveBeenCalled();
  });

  it('runs the command when its budget is not spent', async () => {
    execProvider.mockResolvedValue({ stdout: '1.4.0\n', stderr: '' });
    const budget = new AbortController();

    await expect(
      execWithin('pi', ['--version'], { timeout: 1000, budget: budget.signal })
    ).resolves.toEqual({ stdout: '1.4.0\n', stderr: '' });
    expect(execProvider).toHaveBeenCalledOnce();
    expect(execProvider).toHaveBeenCalledWith('pi', ['--version'], {
      timeout: 1000,
      killSignal: 'SIGKILL',
    });
  });
});
