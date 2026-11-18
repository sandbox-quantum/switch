import { describe, expect, it, vi } from 'vitest';
import {
  grantedSkills,
  issueServiceToken,
  NO_GRANTS_ROUTE_MS,
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

  it('holds a pasted credential, which has no expiry, until Switch says to ask again', async () => {
    // This machine runs an hour fast: Switch says 12:00, it thinks 13:00.
    vi.useFakeTimers({ now: Date.parse('2026-11-02T13:00:00Z'), toFake: ['Date'] });
    try {
      const issued = await issueServiceToken(
        { endpoint: 'https://switch.example.test/api', token: 'agent-key', agentId: 'agent' },
        'example',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                token: '{"public":{"site":"eu.example.test"},"secret":{"pat":"synthetic-pat"}}',
                expires_at: null,
                expires_in: null,
                use_until: '2026-11-02T13:00:00Z',
                grant_revision: 3,
              }),
              { status: 200, headers: { date: 'Mon, 02 Nov 2026 12:00:00 GMT' } }
            )
        ) as unknown as typeof fetch
      );
      expect(issued).toEqual({
        token: '{"public":{"site":"eu.example.test"},"secret":{"pat":"synthetic-pat"}}',
        expiresAt: Date.parse('2026-11-02T13:59:59Z'),
        useUntil: Date.parse('2026-11-02T13:59:59Z'),
        grantRevision: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a token with no expiry that does not say when to ask again', async () => {
    await expect(
      answered({ token: 'synthetic-pasted', expires_at: null, expires_in: null })
    ).rejects.toThrow('not one');
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
const answeringText = (status: number, text: string) =>
  vi.fn<typeof fetch>(async () => new Response(text, { status }));
const throwing = (error: unknown) =>
  vi.fn<typeof fetch>(async () => {
    throw error;
  });
const failedWith = (code: string, message: string) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
const grantsError = async (fetchImpl: typeof fetch): Promise<string> => {
  const error = await readServiceGrants(SWITCH, fetchImpl).then(
    () => {
      throw new Error('the grants were read');
    },
    (failure: unknown) => failure
  );
  return error instanceof Error ? error.message : String(error);
};

const ORIGIN = 'https://switch.example.test';
const UNREACHABLE = `Couldn't reach the Switch server at ${ORIGIN} to read this agent's service grants`;
const REFUSED = "Switch refused this agent's service grants";
const ANSWERED = "Switch answered this agent's service grants request with";

describe('readServiceGrants', () => {
  it('reads the grants through the agent’s Switch endpoint, as the agent', async () => {
    const fetchImpl = answering(200, { grants: [GITHUB] });
    expect(await readServiceGrants(SWITCH, fetchImpl)).toEqual([GITHUB]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://switch.example.test/api/agents/agent%201/service-grants');
    expect(init?.headers).toEqual({ Authorization: 'Bearer agent-key' });
  });

  it('takes a Switch without the route as granting nothing, and does not ask it again for a while', async () => {
    vi.useFakeTimers();
    try {
      const without = { ...SWITCH, agentId: 'agent-without-route' };
      const notFound = answering(404, { detail: 'Not Found' });
      expect(await readServiceGrants(without, notFound)).toEqual([]);
      // Every check, each session start: asking each time would trip Switch's refusal breaker.
      expect(await readServiceGrants(without, notFound)).toEqual([]);
      expect(notFound).toHaveBeenCalledTimes(1);
      const enveloped = answering(404, {
        error: { code: 'not_found', message: 'Not Found', retryable: false },
      });
      expect(
        await readServiceGrants({ ...SWITCH, agentId: 'agent-404-envelope' }, enveloped)
      ).toEqual([]);
      vi.advanceTimersByTime(NO_GRANTS_ROUTE_MS + 1);
      const granted = answering(200, { grants: [GITHUB] });
      expect(await readServiceGrants(without, granted)).toEqual([GITHUB]);
      expect(granted).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says it could not reach the Switch server, at its address only, when the connection is refused', async () => {
    const message = await grantsError(
      throwing(failedWith('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:8000'))
    );
    expect(message).toBe(`${UNREACHABLE} (connection refused).`);
    expect(message).not.toMatch(/Switch refused/);
    for (const secret of ['/api', 'agent 1', 'agent%201', 'agent-key'])
      expect(message).not.toContain(secret);
  });

  it('names the network failure from its code, keeping a code it does not know as it is', async () => {
    expect(await grantsError(throwing(failedWith('ENOTFOUND', 'getaddrinfo ENOTFOUND')))).toContain(
      '(address not found)'
    );
    expect(await grantsError(throwing(failedWith('UND_ERR_SOCKET', 'other side closed')))).toBe(
      `${UNREACHABLE} (UND_ERR_SOCKET).`
    );
  });

  it('falls back to the error’s own words when the failure has no cause', async () => {
    const message = await grantsError(throwing(new TypeError('fetch failed')));
    expect(message).toContain("Couldn't reach the Switch server at");
    expect(message).toContain('(fetch failed)');
  });

  it('says it could not reach the Switch server when the request times out', async () => {
    const message = await grantsError(
      throwing(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    );
    expect(message).toBe(`${UNREACHABLE} (no answer within 15 s).`);
    expect(message).not.toMatch(/Switch refused/);
  });

  it.each(
    [502, 503, 504].flatMap((status) => [
      [status, ''],
      [status, '<html>Bad Gateway</html>'],
    ])
  )(
    'takes HTTP %i without Switch’s error body (%j) as not reaching Switch',
    async (status, body) => {
      const message = await grantsError(answeringText(status as number, body as string));
      expect(message).toBe(
        `${UNREACHABLE} (HTTP ${status} from something between this machine and Switch).`
      );
      expect(message).not.toMatch(/Switch refused/);
    }
  );

  it('passes on what the agent controller’s relay says when it could not reach Switch', async () => {
    const relay = answering(502, {
      detail: 'The agent controller could not reach Switch: connect ECONNREFUSED',
    });
    expect(await grantsError(relay)).toBe(
      `${UNREACHABLE} (HTTP 502 from something between this machine and Switch: The agent controller could not reach Switch: connect ECONNREFUSED).`
    );
  });

  it('says Switch refused, with its reason, when Switch answers with its error body', async () => {
    const forbidden = answering(403, {
      error: { code: 'forbidden', message: 'Authenticated as agent a1, not a2.', retryable: false },
    });
    expect(await grantsError(forbidden)).toBe(
      `${REFUSED} (HTTP 403, forbidden: Authenticated as agent a1, not a2.).`
    );
    const archived = answering(401, {
      error: {
        code: 'workspace_archived',
        message: 'The workspace is archived.',
        retryable: false,
      },
    });
    expect(await grantsError(archived)).toContain('HTTP 401, workspace_archived:');
  });

  it('says Switch refused, with its words, for a plain-text or FastAPI refusal', async () => {
    expect(await grantsError(answeringText(401, 'Invalid credentials'))).toBe(
      `${REFUSED} (HTTP 401, Invalid credentials).`
    );
    const breaker = answering(429, {
      detail: 'This request was refused repeatedly; wait before asking again.',
    });
    expect(await grantsError(breaker)).toMatch(
      /^Switch refused this agent's service grants \(HTTP 429, This request/
    );
  });

  it.each(
    [400, 403].flatMap((status) =>
      [
        ['empty', answeringText(status, '')],
        ['HTML', answeringText(status, '<html><body>Forbidden</body></html>')],
        ['an empty object', answering(status, {})],
        ['a numeric code', answering(status, { error: { code: 7 } })],
      ].map(([kind, fetchImpl]) => [status, kind, fetchImpl] as const)
    )
  )(
    'says Switch refused with only the status for HTTP %i with %s body',
    async (status, _, fetchImpl) => {
      expect(await grantsError(fetchImpl as typeof fetch)).toBe(`${REFUSED} (HTTP ${status}).`);
    }
  );

  it('says what Switch answered, without claiming a refusal, for any other status', async () => {
    const message = await grantsError(answeringText(500, 'Internal Server Error'));
    expect(message).toBe(`${ANSWERED} HTTP 500 (Internal Server Error).`);
    expect(message).not.toMatch(/refused|Couldn't reach/);
    const fromSwitch = answering(503, {
      error: { code: 'internal', message: 'x', retryable: false },
    });
    expect(await grantsError(fromSwitch)).toBe(`${ANSWERED} HTTP 503 (internal: x).`);
  });

  it('puts the reason on one line, caps it, and drops a code that is not one', async () => {
    const long = 'line one\nline two ' + 'a'.repeat(1000);
    const message = await grantsError(
      answering(403, { error: { code: 'BAD CODE', message: long, retryable: false } })
    );
    const cleaned = long.replace(/\s+/g, ' ');
    expect(message).toBe(`${REFUSED} (HTTP 403, ${cleaned.slice(0, 300)}…).`);
    expect(message).not.toContain('\n');
    expect(message).not.toContain('BAD CODE');
  });

  it('leaves out a code or message that is empty once cleaned', async () => {
    expect(await grantsError(answering(403, { error: { code: 'forbidden', message: '  ' } }))).toBe(
      `${REFUSED} (HTTP 403, forbidden).`
    );
    expect(await grantsError(answering(403, { error: { code: ' ', message: '  ' } }))).toBe(
      `${REFUSED} (HTTP 403).`
    );
  });

  it('reads no more than 8 KiB of an error body', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled >= 1024 * 1024) return controller.close();
          const chunk = new TextEncoder().encode('a'.repeat(1024));
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 }
    );
    const huge = vi.fn<typeof fetch>(async () => new Response(body, { status: 403 }));
    expect(await grantsError(huge)).toBe(`${REFUSED} (HTTP 403).`);
    expect(pulled).toBeLessThanOrEqual(8 * 1024);
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
