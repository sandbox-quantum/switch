/**
 * A Claude Code subagent, presented for the create/edit definition form. Since
 * the subagent collapse (CHOO-1440) a subagent is an ordinary switchdash `agent`
 * row carrying a `definitionName`; this shape is the view the panel form builds
 * from that row (its `.claude/agents/<name>.md` definition supplies description /
 * model, loaded on demand when editing).
 */
export type Subagent = {
  /** switchdash id of the parent agent. */
  parentAgentId: string;
  /** Bare subagent name — the `.md` file stem and the `--agent` value. */
  name: string;
  description: string | null;
  model: string | null;
  /** The subagent's own Switch agent id. */
  switchAgentId: string | null;
  apiEndpoint: string | null;
  /** Switch server the subagent belongs to (its parent's server). */
  serverId: string | null;
  /** Whether the subagent is registered on the gateway. */
  registered: boolean | null;
};
