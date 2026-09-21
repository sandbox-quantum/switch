import { expect, it } from 'vitest';
import { removesProvisionedFiles } from './delete-agent-choices';

// Console provisioned these files on this machine and nothing else reads them,
// so removing the agent and leaving its credentials behind is not offered.
it('always removes the files of an agent on this machine', () => {
  expect(removesProvisionedFiles({ sshHost: null, dir: '/work', chosen: false })).toBe(true);
  expect(removesProvisionedFiles({ sshHost: null, dir: '/work', chosen: true })).toBe(true);
});

it('leaves the choice to the operator on a shared host', () => {
  expect(removesProvisionedFiles({ sshHost: 'builder', dir: '/work', chosen: false })).toBe(false);
  expect(removesProvisionedFiles({ sshHost: 'builder', dir: '/work', chosen: true })).toBe(true);
});

it('removes nothing when no working directory is known', () => {
  expect(removesProvisionedFiles({ sshHost: null, dir: null, chosen: true })).toBe(false);
  expect(removesProvisionedFiles({ sshHost: 'builder', dir: null, chosen: true })).toBe(false);
});
