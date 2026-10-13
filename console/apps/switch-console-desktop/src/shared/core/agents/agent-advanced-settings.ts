/** Where a provider keeps an agent's per-agent settings. */
export type AgentAdvancedSurface = 'definition' | 'launch-profile' | 'none';

/** What a provider's plugin does with an agent's advanced configuration. */
export type AgentAdvancedSettings = {
  /**
   * Where it keeps them. A caller has to treat the two surfaces differently —
   * the renderer offers a restart only for a launch profile, which is read once
   * at spawn and so cannot reach a session already running.
   *
   * Reported rather than inferred from the provider id: that check was
   * `=== 'codex'` for as long as Codex was the only provider with a profile,
   * and silently excluded the next one.
   */
  surface: AgentAdvancedSurface;
  /** The keys of the server's advanced configuration fields it applies. */
  keys: string[];
};
