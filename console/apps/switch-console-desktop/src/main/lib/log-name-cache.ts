/**
 * Remembers the human-readable name of entities the app has already loaded, so
 * log entries can carry `sessionTitle` / `agentName` next to their ids.
 *
 * The cache is *pushed to*, never read through. Callers that already hold a
 * record hand over the name they have; the logger only ever reads what is
 * present. That keeps database access off the logging path entirely — a
 * read-through cache would put a query behind every unresolved id, which on a
 * write path that runs during shutdown and inside error handlers is a much
 * worse trade than occasionally logging an id without its name.
 */
const MAX_ENTRIES = 256;

class BoundedNameCache {
  private readonly entries = new Map<string, string>();

  note(id: string | undefined, name: string | undefined | null): void {
    if (!id || !name) return;
    // Re-insert so the most recently seen entries are the last to be evicted.
    this.entries.delete(id);
    this.entries.set(id, name);
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  lookup(id: string | undefined): string | undefined {
    return id ? this.entries.get(id) : undefined;
  }

  forget(id: string): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }
}

const sessionTitles = new BoundedNameCache();
const agentNames = new BoundedNameCache();

export function noteSessionTitle(id: string | undefined, title: string | undefined | null): void {
  sessionTitles.note(id, title);
}

export function noteAgentName(id: string | undefined, name: string | undefined | null): void {
  agentNames.note(id, name);
}

export function lookupSessionTitle(id: string | undefined): string | undefined {
  return sessionTitles.lookup(id);
}

export function lookupAgentName(id: string | undefined): string | undefined {
  return agentNames.lookup(id);
}

export function forgetSessionTitle(id: string): void {
  sessionTitles.forget(id);
}

export function forgetAgentName(id: string): void {
  agentNames.forget(id);
}

/** Test seam. */
export function clearLogNameCaches(): void {
  sessionTitles.clear();
  agentNames.clear();
}
