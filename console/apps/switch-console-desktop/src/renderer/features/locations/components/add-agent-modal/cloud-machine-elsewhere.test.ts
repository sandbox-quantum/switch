import { describe, expect, it } from 'vitest';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';
import { cloudMachineElsewhere } from './cloud-machine-elsewhere';

/** As the main process raises it, carried across IPC as the renderer receives it. */
function refusal(workspaceName: string | null): RpcError {
  const error = Object.assign(new Error('Your cloud box already serves another workspace.'), {
    name: 'CloudMachineInOtherWorkspaceError',
    workspaceName,
  });
  return new RpcError(serializeRpcError(error));
}

describe('cloudMachineElsewhere', () => {
  it('names the workspace the box is set up in, when the server sent it', () => {
    expect(cloudMachineElsewhere(refusal('Research'))).toEqual({
      line: 'Your cloud box is set up in Research. For now, each person’s cloud box works in one workspace.',
      helper: 'To add an agent here, choose This computer or another machine.',
    });
  });

  it('says "another workspace" when the server sent no name', () => {
    for (const name of [null, '', '   ']) {
      expect(cloudMachineElsewhere(refusal(name))?.line).toBe(
        'Your cloud box is set up in another workspace. For now, each person’s cloud box works in one workspace.'
      );
    }
  });

  it('never shows the server’s own wording, an id or a code', () => {
    const notice = cloudMachineElsewhere(refusal('Research'));
    const text = `${notice?.line} ${notice?.helper}`;
    expect(text).not.toContain('already serves');
    expect(text).not.toContain('box_one_workspace');
  });

  it('is not this notice for any other failure', () => {
    expect(cloudMachineElsewhere(new Error('nope'))).toBeNull();
    expect(cloudMachineElsewhere(null)).toBeNull();
    expect(
      cloudMachineElsewhere(new RpcError(serializeRpcError(new Error('None free.'))))
    ).toBeNull();
    const gateway = Object.assign(new Error('Conflict'), {
      name: 'GatewayError',
      code: 'box_one_workspace',
    });
    expect(cloudMachineElsewhere(new RpcError(serializeRpcError(gateway)))).toBeNull();
  });
});
