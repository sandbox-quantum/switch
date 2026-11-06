import type { ChatAgent, ChatMentionSpan } from '@shared/core/chats/chats';

/** Characters a name may hold; matches the server's `NAME_CHAR`, so a badge is what the server reads as a mention. */
const NAME_CHAR = /[A-Za-z0-9._-]/;

export type MentionAgent = Pick<ChatAgent, 'id' | 'name' | 'alias'>;
/** A person in the chat, mentioned by their whole display name, spaces and all. */
export type MentionPerson = { userId: string; name: string };
/** Someone a mention can name: an agent or a person, by the names they answer to. */
export type MentionTarget = { kind: 'agent' | 'person'; id: string; names: string[] };
export type MentionToken = { kind: 'agent' | 'person'; id: string; start: number; end: number };

/** Agents as mention targets, by name and alias. */
export function agentTargets(agents: MentionAgent[]): MentionTarget[] {
  return agents.map((agent) => ({
    kind: 'agent',
    id: agent.id,
    names: [agent.name, agent.alias].filter((name): name is string => Boolean(name)),
  }));
}

/** People as mention targets, by their display name. */
export function personTargets(people: MentionPerson[]): MentionTarget[] {
  return people.map((person) => ({ kind: 'person', id: person.userId, names: [person.name] }));
}

/**
 * Every whole `@name` of a target in `text`, in order. Where a person and an
 * agent share a name, the target listed first wins. Derived from the text
 * alone, so undo, paste and a restored draft keep their badges, and an edit
 * inside one (or its owner leaving the chat) turns it back to text.
 */
export function mentionTokens(text: string, targets: MentionTarget[]): MentionToken[] {
  const spoken = targets
    .flatMap((target) => target.names.map((name) => ({ target, name })))
    // Longest first, so `@cc-2` is never read as `@cc` followed by text; the sort is stable, so ties keep the callers' order.
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
    tokens.push({
      kind: hit.target.kind,
      id: hit.target.id,
      start: at,
      end: at + 1 + hit.name.length,
    });
    at += hit.name.length;
  }
  return tokens;
}

/** The agents a message is for, each once. */
export function mentionAgentIds(tokens: MentionToken[]): string[] {
  return [...new Set(tokens.filter((token) => token.kind === 'agent').map((token) => token.id))];
}

/** The people a message mentions, each once; they are never sent as agents. */
export function mentionUserIds(tokens: MentionToken[]): string[] {
  return [...new Set(tokens.filter((token) => token.kind === 'person').map((token) => token.id))];
}

/** People whose name contains `query`, those it starts first. */
export function filterMentionPeople<T extends MentionPerson>(people: T[], query: string): T[] {
  const q = query.toLowerCase();
  const rank = (person: T) => (person.name.toLowerCase().startsWith(q) ? 0 : 1);
  return people
    .filter((person) => person.name.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b));
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

/** `text` split into plain runs and mention runs (with their token), for drawing badges. */
export function mentionSegments(
  text: string,
  tokens: MentionToken[]
): { text: string; token: MentionToken | null }[] {
  const segments: { text: string; token: MentionToken | null }[] = [];
  let at = 0;
  for (const token of tokens) {
    if (token.start > at) segments.push({ text: text.slice(at, token.start), token: null });
    segments.push({ text: text.slice(token.start, token.end), token });
    at = token.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), token: null });
  return segments;
}

/** A mention's badge; a ring rather than padding, so it never moves the text it sits behind. */
export const MENTION_BADGE =
  'rounded-sm bg-background-tertiary-1 ring-2 ring-background-tertiary-1';

/** A picked mention an edit removed, with the text it read, for undo to bring back. */
export type RememberedMention = MentionToken & { text: string };

/** How many removed mentions undo can bring back. */
const REMEMBERED_MENTIONS = 20;

/**
 * Picked mentions carried across an edit from `before` to `after`: those wholly
 * before or after the changed run keep their place (shifted), and one the edit
 * touches is dropped but remembered. An undo or redo (`history`) brings back a
 * remembered mention whose exact text reappears where it was.
 */
export function editMentions(
  before: string,
  after: string,
  mentions: MentionToken[],
  remembered: RememberedMention[],
  history: boolean
): { mentions: MentionToken[]; remembered: RememberedMention[] } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const endBefore = before.length - tail;
  const delta = after.length - before.length;
  const kept: MentionToken[] = [];
  const dropped: RememberedMention[] = [];
  for (const mention of mentions) {
    if (mention.end <= start) kept.push(mention);
    else if (mention.start >= endBefore)
      kept.push({ ...mention, start: mention.start + delta, end: mention.end + delta });
    else dropped.push({ ...mention, text: before.slice(mention.start, mention.end) });
  }
  let memory = [...remembered, ...dropped].slice(-REMEMBERED_MENTIONS);
  if (!history) return { mentions: kept, remembered: memory };
  const back = memory.filter(
    (entry) =>
      after.slice(entry.start, entry.end) === entry.text &&
      !kept.some((mention) => entry.start < mention.end && mention.start < entry.end)
  );
  memory = memory.filter((entry) => !back.includes(entry));
  return {
    mentions: [...kept, ...back.map(({ text: _text, ...mention }) => mention)].sort(
      (a, b) => a.start - b.start
    ),
    remembered: memory,
  };
}

/** {@link editMentions} without the memory: the picked mentions that survive an edit. */
export function shiftMentions(
  before: string,
  after: string,
  mentions: MentionToken[]
): MentionToken[] {
  return editMentions(before, after, mentions, [], false).mentions;
}

/**
 * The mentions in `text`: the picked ones, each still reading as `@` one of
 * its target's names, and around them whatever the targets' names match on
 * their own.
 */
export function composeMentions(
  text: string,
  picked: MentionToken[],
  targets: MentionTarget[]
): MentionToken[] {
  const kept = picked.filter((mention) => {
    const target = targets.find((each) => each.kind === mention.kind && each.id === mention.id);
    const said = text.slice(mention.start + 1, mention.end).toLowerCase();
    return (
      text[mention.start] === '@' &&
      target !== undefined &&
      target.names.some((name) => name.toLowerCase() === said)
    );
  });
  const found = mentionTokens(text, targets).filter(
    (token) => !kept.some((mention) => token.start < mention.end && mention.start < token.end)
  );
  return [...kept, ...found].sort((a, b) => a.start - b.start);
}

/** The mentions as the server takes them: each stretch of the body (UTF-16 offsets) and whom it names. */
export function mentionSpans(tokens: MentionToken[]): ChatMentionSpan[] {
  return tokens.map((token) => ({
    kind: token.kind === 'person' ? 'user' : 'agent',
    id: token.id,
    offset: token.start,
    length: token.end - token.start,
  }));
}

/** A message's mentions from the stretches the server returned, those that lie within the body. */
export function tokensFromSpans(body: string, spans: ChatMentionSpan[]): MentionToken[] {
  return spans
    .filter((span) => span.offset >= 0 && span.offset + span.length <= body.length)
    .map((span): MentionToken => ({
      kind: span.kind === 'user' ? 'person' : 'agent',
      id: span.id,
      start: span.offset,
      end: span.offset + span.length,
    }))
    .sort((a, b) => a.start - b.start);
}

/** Without group chats a message may name one agent and no people: the first agent mention, nothing else. */
export function withoutGroupMentions(tokens: MentionToken[]): MentionToken[] {
  const first = tokens.find((token) => token.kind === 'agent');
  return first ? [first] : [];
}

/**
 * What a send says about its mentions. Without group chats only the agents go:
 * a server without them refuses people and spans, and the first agent is all
 * it takes.
 */
export function mentionPayload(
  tokens: MentionToken[],
  groupChats: boolean
): { mentionAgentIds: string[]; mentionUserIds: string[]; mentionSpans: ChatMentionSpan[] } {
  return {
    mentionAgentIds: mentionAgentIds(tokens),
    mentionUserIds: groupChats ? mentionUserIds(tokens) : [],
    mentionSpans: groupChats ? mentionSpans(tokens) : [],
  };
}
