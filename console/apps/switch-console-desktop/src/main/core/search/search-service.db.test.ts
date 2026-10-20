import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { agents, locations, sessions } from '@main/db/schema';
import type { Agent } from '@shared/core/agents/agents';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  sqlite: undefined as unknown,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
  get sqlite() {
    if (!mocks.sqlite) throw new Error('Test database not initialized');
    return mocks.sqlite;
  },
}));

vi.mock('../sessions/session-service', () => ({ sessionService: { on: vi.fn() } }));

const { searchService } = await import('./search-service');
const { agentEvents } = await import('../agents/agent-events');

function agentRecord(over: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent {
  return {
    locationId: 'loc-1',
    providerId: 'claude',
    switchAgentId: null,
    apiEndpoint: null,
    serverId: null,
    status: null,
    autoApprove: false,
    autoMode: false,
    providerConfig: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as Agent;
}

/** Titles of the indexed items a query returns, for order-insensitive asserts. */
function titles(items: { title: string }[]): string[] {
  return items.map((i) => i.title).sort();
}

describe('searchService', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.sqlite = fixture.sqlite;

    await fixture.db.insert(locations).values({
      id: 'loc-1',
      name: 'switch-console repo',
      sshHost: '',
      dir: '/tmp/switch-console',
    });
    await fixture.db
      .insert(locations)
      .values({ id: 'loc-2', name: 'other repo', sshHost: '', dir: '/tmp/other' });
    await fixture.db
      .insert(agents)
      .values({ id: 'agent-1', locationId: 'loc-1', name: 'reviewer-bot', providerId: 'claude' });
    await fixture.db
      .insert(agents)
      .values({ id: 'agent-2', locationId: 'loc-2', name: 'migration-bot', providerId: 'codex' });
    await fixture.db
      .insert(sessions)
      .values({ id: 'session-1', agentId: 'agent-1', title: 'Fix the reviewer crash' });
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
    mocks.sqlite = undefined;
  });

  // Search covers sessions, agents and commands. Filesystem hits were appended
  // to any search carrying a full session context — after the ranking cut, so
  // they bypassed both the tiers and the result cap.
  describe('result kinds', () => {
    it('returns no filesystem results when a full session context is supplied', () => {
      searchService.initialize();

      const result = searchService.search({
        query: 'reviewer',
        includeSessions: true,
        context: { locationId: 'loc-1', sessionId: 'session-1' },
      });

      expect(result.status).toBe('ok');
      expect(result.items.length).toBeGreaterThan(0);
      for (const item of result.items) {
        expect(['session', 'agent', 'command']).toContain(item.kind);
      }
    });

    it('returns the same results with a session context as without one', () => {
      searchService.initialize();

      const withoutContext = searchService.search({ query: 'reviewer', includeSessions: true });
      const withContext = searchService.search({
        query: 'reviewer',
        includeSessions: true,
        context: { locationId: 'loc-1', sessionId: 'session-1' },
      });

      expect(titles(withContext.items)).toEqual(titles(withoutContext.items));
    });
  });

  // Under agent management Console's own sessions are the legacy way agents
  // run, and the palette leaves them out.
  describe('without sessions', () => {
    it('matches agents but not sessions', () => {
      searchService.initialize();

      const result = searchService.search({ query: 'reviewer', includeSessions: false });

      expect(result.status).toBe('ok');
      expect(result.items.map((i) => [i.kind, i.title])).toEqual([['agent', 'reviewer-bot']]);
    });

    it('still matches commands', () => {
      searchService.initialize();
      const withSessions = searchService.search({ query: 'settings', includeSessions: true });

      const result = searchService.search({ query: 'settings', includeSessions: false });

      expect(result.items.some((i) => i.kind === 'command')).toBe(true);
      expect(result.items).toEqual(withSessions.items.filter((i) => i.kind !== 'session'));
    });

    it('fills the result cap with other kinds rather than dropped sessions', () => {
      searchService.initialize();
      for (let i = 0; i < 40; i++) {
        fixture.sqlite
          .prepare(
            `INSERT INTO search_index(item_type, item_id, location_id, session_id, title, keywords)
             VALUES ('session', ?, 'loc-1', NULL, ?, '')`
          )
          .run(`s-${i}`, `crowded ${i}`);
      }
      agentEvents._emit(
        'agent:created',
        agentRecord({ id: 'agent-crowded', name: 'crowded-bot', locationId: 'loc-1' }),
        'unknown'
      );

      const result = searchService.search({ query: 'crowded', includeSessions: false });

      expect(result.items.map((i) => i.title)).toEqual(['crowded-bot']);
    });

    it('offers no recent sessions for an empty query', () => {
      searchService.initialize();

      expect(searchService.search({ query: '', includeSessions: false })).toEqual({
        items: [],
        status: 'recents',
      });
    });

    it('offers no recent sessions for a query too short to search', () => {
      searchService.initialize();

      expect(searchService.search({ query: 'ab', includeSessions: false })).toEqual({
        items: [],
        status: 'query-too-short',
      });
    });
  });

  describe('indexing agents', () => {
    it('backfills existing agents so they are findable by name', () => {
      searchService.initialize();

      const result = searchService.search({ query: 'reviewer-bot', includeSessions: true });

      expect(result.status).toBe('ok');
      const agentHits = result.items.filter((i) => i.kind === 'agent');
      expect(agentHits).toHaveLength(1);
      expect(agentHits[0]).toMatchObject({ id: 'agent-1', title: 'reviewer-bot' });
    });

    it('finds an agent by its provider, which is indexed as a keyword', () => {
      searchService.initialize();

      const result = searchService.search({ query: 'codex', includeSessions: true });

      expect(titles(result.items.filter((i) => i.kind === 'agent'))).toEqual(['migration-bot']);
    });

    it('indexes an agent created after startup', () => {
      searchService.initialize();
      expect(searchService.search({ query: 'newcomer', includeSessions: true }).items).toHaveLength(
        0
      );

      agentEvents._emit(
        'agent:created',
        agentRecord({ id: 'agent-3', name: 'newcomer-bot', locationId: 'loc-1' }),
        'unknown'
      );

      expect(
        titles(searchService.search({ query: 'newcomer', includeSessions: true }).items)
      ).toEqual(['newcomer-bot']);
    });

    // A rename that does not reach the index leaves the old name matching
    // forever and the new one matching nothing.
    it('replaces the old name when an agent is renamed', () => {
      searchService.initialize();

      agentEvents._emit(
        'agent:updated',
        agentRecord({ id: 'agent-1', name: 'auditor-bot', locationId: 'loc-1' })
      );

      expect(
        searchService.search({ query: 'reviewer-bot', includeSessions: true }).items
      ).toHaveLength(0);
      expect(
        titles(searchService.search({ query: 'auditor-bot', includeSessions: true }).items)
      ).toEqual(['auditor-bot']);
    });

    // `INSERT OR REPLACE` cannot supersede a row here: an FTS5 table has no
    // unique constraint for the conflict clause to fire on, so repeated updates
    // used to append a duplicate every time and the palette listed the item once
    // per update it had ever received.
    it('keeps one row per agent however many updates arrive', () => {
      searchService.initialize();

      for (let i = 0; i < 3; i++) {
        agentEvents._emit(
          'agent:updated',
          agentRecord({ id: 'agent-1', name: 'reviewer-bot', locationId: 'loc-1' })
        );
      }

      expect(
        searchService.search({ query: 'reviewer-bot', includeSessions: true }).items
      ).toHaveLength(1);
    });

    it('drops an agent from the index when it is deleted', () => {
      searchService.initialize();

      agentEvents._emit('agent:deleted', 'agent-1');

      expect(
        searchService.search({ query: 'reviewer-bot', includeSessions: true }).items
      ).toHaveLength(0);
    });

    it('carries the location so the palette can navigate to it', () => {
      searchService.initialize();

      const [hit] = searchService.search({ query: 'migration-bot', includeSessions: true }).items;

      expect(hit).toMatchObject({ kind: 'agent', locationId: 'loc-2' });
    });
  });

  describe('reporting why the items are what they are', () => {
    it('reports an empty query as recents rather than as matches', () => {
      searchService.initialize();

      const result = searchService.search({ query: '', includeSessions: true });

      expect(result.status).toBe('recents');
      expect(titles(result.items)).toEqual(['Fix the reviewer crash']);
    });

    // The trigram tokenizer cannot answer a query this short. Returning recents
    // is fine; returning them labelled 'ok' is what made them look like matches.
    it('reports a query with no usable term as query-too-short', () => {
      searchService.initialize();

      const result = searchService.search({ query: 'ab', includeSessions: true });

      expect(result.status).toBe('query-too-short');
      expect(result.items.every((i) => i.kind === 'session')).toBe(true);
    });

    it('treats a multi-word query of short terms as too short, not as a match', () => {
      searchService.initialize();

      expect(searchService.search({ query: 'ab cd', includeSessions: true }).status).toBe(
        'query-too-short'
      );
    });

    it('reports a usable query as ok', () => {
      searchService.initialize();

      expect(searchService.search({ query: 'reviewer', includeSessions: true }).status).toBe('ok');
    });

    it('distinguishes a failed search from an empty one', () => {
      searchService.initialize();
      const broken = new Error('database disk image is malformed');
      vi.spyOn(fixture.sqlite, 'prepare').mockImplementationOnce(() => {
        throw broken;
      });

      const result = searchService.search({ query: 'reviewer', includeSessions: true });

      expect(result.status).toBe('failed');
      expect(result.items).toEqual([]);
    });
  });

  describe('matching', () => {
    // item_type is stored UNINDEXED precisely so its own literal is not content.
    it('does not match every row of a kind by typing that kind name', () => {
      searchService.initialize();

      const result = searchService.search({ query: 'session', includeSessions: true });

      expect(result.items.filter((i) => i.kind === 'session')).toHaveLength(0);
    });

    it('matches mid-word, so a term inside a compound name is still found', () => {
      searchService.initialize();

      expect(titles(searchService.search({ query: 'iewer', includeSessions: true }).items)).toEqual(
        ['Fix the reviewer crash', 'reviewer-bot']
      );
      expect(titles(searchService.search({ query: 'rat', includeSessions: true }).items)).toEqual([
        'migration-bot',
      ]);
    });

    /**
     * A hyphen is part of a name here, not a separator. Splitting on it turned
     * `test-tt` into the terms `test` and `tt`, dropped `tt` for being too short
     * to index, and searched for `test` alone — so every name containing "test"
     * came back and the query looked far broader than it was.
     */
    it('treats a hyphenated query as one string, not two terms', () => {
      searchService.initialize();
      for (const [id, name] of [
        ['a-want', 'test-tt'],
        ['a-noise', 'co-test'],
        ['a-noise2', 'test-agent-tt'],
      ]) {
        agentEvents._emit(
          'agent:created',
          agentRecord({ id, name, locationId: 'loc-1' }),
          'unknown'
        );
      }

      expect(
        titles(searchService.search({ query: 'test-tt', includeSessions: true }).items)
      ).toEqual(['test-tt']);
    });

    // The short term still has to be present, it just cannot be asked of the
    // index — dropping it silently is what widened the query.
    it('enforces a term too short to index rather than discarding it', () => {
      searchService.initialize();
      agentEvents._emit(
        'agent:created',
        agentRecord({ id: 'a-cc', name: 'reviewer cc', locationId: 'loc-1' }),
        'unknown'
      );

      expect(
        titles(searchService.search({ query: 'reviewer cc', includeSessions: true }).items)
      ).toEqual(['reviewer cc']);
    });

    it('matches a word after a separator, so a suffixed name is still findable', () => {
      searchService.initialize();

      expect(titles(searchService.search({ query: 'bot', includeSessions: true }).items)).toEqual([
        'migration-bot',
        'reviewer-bot',
      ]);
    });

    it('ranks a title match above one found only in keywords', () => {
      searchService.initialize();
      agentEvents._emit(
        'agent:created',
        agentRecord({ id: 'agent-4', name: 'codex-runner', locationId: 'loc-1' }),
        'unknown'
      );

      // 'codex' is agent-2's provider (a keyword) and agent-4's name.
      const items = searchService.search({ query: 'codex', includeSessions: true }).items;

      expect(items.map((i) => i.title)).toEqual(['codex-runner', 'migration-bot']);
    });

    it('finds sessions alongside agents', () => {
      searchService.initialize();

      expect(
        titles(searchService.search({ query: 'reviewer', includeSessions: true }).items)
      ).toEqual(['Fix the reviewer crash', 'reviewer-bot']);
    });

    // Locations are not a user-facing entity anywhere in Switch Console — the
    // sidebar lists agents flatly rather than by directory — so offering them
    // as results pointed at a concept the product does not have.
    it('does not index locations', () => {
      searchService.initialize();

      expect(
        searchService.search({ query: 'switch-console repo', includeSessions: true }).items
      ).toEqual([]);
      expect(searchService.search({ query: 'other repo', includeSessions: true }).items).toEqual(
        []
      );
    });
  });
});
