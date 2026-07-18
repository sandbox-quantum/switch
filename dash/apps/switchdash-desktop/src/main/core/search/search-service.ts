import { eq } from 'drizzle-orm';
import { db, sqlite } from '@main/db/client';
import { agents, projects, sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { ALL_COMMAND_DEFS } from '@shared/commands';
import type { CommandPaletteQuery, SearchItem, SearchItemKind } from '@shared/core/search';
import type { Session } from '@shared/core/sessions/sessions';
import type { Project } from '@shared/projects';
import { projectEvents } from '../projects/project-events';
import { sessionHooks } from '../sessions/session-hooks';
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
  title: string;
  project_id: string;
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

    projectEvents.on('project:created', (project) => this.upsertProject(project));
    projectEvents.on('project:deleted', (projectId) => this.removeByType('project', projectId));

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
      rows = sqlite
        .prepare(
          `SELECT item_type, item_id, project_id, session_id, title, bm25(search_index) AS rank
           FROM search_index
           WHERE search_index MATCH ?
           ORDER BY rank
           LIMIT 30`
        )
        .all(ftsQuery) as FtsRow[];
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
          `SELECT s.id, s.title, a.project_id
           FROM sessions s
           JOIN agents a ON a.id = s.agent_id
           WHERE s.archived_at IS NULL AND a.project_id = ?
           ORDER BY s.last_interacted_at DESC
           LIMIT 10`
        )
      : sqlite.prepare(
          `SELECT s.id, s.title, a.project_id
           FROM sessions s
           JOIN agents a ON a.id = s.agent_id
           WHERE s.archived_at IS NULL
           ORDER BY s.last_interacted_at DESC
           LIMIT 10`
        );

    let sessionRows: RecentSessionRow[];
    try {
      sessionRows = (
        context?.projectId ? sessionStmt.all(context.projectId) : sessionStmt.all()
      ) as RecentSessionRow[];
    } catch (e) {
      log.warn('SearchService: recents query failed', { error: String(e) });
      return [];
    }

    return sessionRows.map((r) => ({
      kind: 'session' as const,
      id: r.id,
      projectId: r.project_id,
      sessionId: null,
      title: r.title,
      subtitle: '',
      score: 0,
    }));
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
          upsertStmt.run('session', t.id, t.projectId, null, t.title, '');
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
