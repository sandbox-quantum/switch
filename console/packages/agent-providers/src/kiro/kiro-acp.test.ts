import { describe, expect, it } from 'vitest';
import { kiroAcp } from './kiro-acp';

describe('Kiro CLI ACP hooks', () => {
  it('runs kiro-cli acp', async () => {
    const launch = await kiroAcp.launch({ binaryPath: 'kiro-cli', cwd: '.', env: {} });
    expect(launch.args).toEqual(['acp']);
    expect(kiroAcp.loginCommand).toBe('kiro-cli login');
  });

  it('asks for a trust-all mode on full access only where Kiro advertises one', () => {
    const modes = { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'trust-all-tools' }] };
    expect(kiroAcp.sessionMode!('full-access', modes as never)).toBe('trust-all-tools');
    expect(kiroAcp.sessionMode!('full-access', undefined)).toBeUndefined();
    expect(kiroAcp.sessionMode!('approval-required', modes as never)).toBeUndefined();
  });

  it('names MCP servers from their tools', () => {
    expect(kiroAcp.mcpServerOf!({ title: 'mcp__echo__say' } as never)).toBe('echo');
  });
});
