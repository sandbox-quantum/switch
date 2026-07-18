import { basename } from 'node:path';
import { fsEvents } from '@main/core/fs/fs-events';
import type { LocationRuntime } from '@main/core/locations/location-runtime';
import { locationRuntimeRegistry } from '@main/core/locations/location-runtime-registry';
import { sqlite } from '@main/db/client';
import { log } from '@main/lib/logger';

const STALE_DAYS = 14;
const MAX_FILES = 50_000;
const CRAWL_TIMEOUT_MS = 30_000;
const REINDEX_DEBOUNCE_MS = 3_000;

const CRAWL_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.parcel-cache',
  '__pycache__',
  '.pytest_cache',
  'venv',
  '.venv',
  'target',
  '.terraform',
  '.serverless',
  'worktrees',
  '.switchdash',
  '.conductor',
  '.cursor',
  '.claude',
  '.amp',
  '.codex',
  '.aider',
  '.continue',
  '.cody',
  '.windsurf',
]);

type FileHit = { path: string; filename: string };

class LocationFileIndexService {
  private crawling = new Set<string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  initialize(): void {
    this.evictStale();

    fsEvents.on('watch:event', ({ locationId }) => {
      this.scheduleReindex(locationId);
    });
  }

  async onRuntimeCreated(locationId: string, runtime: LocationRuntime): Promise<void> {
    const alreadyIndexed = sqlite
      .prepare(`SELECT 1 FROM location_file_index_meta WHERE location_id = ?`)
      .get(locationId);

    if (alreadyIndexed) {
      this.touchMeta(locationId);
      return;
    }

    await this.crawl(locationId, runtime);
  }

  onRuntimeDestroyed(_locationId: string): void {
    // Intentionally a no-op: the index ages out 14 days after the last provision.
    // Calling touchMeta here would reset the staleness clock on every destroy,
    // preventing eviction of stale entries for frequently-cycled workspaces.
  }

  deleteIndex(locationId: string): void {
    try {
      sqlite.transaction(() => {
        sqlite.prepare(`DELETE FROM location_file_index WHERE location_id = ?`).run(locationId);
        sqlite
          .prepare(`DELETE FROM location_file_index_meta WHERE location_id = ?`)
          .run(locationId);
      })();
      log.info('LocationFileIndexService: deleted index', { locationId });
    } catch (e) {
      log.warn('LocationFileIndexService: deleteIndex failed', { locationId, error: String(e) });
    }
  }

  search(locationId: string, query: string): FileHit[] {
    const terms = query
      .trim()
      .split(/[\s\-_/]+/)
      .filter((t) => t.length >= 3);

    if (terms.length === 0) return [];

    const ftsQuery = terms.map((t) => `"${t}"`).join(' AND ');
    try {
      return sqlite
        .prepare(
          `SELECT path, filename
           FROM location_file_index
           WHERE location_file_index MATCH ?
             AND location_id = ?
           ORDER BY bm25(location_file_index, 1.0, 2.0)
           LIMIT 20`
        )
        .all(ftsQuery, locationId) as FileHit[];
    } catch (e) {
      log.warn('LocationFileIndexService: search failed', { locationId, error: String(e) });
      return [];
    }
  }

  private async crawl(locationId: string, runtime: LocationRuntime): Promise<void> {
    if (this.crawling.has(locationId)) return;
    this.crawling.add(locationId);

    try {
      const result = await runtime.fs.list('', {
        recursive: true,
        maxEntries: MAX_FILES,
        timeBudgetMs: CRAWL_TIMEOUT_MS,
      });

      const files = result.entries.filter(
        (e) => e.type === 'file' && !e.path.split('/').some((seg) => CRAWL_IGNORED_DIRS.has(seg))
      );

      sqlite.transaction(() => {
        sqlite.prepare(`DELETE FROM location_file_index WHERE location_id = ?`).run(locationId);
        const stmt = sqlite.prepare(
          `INSERT INTO location_file_index(location_id, path, filename) VALUES (?, ?, ?)`
        );
        for (const f of files) {
          stmt.run(locationId, f.path, basename(f.path));
        }
      })();

      this.touchMeta(locationId);
      log.info('LocationFileIndexService: indexed runtime', {
        locationId,
        count: files.length,
        truncated: result.truncated ?? false,
      });
    } catch (e) {
      log.warn('LocationFileIndexService: crawl failed', { locationId, error: String(e) });
    } finally {
      this.crawling.delete(locationId);
    }
  }

  private scheduleReindex(locationId: string): void {
    const existing = this.debounceTimers.get(locationId);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      locationId,
      setTimeout(() => {
        this.debounceTimers.delete(locationId);
        const ws = locationRuntimeRegistry.get(locationId);
        if (ws) void this.crawl(locationId, ws);
      }, REINDEX_DEBOUNCE_MS)
    );
  }

  private touchMeta(locationId: string): void {
    try {
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO location_file_index_meta (location_id, indexed_at)
           VALUES (?, unixepoch())`
        )
        .run(locationId);
    } catch (e) {
      log.warn('LocationFileIndexService: touchMeta failed', { locationId, error: String(e) });
    }
  }

  private evictStale(): void {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - STALE_DAYS * 86400;
      const stale = sqlite
        .prepare(`SELECT location_id FROM location_file_index_meta WHERE indexed_at < ?`)
        .all(cutoff) as Array<{ location_id: string }>;

      if (stale.length > 0) {
        sqlite.transaction(() => {
          const delIndex = sqlite.prepare(`DELETE FROM location_file_index WHERE location_id = ?`);
          const delMeta = sqlite.prepare(
            `DELETE FROM location_file_index_meta WHERE location_id = ?`
          );
          for (const row of stale) {
            delIndex.run(row.location_id);
            delMeta.run(row.location_id);
          }
        })();
        log.info('LocationFileIndexService: evicted stale indexes', { count: stale.length });
      }
    } catch (e) {
      log.warn('LocationFileIndexService: evictStale failed', { error: String(e) });
    }
  }
}

export const locationFileIndexService = new LocationFileIndexService();
