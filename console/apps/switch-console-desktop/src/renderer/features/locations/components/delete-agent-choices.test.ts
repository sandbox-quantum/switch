import { expect, it } from 'vitest';
import { removesProvisionedFiles } from './delete-agent-choices';

// Console provisioned these files on this machine and nothing else reads them,
// so removing the agent and leaving its credentials behind is not offered.
it('always removes the files of an agent on this machine', () => {
  for (const chosen of [false, true]) {
    for (const deleteInSwitch of [false, true]) {
      expect(removesProvisionedFiles({ sshHost: null, dir: '/work', chosen, deleteInSwitch })).toBe(
        true
      );
    }
  }
});

it('leaves the choice to the operator on a shared host', () => {
  expect(
    removesProvisionedFiles({
      sshHost: 'builder',
      dir: '/work',
      chosen: false,
      deleteInSwitch: false,
    })
  ).toBe(false);
  expect(
    removesProvisionedFiles({
      sshHost: 'builder',
      dir: '/work',
      chosen: true,
      deleteInSwitch: false,
    })
  ).toBe(true);
});

it('removes a remote agent from its host when it is deleted in Switch', () => {
  // A deleted identity has nothing left to run there (CHOO-2893).
  expect(
    removesProvisionedFiles({
      sshHost: 'builder',
      dir: '/work',
      chosen: false,
      deleteInSwitch: true,
    })
  ).toBe(true);
});

it('removes nothing when no working directory is known', () => {
  expect(
    removesProvisionedFiles({ sshHost: null, dir: null, chosen: true, deleteInSwitch: true })
  ).toBe(false);
  expect(
    removesProvisionedFiles({ sshHost: 'builder', dir: null, chosen: true, deleteInSwitch: true })
  ).toBe(false);
});
