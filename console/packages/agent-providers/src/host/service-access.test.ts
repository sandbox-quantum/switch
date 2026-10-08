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
    expect(issued).toMatchObject({ expiresAt: Date.parse('2026-10-08T13:00:00Z') });
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
};

const answering = (status: number, body: unknown) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

describe('readServiceGrants', () => {
  it('reads the grants through the agent’s Switch endpoint, as the agent', async () => {
    const fetchImpl = answering(200, { grants: [GITHUB] });
    expect(await readServiceGrants(SWITCH, fetchImpl)).toEqual([GITHUB]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://switch.example.test/api/agents/agent%201/service-grants');
    expect(init?.headers).toEqual({ Authorization: 'Bearer agent-key' });
  });

  it('takes a Switch without the route as granting nothing', async () => {
    expect(await readServiceGrants(SWITCH, answering(404, { detail: 'Not Found' }))).toEqual([]);
  });

  it('says when Switch refuses or cannot be reached', async () => {
    await expect(readServiceGrants(SWITCH, answering(503, {}))).rejects.toThrow('HTTP 503');
    const unreachable = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(readServiceGrants(SWITCH, unreachable)).rejects.toThrow('could not be reached');
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
