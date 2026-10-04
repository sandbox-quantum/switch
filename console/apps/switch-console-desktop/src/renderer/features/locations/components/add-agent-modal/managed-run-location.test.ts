import { describe, expect, it } from 'vitest';
import { machineDisabledReason, newAgentMachineNotice } from './managed-run-location';

const THIS_COMPUTER = { label: 'This computer', sshHost: null };

describe('newAgentMachineNotice', () => {
  it('says Console runs the agent on a server without agent management', () => {
    expect(newAgentMachineNotice({ management: false }, THIS_COMPUTER)).toEqual({
      kind: 'console',
      text: 'This server does not have agent management turned on, so this Console runs the agent.',
    });
  });

  it('names the machine a managed agent runs on', () => {
    const notice = newAgentMachineNotice(
      {
        management: true,
        target: { kind: 'this-computer', serverId: 's', machineName: 'laptop' },
        blocker: null,
        canEnable: false,
      },
      THIS_COMPUTER
    );
    expect(notice.kind).toBe('managed');
    expect(notice.text).toMatch(/^Runs as a managed agent on This computer \(machine “laptop”\)/);
  });

  it('offers to turn this computer on when Console can', () => {
    expect(
      newAgentMachineNotice(
        { management: true, target: null, blocker: 'Turn it on first.', canEnable: true },
        THIS_COMPUTER
      )
    ).toEqual({
      kind: 'blocked',
      text: 'Turn it on first.',
      enable: { label: 'Run managed agents on this computer' },
    });
  });

  it('offers to make an SSH host a machine, by its name', () => {
    const notice = newAgentMachineNotice(
      { management: true, target: null, blocker: 'Make it a machine.', canEnable: true },
      { label: 'build box', sshHost: 'box' }
    );
    expect(notice).toMatchObject({
      kind: 'blocked',
      enable: { label: 'Make build box a machine' },
    });
  });

  it('offers nothing to press when Console cannot fix it', () => {
    const notice = newAgentMachineNotice(
      {
        management: true,
        target: null,
        blocker: 'The controller is not running.',
        canEnable: false,
      },
      THIS_COMPUTER
    );
    expect(notice).toEqual({
      kind: 'blocked',
      text: 'The controller is not running.',
      enable: null,
    });
  });
});

describe('machineDisabledReason', () => {
  it('waits while the server is being asked', () => {
    expect(machineDisabledReason({ checking: true, error: null, machine: undefined })).toMatch(
      /^Checking/
    );
  });

  it('refuses rather than guessing when the server could not be asked', () => {
    expect(
      machineDisabledReason({ checking: false, error: new Error('offline'), machine: undefined })
    ).toBe('Console could not ask the server whether it runs managed agents. (offline)');
  });

  it('gives the machine’s blocker', () => {
    expect(
      machineDisabledReason({
        checking: false,
        error: null,
        machine: { management: true, target: null, blocker: 'Not running.', canEnable: false },
      })
    ).toBe('Not running.');
  });

  it('is not the reason when the agent can be created', () => {
    expect(
      machineDisabledReason({ checking: false, error: null, machine: { management: false } })
    ).toBeNull();
  });
});
