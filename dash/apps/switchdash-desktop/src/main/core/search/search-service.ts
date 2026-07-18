import { eq } from 'drizzle-orm';
import { db, sqlite } from '@main/db/client';
import { agents, projects, sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { ALL_COMMAND_DEFS } from '@shared/commands';
import type { CommandPaletteQuery, SearchItem, SearchItemKind } from '@shared/core/search';
import type { Session } from '@shared/core/sessions/sessions';
import type { Project } from '@shared/projects';
import { conversationEvents } from '../conversations/conversation-events';
import { projectEvents } from '../projects/project-events';
import { sessionService } from '../sessions/session-service';
import { workspaceFileIndexService } from './workspace-file-index-service';

type FtsRow = {
  item_type: string;
  item_id: string;
  project_id: string | null;
  session_id: string | null;
  title: string;
  rank: number;
};

type RecentSessionRow = {
  id: string;
  name: string;
  project_id: string;
};

type RecentConversationRow = {
  id: string;
  title: string;
  project_id: string;
  session_id: string;
};

class SearchService {
  initialize(): void {
    sessionService.on('session:created', (session) => this.upsertSession(session));
    sessionService.on('session:updated', (session) => this.upsertSession(session));
    sessionService.on('session:archived', (sessionId) => this.removeByType('session', sessionId));
    sessionService.on('session:deleted', (sessionId) => this.removeByType('session', sessionId));

    projectEvents.on('project:created', (project) => this.upsertProject(project));
    projectEvents.on('project:deleted', (projectId) => this.removeByType('project', projectId));

    conversationEvents.on(
      'conversation:renamed',
      (conversationId, projectId, sessionId, newTitle) => {
        this.upsertConversationById(conversationId, projectId, sessionId, newTitle);
      }
    );
    conversationEvents.on('conversation:deleted', (conversationId) =>
      this.removeByType('conversation', conversationId)
    );

    this.backfill();
    this.seedCommands();
  }

  search({ query, context }: CommandPaletteQuery): SearchItem[] {
    if (!query.trim()) return this.recents(context);

    // Trigram tokenizer requires each term to be at least 3 characters.
    // Terms shorter than 3 chars are dropped; if nothing survives, fall back
    // to recents rather than sending an invalid query to SQLite.
    const terms = query
      .trim()
      .split(/[\s\-_]+/)
      .filter((t) => t.length >= 3);

    if (terms.length === 0) return this.recents(context);

    const ftsQuery = terms.map((t) => `"${t}"`).join(' AND ');

    let rows: FtsRow[];
    try {
      if (context?.sessionId) {
        rows = sqlite
          .prepare(
            `SELECT item_type, item_id, project_id, session_id, title, bm25(search_index) AS rank
             FROM search_index
             WHERE search_index MATCH ?
               AND (item_type != 'conversation' OR session_id = ?)
             ORDER BY rank
             LIMIT 30`
          )
          .all(ftsQuery, context.sessionId) as FtsRow[];
      } else {
        rows = sqlite
          .prepare(
            `SELECT item_type, item_id, project_id, session_id, title, bm25(search_index) AS rank
             FROM search_index
             WHERE search_index MATCH ?
               AND item_type != 'conversation'
             ORDER BY rank
             LIMIT 30`
          )
          .all(ftsQuery) as FtsRow[];
      }
    } catch (e) {
      log.warn('SearchService: FTS query failed', { query, error: String(e) });
      return [];
    }

    const results: SearchItem[] = rows.map((r) => ({
      kind: r.item_type as SearchItemKind,
      id: r.item_id,
      projectId: r.project_id,
      sessionId: r.session_id,
      title: r.title,
      subtitle: '',
      score: r.rank,
    }));

    if (context?.workspaceId) {
      const fileHits = workspaceFileIndexService.search(context.workspaceId, query);
      for (const h of fileHits) {
        results.push({
          kind: 'file',
          id: h.path,
          projectId: context.projectId ?? null,
          sessionId: context.sessionId ?? null,
          title: h.filename,
          subtitle: h.path,
          score: 0,
        });
      }
    }

    return results;
  }

  private recents(context?: CommandPaletteQuery['context']): SearchItem[] {
    const sessionStmt = context?.projectId
      ? sqlite.prepare(
          `SELECT t.id, t.name, t.project_id
           FROM sessions t
           WHERE t.archived_at IS NULL AND t.project_id = ?
           ORDER BY t.last_interacted_at DESC
           LIMIT 10`
        )
      : sqlite.prepare(
          `SELECT t.id, t.name, t.project_id
           FROM sessions t
           WHERE t.archived_at IS NULL
           ORDER BY t.last_interacted_at DESC
           LIMIT 10`
        );

    const sessionRows = (
      context?.projectId ? sessionStmt.all(context.projectId) : sessionStmt.all()
    ) as RecentSessionRow[];

    const results: SearchItem[] = sessionRows.map((r) => ({
      kind: 'session' as const,
      id: r.id,
      projectId: r.project_id,
      sessionId: null,
      title: r.name,
      subtitle: '',
      score: 0,
    }));

    if (context?.sessionId) {
      const conversationRows = sqlite
        .prepare(
          `SELECT c.id, c.title, c.project_id, c.session_id
           FROM conversations c
           WHERE c.session_id = ?
           ORDER BY c.last_interacted_at DESC
           LIMIT 10`
        )
        .all(context.sessionId) as RecentConversationRow[];

      for (const r of conversationRows) {
        results.push({
          kind: 'conversation',
          id: r.id,
          projectId: r.project_id,
          sessionId: r.session_id,
          title: r.title,
          subtitle: '',
          score: 0,
        });
      }
    }

    return results;
  }

  private upsertSession(session: Session): void {
    try {
      const [agent] = db
        .select({ projectId: agents.projectId })
        .from(agents)
        .where(eq(agents.id, session.agentId))
        .all();
      if (!agent) return;
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO search_index(item_type, item_id, project_id, session_id, title, keywords)
           VALUES ('session', ?, ?, NULL, ?, '')`
        )
        .run(session.id, agent.projectId, session.title);
    } catch (e) {
      log.warn('SearchService: upsertSession failed', { sessionId: session.id, error: String(e) });
    }
  }

  private upsertProject(project: Project): void {
    try {
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO search_index(item_type, item_id, project_id, session_id, title, keywords)
           VALUES ('project', ?, NULL, NULL, ?, ?)`
        )
        .run(project.id, project.name, project.path);
    } catch (e) {
      log.warn('SearchService: upsertProject failed', {
        projectId: project.id,
        error: String(e),
      });
    }
  }

  private upsertConversationById(
    conversationId: string,
    projectId: string,
    sessionId: string,
    title: string
  ): void {
    try {
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO search_index(item_type, item_id, project_id, session_id, title, keywords)
           VALUES ('conversation', ?, ?, ?, ?, '')`
        )
        .run(conversationId, projectId, sessionId, title);
    } catch (e) {
      log.warn('SearchService: upsertConversationById failed', {
        conversationId,
        error: String(e),
      });
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
          `INSERT INTO search_index (item_type, item_id, project_id, session_id, title, keywords)
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
          projectId: agents.projectId,
          title: sessions.title,
          archivedAt: sessions.archivedAt,
        })
        .from(sessions)
        .innerJoin(agents, eq(sessions.agentId, agents.id))
        .all();
      const allProjects = db.select().from(projects).all();

      const upsertStmt = sqlite.prepare(
        `INSERT OR REPLACE INTO search_index(item_type, item_id, project_id, session_id, title, keywords)
         VALUES (?, ?, ?, ?, ?, ?)`
      );

      sqlite.transaction(() => {
        for (const t of allSessions) {
          if (t.archivedAt) continue;
          // A session is also its own conversation (1:1) in switchdash.
          upsertStmt.run('session', t.id, t.projectId, null, t.title, '');
          upsertStmt.run('conversation', t.id, t.projectId, t.id, t.title, '');
        }
        for (const p of allProjects) {
          upsertStmt.run('project', p.id, null, null, p.name, p.path);
        }
      })();

      log.info('SearchService: backfilled search index', {
        sessions: allSessions.filter((t) => !t.archivedAt).length,
        projects: allProjects.length,
      });
    } catch (e) {
      log.warn('SearchService: backfill failed', { error: String(e) });
    }
  }
}

export const searchService = new SearchService();
