// The renderer's view of `cliConversationListSchema` (agent-providers). The main
// process parses the host's answer with that schema and returns it as this type,
// so the two cannot drift apart without that failing to compile.

/** A conversation started in Claude Code's own CLI, as the new-session dialog offers it. */
export type CliConversation = {
  nativeSessionId: string;
  title: string;
  /** Epoch milliseconds. */
  lastActivityAt: number;
  gitBranch: string | null;
  /** The running Claude Code process that has it open, or null for none. */
  openIn: { pid: number; entrypoint: string | null } | null;
};

export type CliConversationList = {
  /**
   * Whether the agent's Claude Code records which conversations its running
   * processes have open. When it does not, an open one looks closed.
   */
  ownershipKnown: boolean;
  conversations: CliConversation[];
};
