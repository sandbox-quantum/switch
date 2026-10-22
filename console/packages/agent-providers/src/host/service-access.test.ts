import { describe, expect, it, vi } from 'vitest';
import {
  grantedSkills,
  issueServiceToken,
  readServiceGrants,
  type ServiceGrant,
  skillContext,
} from './service-access';

describe("a token's expiry", () => {
  const issue = (dateHeader: string | null) => {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (dateHeader) headers.set('date', dateHeader);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ token: 'synthetic-service-token', expires_at: '2026-10-08T13:00:00Z' }),
          { status: 200, headers }
        )
    ) as unknown as typeof fetch;
    return issueServiceToken(
      { endpoint: 'https://switch.example.test/api', token: 'agent-key', agentId: 'agent' },
      'github',
      fetchImpl
    );
  };

  it("is read on this machine's clock, however far it is from Switch's", async () => {
    // This machine runs an hour fast: Switch says 12:00, it thinks 13:00.
    vi.useFakeTimers({ now: Date.parse('2026-10-08T13:00:00Z'), toFake: ['Date'] });
    try {
      const issued = await issue('Thu, 08 Oct 2026 12:00:00 GMT');
      expect(issued).toMatchObject({ expiresAt: Date.parse('2026-10-08T13:59:59Z') });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is taken as given when Switch's answer carries no date", async () => {
    const issued = await issue(null);
    expect(issued).toMatchObject({
      expiresAt: Date.parse('2026-10-08T13:00:00Z'),
      useUntil: Date.parse('2026-10-08T13:00:00Z'),
    });
  });

  const answered = (body: object) =>
    issueServiceToken(
      { endpoint: 'https://switch.example.test/api', token: 'agent-key', agentId: 'agent' },
      'example',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
    );

  it('is timed from the answer by Switch’s count, and used until Switch says', async () => {
    // This machine's clock is a day off Switch's, which no longer matters.
    vi.useFakeTimers({ now: Date.parse('2026-10-09T12:00:00Z'), toFake: ['Date'] });
    try {
      const issued = await answered({
        token: 'synthetic-owner-token',
        expires_at: '2026-10-08T16:00:00Z',
        expires_in: 4 * 3600,
        use_until: '2026-10-08T13:00:00Z',
      });
      expect(issued).toMatchObject({
        expiresAt: Date.parse('2026-10-09T15:59:59Z'),
        useUntil: Date.parse('2026-10-09T12:59:59Z'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a use_until after the token expires', async () => {
    await expect(
      answered({
        token: 'synthetic-owner-token',
        expires_at: '2026-10-08T13:00:00Z',
        expires_in: 3600,
        use_until: '2026-10-08T14:00:00Z',
      })
    ).rejects.toThrow('not one');
  });
});

const SWITCH = {
  endpoint: 'https://switch.example.test/api/',
  token: 'agent-key',
  agentId: 'agent 1',
};

const GITHUB: ServiceGrant = {
  service: 'github',
  access: 'read',
  tool_mode: 'allow',
  tools: [],
  resources: { installation_id: 7, repository_ids: [70] },
  skill: {
    name: 'github',
    content:
      '---\nname: github\ndescription: Work in granted repositories.\n---\n\n# GitHub\n\nUse gh.\n',
  },
  mcp_servers: [],
  cli_tools: [],
};

const answering = (status: number, body: unknown) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

const byPath = (answers: Record<string, [number, unknown]>) =>
  vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const match = Object.keys(answers).find((path) => url.endsWith(path));
    if (!match) throw new Error(`unexpected request to ${url}`);
    const [status, body] = answers[match];
    return new Response(JSON.stringify(body), { status });
  });

describe('readServiceGrants', () => {
  it('reads the grants through the agent’s Switch endpoint, as the agent', async () => {
    const fetchImpl = answering(200, { grants: [GITHUB] });
    expect(await readServiceGrants(SWITCH, fetchImpl)).toEqual([GITHUB]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://switch.example.test/api/agents/agent%201/service-grants');
    expect(init?.headers).toEqual({ Authorization: 'Bearer agent-key' });
  });

  it('takes a Switch without service connections as granting nothing', async () => {
    const before = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 })
    );
    expect(await readServiceGrants(SWITCH, before)).toEqual([]);
    expect(before.mock.calls[1][0]).toBe('https://switch.example.test/api/agents/feature-flags');
    const flagOff = byPath({
      'service-grants': [404, { detail: 'Not Found' }],
      'feature-flags': [200, { flags: [{ key: 'service_connections', enabled: false }] }],
    });
    expect(await readServiceGrants(SWITCH, flagOff)).toEqual([]);
  });

  it('raises a 404 from a Switch with service connections on', async () => {
    const relayed = byPath({
      'service-grants': [404, { detail: 'The agents controller does not relay this.' }],
      'feature-flags': [200, { flags: [{ key: 'service_connections', enabled: true }] }],
    });
    await expect(readServiceGrants(SWITCH, relayed)).rejects.toThrow(
      /service connections on but answered 404.*does not relay/
    );
  });

  it('raises a 404 it cannot explain because the flags are refused', async () => {
    const refused = byPath({
      'service-grants': [404, { detail: 'Not Found' }],
      'feature-flags': [503, {}],
    });
    await expect(readServiceGrants(SWITCH, refused)).rejects.toThrow('HTTP 503');
  });

  it('says when Switch refuses or cannot be reached', async () => {
    await expect(readServiceGrants(SWITCH, answering(503, {}))).rejects.toThrow('HTTP 503');
    const unreachable = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(readServiceGrants(SWITCH, unreachable)).rejects.toThrow('could not be reached');
  });

  it('reads a vendor’s command-line tool as the catalog describes it', async () => {
    const cli = {
      name: 'example-cli',
      binary: 'excli',
      token_env: 'EXCLI_TOKEN',
      config_env: null,
      allow: ['items'],
      deny: ['auth', '--profile'],
      path_flags: { '--output': 'write', '-o': 'write' },
      path_args: [],
      output_cap_bytes: 65536,
      timeout_s: 120,
      token_refused: { exit_code: 1, json_path: 'error.code', value: 401 },
      release: {
        version: '1.2.3',
        targets: {
          'linux-x64': {
            url: 'https://downloads.example.test/excli.tar.gz',
            sha256: 'a'.repeat(64),
            path: 'excli',
          },
        },
      },
    };
    const grant = { ...GITHUB, service: 'example', resources: {}, cli_tools: [cli] };
    expect(await readServiceGrants(SWITCH, answering(200, { grants: [grant] }))).toEqual([
      { ...grant, cli_tools: [{ ...cli, env: null }] },
    ]);
    const shell = { ...grant, cli_tools: [{ ...cli, binary: 'sh -c' }] };
    await expect(readServiceGrants(SWITCH, answering(200, { grants: [shell] }))).rejects.toThrow();

    const env = { EXCLI_API_KEY: '{api_key}', EXCLI_SITE: 'https://api.{site}' };
    const keyed = { ...grant, cli_tools: [{ ...cli, token_env: null, env }] };
    expect(await readServiceGrants(SWITCH, answering(200, { grants: [keyed] }))).toEqual([keyed]);
    for (const tool of [
      { ...cli, env },
      { ...cli, token_env: null, env: null },
    ])
      await expect(
        readServiceGrants(SWITCH, answering(200, { grants: [{ ...grant, cli_tools: [tool] }] }))
      ).rejects.toThrow('one of the two');
  });

  it('reads a vendor MCP server’s header templates, and the bearer from a Switch before them', async () => {
    const url = 'https://mcp.{site}/api/unstable/mcp-server/mcp';
    const headers = { DD_API_KEY: '{api_key}', DD_APPLICATION_KEY: '{application_key}' };
    const keyed = {
      ...GITHUB,
      service: 'datadog',
      mcp_servers: [{ name: 'datadog', url, headers }],
    };
    expect(await readServiceGrants(SWITCH, answering(200, { grants: [keyed] }))).toEqual([keyed]);
    const older = {
      ...GITHUB,
      service: 'jira',
      mcp_servers: [{ name: 'jira', url: 'https://mcp.example.test/v1' }],
    };
    expect(
      (await readServiceGrants(SWITCH, answering(200, { grants: [older] })))[0].mcp_servers
    ).toEqual([
      {
        name: 'jira',
        url: 'https://mcp.example.test/v1',
        headers: { Authorization: 'Bearer {token}' },
      },
    ]);
  });

  it('reads a grant from a Switch before command-line tools as having none', async () => {
    const { cli_tools: _, ...older } = GITHUB;
    expect(await readServiceGrants(SWITCH, answering(200, { grants: [older] }))).toEqual([GITHUB]);
  });

  it('refuses an answer that is not a list of grants', async () => {
    const malformed = answering(200, { grants: [{ ...GITHUB, service: 'Not A Slug' }] });
    await expect(readServiceGrants(SWITCH, malformed)).rejects.toThrow();
  });
});

describe('granted skills', () => {
  it('gives each grant’s skill, and as context without its frontmatter', () => {
    const skills = grantedSkills([GITHUB, { ...GITHUB, service: 'jira', skill: null }]);
    expect(skills).toEqual([GITHUB.skill]);
    expect(skillContext(skills[0])).toBe('# GitHub\n\nUse gh.');
  });
});
