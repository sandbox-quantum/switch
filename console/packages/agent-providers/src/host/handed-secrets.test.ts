import { describe, expect, it } from 'vitest';
import { handedSecrets, MIN_SECRET } from './handed-secrets';
import { Redactions } from './redaction';
import { toolDetailPreview } from './tool-detail-preview';

// Secret-shaped values are assembled at runtime, so no scanner reads the
// source as holding a real one.
const value = (name: string) => [name, 'value', '0123456789'].join('-');
const SESSION_MCP = value('session-mcp-bearer');
const VENDOR_KEY = value('vendor-api-key');
const STDIO_TOKEN = value('stdio-token');
const FORWARDED = value('forwarded-password');
const AGENT_SECRET = value('agent-client-secret');

const started = {
  env: { HOME: '/home/agent', OPENAI_API_KEY: AGENT_SECRET, PORT_TOKEN: '1234' },
  mcpServers: {
    switch: {
      transport: 'http' as const,
      url: 'http://127.0.0.1:4100/mcp',
      headers: { Authorization: `Bearer ${SESSION_MCP}`, Accept: 'application/json' },
    },
    vendor: {
      transport: 'http' as const,
      url: 'https://mcp.example.test',
      headers: { 'X-Api-Key': VENDOR_KEY },
    },
    tool: {
      transport: 'stdio' as const,
      command: 'tool-server',
      args: ['--verbose'],
      env: { TOOL_TOKEN: STDIO_TOKEN, TOOL_MODE: 'quiet-and-long-enough' },
      envVars: ['DB_PASSWORD', 'LANG'],
    },
  },
};
const hostEnv = { DB_PASSWORD: FORWARDED, LANG: 'en_US.UTF-8-long-enough' };

describe('the secrets a host hands the agent and its MCP servers', () => {
  it('takes every credential-named header, environment value and forwarded variable', () => {
    expect(new Set(handedSecrets(started, hostEnv))).toEqual(
      new Set([
        AGENT_SECRET,
        `Bearer ${SESSION_MCP}`,
        SESSION_MCP,
        VENDOR_KEY,
        STDIO_TOKEN,
        FORWARDED,
      ])
    );
  });

  it('leaves out what is not named as a credential, and values too short to be one', () => {
    const secrets = handedSecrets(started, hostEnv);
    expect(secrets).not.toContain('/home/agent');
    expect(secrets).not.toContain('quiet-and-long-enough');
    expect(secrets).not.toContain('en_US.UTF-8-long-enough');
    expect(secrets).not.toContain('application/json');
    expect('1234'.length).toBeLessThan(MIN_SECRET);
    expect(secrets).not.toContain('1234');
  });

  it("is masked in a tool call's preview once it is on the session's list", () => {
    const redactions = new Redactions();
    for (const secret of handedSecrets(started, hostEnv)) redactions.add(secret);
    const preview = toolDetailPreview(
      {
        input: { command: 'env' },
        head: `OPENAI_KEY_COPY=${AGENT_SECRET}\nheader ${SESSION_MCP}\nmcp ${VENDOR_KEY} ${STDIO_TOKEN}\ndb ${FORWARDED}`,
        tail: '',
        outputClipped: false,
        hasOutput: true,
        exitCode: null,
      },
      redactions
    )!;
    for (const secret of [AGENT_SECRET, SESSION_MCP, VENDOR_KEY, STDIO_TOKEN, FORWARDED])
      expect(preview).not.toContain(secret);
  });
});
