import type { Turn } from './roles.ts';
import type { Fact } from './scenario-file.ts';

/**
 * The checks that decide a scenario without a model.
 *
 * A scenario's own facts say what must, or must not, appear in the agent's
 * replies. `undelivered` checks the other side of the conversation: that every
 * message the driver wrote reached the Switch room, so an agent that "ignored"
 * a message it never received is not mistaken for one that ignored it.
 */

export interface FactResult {
  id: string;
  holds: boolean;
  detail: string;
}

export function checkFacts(facts: readonly Fact[], turns: readonly Turn[]): FactResult[] {
  const replies = turns.filter((turn) => turn.from === 'agent').map((turn) => turn.text);
  return facts.map((fact) => checkFact(fact, replies));
}

function checkFact(fact: Fact, replies: readonly string[]): FactResult {
  const wanted = fact.expect === 'matches';
  const ok = (reply: string): boolean => fact.pattern.test(reply) === wanted;
  const describe = `${fact.expect === 'matches' ? 'matches' : 'does not match'} /${fact.pattern.source}/i`;
  if (replies.length === 0) {
    return { id: fact.id, holds: false, detail: 'the agent never replied' };
  }
  const which = (index: number): string => `reply ${index + 1} of ${replies.length}`;
  switch (fact.turn) {
    case 'first':
    case 'last': {
      const index = fact.turn === 'first' ? 0 : replies.length - 1;
      const holds = ok(replies[index]!);
      return {
        id: fact.id,
        holds,
        detail: `${which(index)} ${holds ? describe : `fails: ${describe}`}`,
      };
    }
    case 'any': {
      const index = replies.findIndex(ok);
      return {
        id: fact.id,
        holds: index !== -1,
        detail: index === -1 ? `no reply ${describe}` : `${which(index)} ${describe}`,
      };
    }
    case 'every': {
      const failing = replies
        .map((reply, index) => (ok(reply) ? -1 : index))
        .filter((i) => i !== -1);
      return {
        id: fact.id,
        holds: failing.length === 0,
        detail:
          failing.length === 0
            ? `every reply ${describe}`
            : `${failing.map(which).join(', ')} fail: ${describe}`,
      };
    }
  }
}

/**
 * The human messages that are not in the room's history: written by the
 * driver, never delivered.
 *
 * `history` is the room's message bodies, oldest first. Each driver message
 * has to match a body of its own, later than the one the message before it
 * matched, so a lost "Yes." is not covered by an earlier "Yes." or by a longer
 * message that contains it. A body matches when it is the message, or the
 * message after a leading mention (the bridge carries the human's
 * `@agent ...` as written). Both are compared after `normalise`, so a
 * platform's spacing or quote style does not read as a lost message.
 */
export function undelivered(turns: readonly Turn[], history: readonly string[]): string[] {
  const bodies = history.map(normalise);
  const lost: string[] = [];
  let next = 0;
  for (const turn of turns) {
    if (turn.from !== 'human' && turn.from !== 'channel') continue;
    const text = normalise(turn.text);
    const index = bodies.findIndex(
      (body, i) =>
        i >= next && (body === text || (body.startsWith('@') && body.endsWith(` ${text}`)))
    );
    if (index === -1) lost.push(turn.text);
    else next = index + 1;
  }
  return lost;
}

/** Unicode compatibility forms folded, curly quotes made straight, runs of whitespace made one space. */
export function normalise(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
