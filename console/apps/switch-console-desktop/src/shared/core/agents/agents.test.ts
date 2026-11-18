import { expect, it } from 'vitest';
import { providerSupportsAutoMode } from '../providers/agent-provider-registry';
import { newAgentPermissions } from './agents';

it('uses bypass for new Cursor agents because ACP has no Auto mode', () => {
  expect(providerSupportsAutoMode('cursor')).toBe(false);
  expect(newAgentPermissions('cursor')).toEqual({ autoMode: false, autoApprove: true });
  expect(newAgentPermissions('claude')).toEqual({ autoMode: true, autoApprove: false });
  expect(() => newAgentPermissions('unknown-provider')).toThrow('unknown agent provider');
});
