import type { ChatAgent } from '@shared/core/chats/chats';

/** Characters a name may hold; matches the server's `NAME_CHAR`, so a badge is what the server reads as a mention. */
const NAME_CHAR = /[A-Za-z0-9._-]/;

export type MentionAgent = Pick<ChatAgent, 'id' | 'name' | 'alias'>;
export type MentionToken = { agentId: string; start: number; end: number };

/**
 * Every whole `@name` or `@alias` of a chat agent in `text`, in order. Derived
 * from the text alone, so undo, paste and a restored draft keep their badges,
 * and an edit inside one (or the agent leaving the chat) turns it back to text.
 */
export function mentionTokens(text: string, agents: MentionAgent[]): MentionToken[] {
  const spoken = agents
    .flatMap((agent) =>
      [agent.name, agent.alias].flatMap((name) => (name ? [{ agent, name }] : []))
    )
    // Longest first, so `@cc-2` is never read as `@cc` followed by text.
    .sort((a, b) => b.name.length - a.name.length);
  const tokens: MentionToken[] = [];
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at > 0 && NAME_CHAR.test(text[at - 1]!)) continue;
    const hit = spoken.find(({ name }) => {
      const end = at + 1 + name.length;
      return (
        text.slice(at + 1, end).toLowerCase() === name.toLowerCase() &&
        (end === text.length || !NAME_CHAR.test(text[end]!))
      );
    });
    if (!hit) continue;
    tokens.push({ agentId: hit.agent.id, start: at, end: at + 1 + hit.name.length });
    at += hit.name.length;
  }
  return tokens;
}

/** The agents a message is for, each once. */
export function mentionAgentIds(tokens: MentionToken[]): string[] {
  return [...new Set(tokens.map((token) => token.agentId))];
}

/** The `@query` being typed at the caret, if any: `@` at the start or after whitespace. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([A-Za-z0-9._-]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, query: match[1]! };
}

/** Agents whose name or alias contains `query`, those it starts first. */
export function filterMentionAgents<T extends MentionAgent>(agents: T[], query: string): T[] {
  const q = query.toLowerCase();
  const names = (agent: T) => [agent.name, agent.alias ?? ''].map((name) => name.toLowerCase());
  const rank = (agent: T) => (names(agent).some((name) => name.startsWith(q)) ? 0 : 1);
  return agents
    .filter((agent) => names(agent).some((name) => name.includes(q)))
    .sort((a, b) => rank(a) - rank(b));
}

/**
 * The span a Backspace or Delete at a collapsed caret removes whole, because
 * the caret is inside or at the edge of a mention on that side.
 */
export function tokenToRemove(
  tokens: MentionToken[],
  caret: number,
  key: 'Backspace' | 'Delete'
): MentionToken | null {
  return (
    tokens.find((token) =>
      key === 'Backspace'
        ? token.start < caret && caret <= token.end
        : token.start <= caret && caret < token.end
    ) ?? null
  );
}

/** `text` split into plain runs and mention runs (with their agent), for drawing badges. */
export function mentionSegments(
  text: string,
  tokens: MentionToken[]
): { text: string; agentId: string | null }[] {
  const segments: { text: string; agentId: string | null }[] = [];
  let at = 0;
  for (const token of tokens) {
    if (token.start > at) segments.push({ text: text.slice(at, token.start), agentId: null });
    segments.push({ text: text.slice(token.start, token.end), agentId: token.agentId });
    at = token.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), agentId: null });
  return segments;
}

/** A mention's badge; a ring rather than padding, so it never moves the text it sits behind. */
export const MENTION_BADGE =
  'rounded-sm bg-background-tertiary-1 ring-2 ring-background-tertiary-1';
