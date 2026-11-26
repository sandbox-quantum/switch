import { describe, expect, it, vi } from 'vitest';
import { createTemplatesClient, type TemplateRunAgent } from './templates-client';

describe('createTemplatesClient', () => {
  const mockCall = vi.fn<
    (path: string, request: { method?: string; body?: unknown }) => Promise<Response>
  >();

  const client = createTemplatesClient({ call: mockCall });

  it('runTemplateWithAgents calls server and maps response', async () => {
    const agent: TemplateRunAgent = {
      slot: 'coder',
      name: 'test-agent',
      description: 'Test agent',
      displayName: 'Test',
      instructions: null,
      provider: 'claude',
      machine: 'local',
      model: 'sonnet',
      advancedConfig: null,
      isolation: null,
      autoMode: false,
      autoApprove: [],
      directory: null,
      addressing: null,
      connections: [],
    };

    mockCall.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created_agents: [
            {
              slot: 'coder',
              agent_id: 'a1',
              name: 'test-agent',
              machine: { id: 'm1', name: 'Local' },
              listening: true,
            },
          ],
          room: { id: 'r1', name: 'Test Room', description: null, created: '2024-01-01' },
        }),
        { status: 201 }
      )
    );

    const result = await client.runTemplateWithAgents({
      agents: [agent],
      yamlText: 'name: test',
      inputs: {},
      templateName: 'Test Template',
    });

    expect(result).toEqual({
      kind: 'created',
      createdAgents: [
        {
          slot: 'coder',
          agentId: 'a1',
          name: 'test-agent',
          machine: { id: 'm1', name: 'Local' },
          listening: true,
        },
      ],
      room: { id: 'r1', name: 'Test Room', description: null, created: '2024-01-01' },
    });
  });

  it('runTemplateDocument calls server and maps response', async () => {
    mockCall.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created_agents: [],
          room: null,
        }),
        { status: 201 }
      )
    );

    const result = await client.runTemplateDocument({
      template: 'name: test',
      inputs: { foo: 'bar' },
      filled: {},
      templateName: 'Test',
      templateId: 't1',
    });

    expect(result).toEqual({
      kind: 'created',
      createdAgents: [],
      room: null,
    });
  });

  it('handles 409 refusal response', async () => {
    mockCall.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'agents_not_created',
          detail: 'Machine unavailable',
          problems: [{ slot: 'coder', code: 'machine_busy', message: 'Machine is busy' }],
        }),
        { status: 409 }
      )
    );

    const result = await client.runTemplateWithAgents({
      agents: [],
      yamlText: null,
      inputs: {},
      templateName: 'Test',
    });

    expect(result).toEqual({
      kind: 'refused',
      code: 'agents_not_created',
      message: 'Machine unavailable',
      problems: [{ slot: 'coder', code: 'machine_busy', message: 'Machine is busy' }],
      leftBehind: [],
    });
  });
});
