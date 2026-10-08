import z from 'zod';

/**
 * The model's reasoning for a session's recent turns, as its local or SSH
 * session host holds it in memory. It is never part of the session's event
 * stream or transcript, and a cloud or controller-run session has none.
 *
 * `startedAt` is null when the provider gave no real start signal (Claude
 * reports thinking only once it is done); `completedAt` is null while the
 * reasoning is still running. Both are ISO timestamps.
 */
export type ReasoningTurn = {
  turnId: string;
  text: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type ReasoningList = { epoch: string; turns: ReasoningTurn[] };

export const reasoningTurnSchema = z.object({
  turnId: z.string().min(1),
  text: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const reasoningListSchema = z.object({
  epoch: z.string().min(1),
  turns: z.array(reasoningTurnSchema),
});

/**
 * The row label for a turn's reasoning: "Thinking…" while the turn runs and
 * the reasoning has not completed, "Thought for Ns" only when both ends are
 * known, and plain "Thought" otherwise — never a duration made up from one end.
 */
export function reasoningLabel(
  turn: ReasoningTurn | null,
  running: boolean
): { label: string; seconds: number | null } | null {
  if (!turn) return null;
  if (running && turn.completedAt === null) return { label: 'Thinking…', seconds: null };
  if (turn.startedAt !== null && turn.completedAt !== null) {
    const elapsed = Date.parse(turn.completedAt) - Date.parse(turn.startedAt);
    if (Number.isFinite(elapsed)) {
      const seconds = Math.max(1, Math.round(elapsed / 1000));
      return { label: `Thought for ${seconds}s`, seconds };
    }
  }
  return { label: 'Thought', seconds: null };
}
