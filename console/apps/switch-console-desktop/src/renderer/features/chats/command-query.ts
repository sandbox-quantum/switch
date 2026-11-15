import type { ChatCommand } from '@shared/core/chats/chats';

/**
 * The room command being typed: a `!` that starts the message, and the name so
 * far, while the caret is still in it. A `!` anywhere else is just text.
 */
export function commandQuery(text: string, caret: number): { start: 0; query: string } | null {
  if (!text.startsWith('!') || caret < 1) return null;
  const typed = text.slice(1, caret);
  return /\s/.test(typed) ? null : { start: 0, query: typed };
}

/** The commands matching what was typed: those it starts first, then those containing it. */
export function filterCommands(commands: readonly ChatCommand[], query: string): ChatCommand[] {
  const typed = query.toLowerCase();
  const starting = commands.filter((command) => command.name.toLowerCase().startsWith(typed));
  const containing = commands.filter(
    (command) => !starting.includes(command) && command.name.toLowerCase().includes(typed)
  );
  return [...starting, ...containing];
}
