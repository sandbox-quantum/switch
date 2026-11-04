import { describe, expect, it } from 'vitest';
import { kiroAcp, kiroItemType, kiroMcpServerOf, parseKiroWhoami } from './kiro-acp';

describe('parseKiroWhoami', () => {
  it('reads a signed-out JSON answer as unauthenticated', () => {
    const result = parseKiroWhoami('{"account":null}');
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('kiro-cli login');
  });

  it('reads a JSON account as authenticated', () => {
    const result = parseKiroWhoami('{"account":{"email":"dev@example.com","type":"social"}}');
    expect(result.status).toBe('authenticated');
  });

  it('reads the real signed-in JSON shape (email, no account key) as authenticated', () => {
    // The exact shape kiro-cli 3.0.0 prints when signed in via Builder ID.
    const result = parseKiroWhoami(
      '{"accountType":"BuilderId","startUrl":null,"region":"us-east-1","email":"dev@example.com"}'
    );
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('dev@example.com');
  });

  it('reads the plain Builder ID answer as authenticated', () => {
    const result = parseKiroWhoami('Logged in with Builder ID\n\nProfile:\n\nbuilder-user\n');
    expect(result.status).toBe('authenticated');
  });

  it('names the account when the plain answer carries an email', () => {
    const result = parseKiroWhoami('Logged in with Social\nEmail: dev@example.com\n');
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('dev@example.com');
  });

  it('reads a plain signed-out answer as unauthenticated', () => {
    const result = parseKiroWhoami('Error: Not logged in. Run kiro-cli login to sign in.');
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('kiro-cli login');
  });

  it('reports unknown for an answer in neither shape', () => {
    expect(parseKiroWhoami('kiro-cli 2.15.1').status).toBe('unknown');
    expect(parseKiroWhoami('').status).toBe('unknown');
  });
});

describe('kiroMcpServerOf', () => {
  it('reads the server from a permission request meta (real CLI 3.0.0 shape)', () => {
    const server = kiroMcpServerOf({
      toolCallId: 'tooluse_1',
      title: '@echo/switch_echo',
      _meta: { kiro: { mcpTool: { identity: { serverName: 'echo', toolName: 'switch_echo' } } } },
    });
    expect(server).toBe('echo');
  });

  it('reads the server from a tool call update meta', () => {
    const server = kiroMcpServerOf({
      toolCallId: 'tooluse_2',
      title: '@echo/switch_echo',
      _meta: { kiro: { serverName: 'echo', toolOrigin: 'default' } },
    });
    expect(server).toBe('echo');
  });

  it('falls back to the namespaced tool_id, then the @server title', () => {
    expect(
      kiroMcpServerOf({ toolCallId: 'tooluse_3', rawInput: { tool_id: 'echo::switch_echo' } })
    ).toBe('echo');
    expect(kiroMcpServerOf({ toolCallId: 'tooluse_4', title: '@echo/switch_echo' })).toBe('echo');
  });

  it('returns undefined for a built-in tool call', () => {
    expect(
      kiroMcpServerOf({
        toolCallId: 'tooluse_5',
        title: 'Run command',
        rawInput: { tool_id: 'shell' },
      })
    ).toBeUndefined();
  });
});

describe('kiroItemType', () => {
  it('maps the delegation call to the subagent item type (real CLI 3.0.0 shape)', () => {
    expect(
      kiroItemType({
        toolCallId: 'invoke_subagent_tooluse_abc',
        title: 'Sub-agent: general-task-execution',
        rawInput: {
          name: 'general-task-execution',
          prompt: 'Read README.md.',
          explanation: 'Delegating.',
        },
        _meta: { kiro: { kind: 'agent-subtask', agentSubtaskId: 'subtask-1' } },
      })
    ).toBe('subagent');
  });

  it('maps delegation tools named in tool_id or the title', () => {
    expect(
      kiroItemType({ toolCallId: 'tooluse_6', rawInput: { tool_id: 'agents::subagent' } })
    ).toBe('subagent');
    expect(kiroItemType({ toolCallId: 'tooluse_7', rawInput: { _toolName: 'task' } })).toBe(
      'subagent'
    );
    expect(kiroItemType({ toolCallId: 'tooluse_8', title: 'Subagent: read README.md' })).toBe(
      'subagent'
    );
  });

  it('leaves the subagent\u2019s own tool calls untyped', () => {
    expect(
      kiroItemType({
        toolCallId: 'tooluse_11',
        title: 'Read File',
        _meta: { kiro: { agentSubtaskId: 'subtask-1', toolOrigin: 'default' } },
      })
    ).toBeUndefined();
  });

  it('leaves ordinary tool calls untyped', () => {
    expect(
      kiroItemType({
        toolCallId: 'tooluse_9',
        title: 'Run command',
        rawInput: { tool_id: 'shell' },
      })
    ).toBeUndefined();
  });
});

describe('kiroAcp', () => {
  it('launches the CLI as an ACP agent with no harness pin', async () => {
    const launch = await kiroAcp.launch({ binaryPath: '/bin/kiro-cli', cwd: '/work', env: {} });
    expect(launch.command).toBe('/bin/kiro-cli');
    expect(launch.args).toEqual(['acp']);
  });

  it('names the CLI sign-in command the core provider table mirrors', () => {
    expect(kiroAcp.loginCommand).toBe('kiro-cli login');
    expect(kiroAcp.defaultBinary).toBe('kiro-cli');
  });

  it('declares the capabilities Kiro advertises at the handshake', () => {
    expect(kiroAcp.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
    expect(kiroAcp.promptCapabilities).toEqual({ image: true });
  });
});
