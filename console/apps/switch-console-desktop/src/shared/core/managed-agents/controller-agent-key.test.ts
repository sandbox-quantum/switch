import { describe, expect, it } from 'vitest';
import { cloudAgentKey, parseCloudAgentKey } from '@shared/core/cloud-agents/cloud-agents';
import { controllerAgentKey, parseControllerAgentKey } from './controller-agent-key';

describe('controller agent keys', () => {
  it('round-trips and is never read as a cloud agent', () => {
    const key = controllerAgentKey('server:1', 'agent-1');
    expect(parseControllerAgentKey(key)).toEqual({ serverId: 'server:1', agentId: 'agent-1' });
    expect(parseCloudAgentKey(key)).toBeNull();
    expect(parseControllerAgentKey(cloudAgentKey('server-1', 'agent-1'))).toBeNull();
  });

  it('refuses keys without an agent', () => {
    expect(parseControllerAgentKey('controller:server-1:agent=')).toBeNull();
    expect(parseControllerAgentKey('controller::agent=a')).toBeNull();
  });
});
