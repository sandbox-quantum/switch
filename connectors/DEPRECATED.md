# Deprecated: kept only for Switch Console 0.35 and older

Switch Console 0.36 and later do not use these plugins: every session gets the
Switch tools from its own session host and the Switch skill from Console
(`console/packages/plugins/src/switch-skill/SKILL.md`).

`claude-code-plugin/` and `codex-plugin/` stay, with
`.claude-plugin/marketplace.json`, because Consoles 0.35 and older still install
them from this branch and will not offer a Claude Code or Codex agent without
them. Deleting them does not fail cleanly: where the Claude plugin is already
installed, Claude Code keeps listing it as installed but stops loading it, so
sessions run without the Switch tools or the tool-mediation hook and nothing
says so.

Both are frozen — not maintained, tested or published. Known defects in the
hook's identity resolution (CHOO-2200, CHOO-2201) will not be fixed here. Remove
both, and the marketplace file, once no Console 0.35 or older is in use.
