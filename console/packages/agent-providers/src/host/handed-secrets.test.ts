import { describe, expect, it } from 'vitest';
import { handedSecrets } from './handed-secrets';
import { Redactions } from './redaction';
import { toolDetailText } from './tool-detail-text';

describe('the secrets a host hands a session', () => {
  const input = {
    env: {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'placeholder-env-token',
      DB_PASSWORD: 'placeholder-db-pass',
      SHORT_TOKEN: 'abc',
      MAX_TOKENS: '4096',
    },
    mcpServers: {
      switch: {
        transport: 'http' as const,
        url: 'https://switch.example/mcp',
        headers: { Authorization: 'Bearer placeholder-mcp-bearer', 'X-Trace': 'trace-1234567' },
      },
      local: {
        transport: 'stdio' as const,
        command: 'server',
        args: [],
        env: { SERVICE_API_KEY: 'placeholder-stdio-key' },
      },
    },
  };

  it('are the secret-named variables and the credentials in authentication headers', () => {
    expect(handedSecrets(input).sort()).toEqual(
      [
        'Bearer placeholder-mcp-bearer',
        'placeholder-db-pass',
        'placeholder-env-token',
        'placeholder-mcp-bearer',
        'placeholder-stdio-key',
      ].sort()
    );
  });

  it('are masked in what a room is shown of a tool call', () => {
    const redactions = new Redactions();
    for (const secret of handedSecrets(input)) redactions.add(secret);
    const text = toolDetailText(
      {
        itemId: 'call',
        type: 'command_execution',
        toolName: 'Bash',
        input: { command: 'env' },
        output:
          'deploy placeholder-env-token\nconnect placeholder-stdio-key\nsend placeholder-mcp-bearer',
        truncated: false,
        exitCode: 0,
      },
      redactions
    );
    for (const secret of handedSecrets(input)) expect(text).not.toContain(secret);
  });
});
