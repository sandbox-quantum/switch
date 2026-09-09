import type { ActivityEntry } from '@renderer/features/sessions/stores/session-transcript-store';
import type { TranscriptEntry, TranscriptTurn } from '@shared/core/sessions/session-transcript';

/**
 * One rendered block. Consecutive `item` entries collapse into a single
 * `activity` block so a turn that touched a dozen files reads as one line
 * ("12 actions") until it is opened.
 */
export type TranscriptBlock =
  | { kind: 'entry'; id: string; entry: Exclude<TranscriptEntry, { kind: 'item' }> }
  | { kind: 'activity'; id: string; items: ActivityEntry[] };

/** A run of consecutive entries belonging to the same turn. */
export interface TranscriptSection {
  /** `null` for entries with no turn of their own — notices. */
  turnId: string | null;
  turn: TranscriptTurn | undefined;
  blocks: TranscriptBlock[];
}

function entryTurnId(entry: TranscriptEntry): string | null {
  return 'turnId' in entry ? entry.turnId : null;
}

/** Collapse consecutive activity entries; leave every other entry on its own. */
export function groupActivity(entries: TranscriptEntry[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'item') {
      blocks.push({ kind: 'entry', id: entry.id, entry });
      continue;
    }
    const last = blocks.at(-1);
    if (last?.kind === 'activity') {
      last.items.push(entry);
      continue;
    }
    blocks.push({ kind: 'activity', id: entry.id, items: [entry] });
  }
  return blocks;
}

/**
 * Split the transcript into turn sections, each with its entries already
 * grouped. A turn interrupted by a notice resumes in a new section rather than
 * swallowing the notice, which keeps reading order intact.
 */
export function buildTranscriptSections(
  entries: TranscriptEntry[],
  turns: TranscriptTurn[]
): TranscriptSection[] {
  const byId = new Map(turns.map((turn) => [turn.turnId, turn]));
  const sections: TranscriptSection[] = [];
  let current: TranscriptEntry[] = [];
  let currentTurnId: string | null | undefined;

  const flush = () => {
    if (current.length === 0) return;
    sections.push({
      turnId: currentTurnId ?? null,
      turn: currentTurnId ? byId.get(currentTurnId) : undefined,
      blocks: groupActivity(current),
    });
    current = [];
  };

  for (const entry of entries) {
    const turnId = entryTurnId(entry);
    if (currentTurnId !== undefined && turnId !== currentTurnId) flush();
    currentTurnId = turnId;
    current.push(entry);
  }
  flush();

  return sections;
}
