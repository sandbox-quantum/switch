import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { fenceDeadOwner } from './process-fence';

function terminateGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

it.skipIf(process.platform === 'win32')(
  'fences provider children after a real host process crash',
  async () => {
    const owner = spawn(
      process.execPath,
      [
        '-e',
        `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const pid = owner.pid!;
    let fenced = false;
    try {
      await once(owner.stdout!, 'data');
      await expect(fenceDeadOwner(pid, pid)).rejects.toThrow('still alive');
      const exited = once(owner, 'exit');
      owner.kill('SIGKILL');
      await exited;
      await fenceDeadOwner(pid, pid);
      fenced = true;
      expect(() => process.kill(-pid, 0)).toThrow();
    } finally {
      if (!fenced) terminateGroup(pid);
    }
  }
);

it.skipIf(process.platform === 'win32')(
  'accepts a group exiting between the liveness check and fencing',
  async () => {
    const gone = Object.assign(new Error('Process exited'), { code: 'ESRCH' });
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw gone;
      })
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw gone;
      });
    try {
      await expect(fenceDeadOwner(12345, 12345)).resolves.toBeUndefined();
      expect(kill).toHaveBeenLastCalledWith(-12345, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  }
);

it('waits for confirmed exit after a transient permission error during group teardown', async () => {
  const gone = Object.assign(new Error('Process exited'), { code: 'ESRCH' });
  const denied = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  const kill = vi
    .spyOn(process, 'kill')
    .mockImplementationOnce(() => {
      throw gone;
    })
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockImplementationOnce(() => {
      throw denied;
    })
    .mockImplementationOnce(() => {
      throw gone;
    });
  try {
    await expect(fenceDeadOwner(12345, 12345)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledTimes(5);
  } finally {
    kill.mockRestore();
  }
});

it('does not assume a group is gone when permission stays denied', async () => {
  const gone = Object.assign(new Error('Process exited'), { code: 'ESRCH' });
  const denied = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  const kill = vi
    .spyOn(process, 'kill')
    .mockImplementationOnce(() => {
      throw gone;
    })
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockImplementation(() => {
      throw denied;
    });
  try {
    const result = expect(fenceDeadOwner(12345, 12345)).rejects.toThrow('has not exited');
    await result;
  } finally {
    kill.mockRestore();
  }
}, 10000);
