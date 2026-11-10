import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';

vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('./give-machine-login', () => ({ GiveMachineLogin: () => null }));
vi.mock('@shared/core/providers/agent-provider-registry', () => ({
  agentProviders: () => [
    { id: 'deepseek-harness', name: 'DeepSeek Harness' },
    { id: 'codex', name: 'Codex' },
    { id: 'claude', name: 'Claude' },
    { id: 'cursor', name: 'Cursor' },
    { id: 'opencode', name: 'OpenCode' },
  ],
}));

const { MachineProviderPicker, machineProviderOptions } = await import('./machine-provider-picker');

const machine: OwnedMachine = {
  id: 'demo',
  name: 'Hermes',
  kind: 'daemon',
  state: 'online',
  acceptsLogins: false,
  cloud: false,
  local: null,
  os: null,
  workspacesDir: null,
  providers: [
    {
      provider: 'deepseek-harness',
      ready: false,
      canAttempt: true,
      problem: 'login could not be checked',
      detail: 'Configure and select an OpenRouter model.',
      loginHelps: true,
    },
    { provider: 'codex', ready: false, problem: 'not logged in', detail: null, loginHelps: true },
    { provider: 'claude', ready: false, problem: 'login expired', detail: null, loginHelps: true },
    { provider: 'cursor', ready: false, problem: 'not installed', detail: null, loginHelps: true },
  ],
};

function render(value: 'deepseek-harness' | null) {
  return renderToStaticMarkup(
    React.createElement(MachineProviderPicker, {
      serverId: 'server',
      machine,
      value,
      onChange: () => {},
      defaultAgent: undefined,
    })
  );
}

describe('MachineProviderPicker with an unverified login', () => {
  it('offers the unverified installed provider explicitly while retaining its warning', () => {
    const html = render('deepseek-harness');
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const button = (name: string) => buttons.find((entry) => entry.includes(`>${name}</span>`));
    expect(button('DeepSeek Harness')).toContain('aria-pressed="true"');
    expect(button('DeepSeek Harness')).not.toContain('disabled=""');
    expect(button('DeepSeek Harness')).toContain('Login could not be checked');
    for (const name of ['Codex', 'Claude', 'Cursor', 'OpenCode'])
      expect(button(name)).toContain('disabled=""');
    expect(html).toContain('Sign-in could not be verified.');
    expect(html).toContain('Configure and select an OpenRouter model.');
  });

  it('does not mark an unverified provider ready for automatic selection', () => {
    expect(
      machineProviderOptions(machine).find((option) => option.id === 'deepseek-harness')?.ready
    ).toBe(false);
    expect(render(null)).toContain('No provider is confirmed signed in');
  });
});
