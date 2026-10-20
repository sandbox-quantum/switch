import type { ChatSummary } from '@shared/core/chats/chats';

export type ChatTitlerDeps = {
  title: (message: string) => Promise<string>;
  rename: (serverId: string, roomId: string, name: string) => Promise<void>;
  chat: (roomId: string) => ChatSummary | undefined;
  add: (serverId: string, chat: ChatSummary) => void;
  warn: (message: string, context: Record<string, unknown>) => void;
};

/**
 * Names a direct chat created here without a name from its first message.
 * A failed title leaves the default name, with a warning in the log.
 */
export class ChatTitler {
  // shortcut: held in memory, so a reload before the first message keeps the default name; persist it if that matters.
  private readonly untitled = new Set<string>();

  constructor(private readonly deps: ChatTitlerDeps) {}

  created(chat: ChatSummary, named: boolean): void {
    if (!named && chat.channelType === 'direct') this.untitled.add(chat.roomId);
  }

  async sent(serverId: string, roomId: string, body: string): Promise<void> {
    if (!body.trim() || !this.untitled.delete(roomId)) return;
    const before = this.deps.chat(roomId)?.name;
    try {
      const title = await this.deps.title(body);
      const chat = this.deps.chat(roomId);
      // Renamed by someone while the title was being written: theirs wins.
      if (!chat || chat.name !== before || chat.name === title) return;
      await this.deps.rename(serverId, roomId, title);
      this.deps.add(serverId, { ...chat, name: title });
    } catch (error) {
      this.deps.warn('Could not name the chat from its first message; it keeps its default name.', {
        roomId,
        error: String(error),
      });
    }
  }
}
