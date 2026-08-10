import { eq } from 'drizzle-orm';
import { db, sqlite } from '@main/db/client';
import { agents, sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { ALL_COMMAND_DEFS } from '@shared/commands';
import type { Agent } from '@shared/core/agents/agents';
import {
  type CommandPaletteQuery,
  matchQuality,
  type SearchItem,
  type SearchItemKind,
  type SearchResult,
} from '@shared/core/search';
import type { Session } from '@shared/core/sessions/sessions';
import { agentEvents } from '../agents/agent-events';
import { sessionHooks } from '../sessions/session-hooks';
import { sessionService } from '../sessions/session-service';

type FtsRow = {
  item_type: string;
  item_id: string;
  location_id: string | null;
  session_id: string | null;
  title: string;
  keywords: string;
  rank: number;
};

/**
 * Rows pulled from the index before filtering, and rows returned after it. The
 * index answers more loosely than the filter does, so asking for more
 * candidates than the caller wants keeps a precise query from coming back thin
 * because loose matches sorted above the real ones.
 */
const FTS_CANDIDATE_LIMIT = 120;
const RESULT_LIMIT = 30;

/** The shortest term the trigram tokenizer can index. */
const MIN_INDEXABLE_TERM = 3;

/** Ranking tiers, best first: the title starts with the term, a word in the
 *  title does, the title contains it somewhere, or only a keyword does. */
const TIER_TITLE_PREFIX = 0;
const TIER_TITLE_WORD = 1;
const TIER_TITLE_SUBSTRING = 2;
const TIER_KEYWORD = 3;
/** Wider than any BM25 magnitude, so the tier decides before the score does. */
const TIER_STRIDE = 1_000_000;

/**
 * Split a query into the terms every result must contain.
 *
 * **Whitespace only.** Splitting on `-` and `_` as well is what made
 * `test-tt` return `co-test`: it became the terms `test` and `tt`, `tt` was
 * dropped for being too short to index, and the search silently degraded to
 * `test` — which every one of those names contains. A hyphen is part of a name
 * here (`reviewer-bot`, `test-tt`), not a separator between two things the user
 * wants ANDed.
 */
function queryTerms(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean);
}

/**
 * The worst tier across all terms, or null when any term is absent from both
 * the title and the keywords.
 *
 * This is the real filter. The index is trigram-tokenised and answers a phrase
 * more loosely than it looks — and a term too short to index is not sent to it
 * at all — so a row coming back is not evidence that it contains what was
 * typed. Checking the text directly is.
 *
 * Judged on the worst term so a query only ranks as a title match when *every*
 * word of it is one: "reviewer bot" matching an item whose title holds one word
 * and whose description holds the other is a keyword-grade hit, not a name hit.
 */
function matchTier(row: FtsRow, terms: string[]): number | null {
  let worst = TIER_TITLE_PREFIX;
  for (const term of terms) {
    const inTitle = matchQuality(row.title, term);
    const tier =
      inTitle === 'prefix'
        ? TIER_TITLE_PREFIX
        : inTitle === 'word'
          ? TIER_TITLE_WORD
          : inTitle === 'substring'
            ? TIER_TITLE_SUBSTRING
            : matchQuality(row.keywords, term)
              ? TIER_KEYWORD
              : null;
    if (tier === null) return null;
    worst = Math.max(worst, tier);
  }
  return worst;
}

type RecentSessionRow = {
  id: string;
  title: string;
  location_id: string;
};

class SearchService {
  initialize(): void {
    sessionService.on('session:created', (session) => this.upsertSession(session));
    sessionService.on('session:updated', (session) => this.upsertSession(session));
    sessionService.on('session:archived', (sessionId) => this.removeByType('session', sessionId));
    sessionService.on('session:deleted', (sessionId) => this.removeByType('session', sessionId));
    // Row deletions outside the sessionService path (e.g. the remote-session
    // reconciler pruning a VM session) must also leave the index.
    sessionHooks.on('session:deleted', (sessionId) => this.removeByType('session', sessionId));

    agentEvents.on('agent:created', (agent) => this.upsertAgent(agent));
    agentEvents.on('agent:updated', (agent) => this.upsertAgent(agent));
    agentEvents.on('agent:deleted', (agentId) => this.removeByType('agent', agentId));

    this.backfill();
    this.seedCommands();
  }

  search({ query, context }: CommandPaletteQuery): SearchResult {
    if (!query.trim()) return { items: this.recents(context), status: 'recents' };

    const terms = queryTerms(query);

    // The tokenizer cannot index anything shorter than a trigram, so a query of
    // only short terms has nothing to ask the index. Recents are returned, but
    // reported as recents so the palette can say so rather than presenting them
    // as matches.
    const indexable = terms.filter((t) => t.length >= MIN_INDEXABLE_TERM);
    if (indexable.length === 0) {
      return { items: this.recents(context), status: 'query-too-short' };
    }

    // Only the indexable terms narrow the candidate set; `matchTier` then holds
    // every row to *all* the terms, short ones included. Dropping a short term
    // outright is what silently widened `test-tt` into `test`.
    const ftsQuery = indexable.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');

    let rows: FtsRow[];
    try {
      rows = sqlite
        .prepare(
          `SELECT item_type, item_id, location_id, session_id, title, keywords,
                  bm25(search_index) AS rank
           FROM search_index
           WHERE search_index MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsQuery, FTS_CANDIDATE_LIMIT) as FtsRow[];
    } catch (e) {
      log.error('SearchService: FTS query failed', { query, error: String(e) });
      return { items: [], status: 'failed' };
    }

    const results: SearchItem[] = rows
      .flatMap((r) => {
        const tier = matchTier(r, terms);
        return tier === null
          ? []
          : [
              {
                kind: r.item_type as SearchItemKind,
                id: r.item_id,
                locationId: r.location_id,
                sessionId: r.session_id,
                title: r.title,
                subtitle: '',
                // Tier dominates BM25 so a name match always outranks a hit
                // buried in a command's description, whatever the text lengths
                // do to the relevance score.
                score: tier * TIER_STRIDE + r.rank,
              },
            ];
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, RESULT_LIMIT);

    return { items: results, status: 'ok' };
  }

  private recents(context?: CommandPaletteQuery['context']): SearchItem[] {
    const sessionStmt = context?.locationId
      ? sqlite.prepare(
          `SELECT s.id, s.title, a.location_id
           FROM sessions s
           JOIN agents a ON a.id = s.agent_id
           WHERE s.archived_at IS NULL AND a.location_id = ?
           ORDER BY s.last_interacted_at DESC
           LIMIT 10`
        )
      : sqlite.prepare(
          `SELECT s.id, s.title, a.location_id
           FROM sessions s
           JOIN agents a ON a.id = s.agent_id
           WHERE s.archived_at IS NULL
           ORDER BY s.last_interacted_at DESC
           LIMIT 10`
        );

    let sessionRows: RecentSessionRow[];
    try {
      sessionRows = (
        context?.locationId ? sessionStmt.all(context.locationId) : sessionStmt.all()
      ) as RecentSessionRow[];
    } catch (e) {
      log.warn('SearchService: recents query failed', { error: String(e) });
      return [];
    }

    return sessionRows.map((r) => ({
      kind: 'session' as const,
      id: r.id,
      locationId: r.location_id,
      sessionId: null,
      title: r.title,
      subtitle: '',
      score: 0,
    }));
  }

  /**
   * Replace one item's row.
   *
   * Delete-then-insert rather than `INSERT OR REPLACE`: an FTS5 virtual table
   * has no unique constraint for the conflict clause to fire on, so `OR REPLACE`
   * degrades to a plain insert and every update appends a duplicate row instead
   * of superseding the old one.
   */
  private replaceItem(
    itemType: SearchItemKind,
    itemId: string,
    locationId: string | null,
    title: string,
    keywords: string
  ): void {
    sqlite.transaction(() => {
      sqlite
        .prepare(`DELETE FROM search_index WHERE item_id = ? AND item_type = ?`)
        .run(itemId, itemType);
      sqlite
        .prepare(
          `INSERT INTO search_index(item_type, item_id, location_id, session_id, title, keywords)
           VALUES (?, ?, ?, NULL, ?, ?)`
        )
        .run(itemType, itemId, locationId, title, keywords);
    })();
  }

  private upsertSession(session: Session): void {
    try {
      const [agent] = db
        .select({ locationId: agents.locationId })
        .from(agents)
        .where(eq(agents.id, session.agentId))
        .all();
      if (!agent) return;
      this.replaceItem('session', session.id, agent.locationId, session.title, '');
    } catch (e) {
      log.warn('SearchService: upsertSession failed', { sessionId: session.id, error: String(e) });
    }
  }

  private upsertAgent(agent: Agent): void {
    try {
      this.replaceItem('agent', agent.id, agent.locationId, agent.name, agent.providerId);
    } catch (e) {
      log.warn('SearchService: upsertAgent failed', { agentId: agent.id, error: String(e) });
    }
  }

  private removeByType(itemType: string, itemId: string): void {
    try {
      sqlite
        .prepare(`DELETE FROM search_index WHERE item_id = ? AND item_type = ?`)
        .run(itemId, itemType);
    } catch (e) {
      log.warn('SearchService: removeByType failed', { itemType, itemId, error: String(e) });
    }
  }

  private seedCommands(): void {
    try {
      sqlite.transaction(() => {
        sqlite.prepare(`DELETE FROM search_index WHERE item_type = 'command'`).run();
        const stmt = sqlite.prepare(
          `INSERT INTO search_index (item_type, item_id, location_id, session_id, title, keywords)
           VALUES ('command', ?, NULL, NULL, ?, ?)`
        );
        for (const def of ALL_COMMAND_DEFS) {
          stmt.run(def.id, def.label, def.description ?? '');
        }
      })();
      log.info('SearchService: seeded commands', { count: ALL_COMMAND_DEFS.length });
    } catch (e) {
      log.warn('SearchService: seedCommands failed', { error: String(e) });
    }
  }

  private backfill(): void {
    try {
      const count = (
        sqlite.prepare(`SELECT count(*) as n FROM search_index`).get() as { n: number }
      ).n;

      if (count > 0) return;

      const allSessions = db
        .select({
          id: sessions.id,
          locationId: agents.locationId,
          title: sessions.title,
          archivedAt: sessions.archivedAt,
        })
        .from(sessions)
        .innerJoin(agents, eq(sessions.agentId, agents.id))
        .all();
      const allAgents = db
        .select({
          id: agents.id,
          locationId: agents.locationId,
          name: agents.name,
          providerId: agents.providerId,
        })
        .from(agents)
        .all();

      const upsertStmt = sqlite.prepare(
        `INSERT OR REPLACE INTO search_index(item_type, item_id, location_id, session_id, title, keywords)
         VALUES (?, ?, ?, ?, ?, ?)`
      );

      sqlite.transaction(() => {
        for (const t of allSessions) {
          if (t.archivedAt) continue;
          upsertStmt.run('session', t.id, t.locationId, null, t.title, '');
        }
        for (const a of allAgents) {
          upsertStmt.run('agent', a.id, a.locationId, null, a.name, a.providerId);
        }
      })();

      log.info('SearchService: backfilled search index', {
        sessions: allSessions.filter((t) => !t.archivedAt).length,
        agents: allAgents.length,
      });
    } catch (e) {
      log.warn('SearchService: backfill failed', { error: String(e) });
    }
  }
}

export const searchService = new SearchService();
