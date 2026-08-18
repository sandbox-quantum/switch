/**
 * Write the connector into an OpenCode config directory: the Switch MCP entry
 * merged into `opencode.json`, every skill the package ships, and a record of
 * what was written. Returns the paths it wrote.
 *
 * Refuses, before writing anything, on a config it cannot safely edit — one
 * that is not valid JSON, whose root is not an object, or whose `mcp` is not
 * an object — and on a skill file it did not write itself.
 */
export function install(configDir: string): Promise<string[]>;

/**
 * Reverse an install, leaving the user's own config and MCP servers intact.
 *
 * Removes only skills a Switch install put there — recorded, or written by
 * Switch Console, or byte-identical to what this package ships — and only the
 * `SKILL.md` in each, so anything the user keeps beside one survives. Skill
 * files it will not claim come back in `left` rather than being abandoned
 * without a word.
 */
export function uninstall(configDir: string): Promise<{
  removedSkills: string[];
  left: string[];
}>;

/**
 * The version recorded at install, or null when the connector is not installed
 * — including when the record survives but the MCP server no longer does.
 */
export function installedVersion(configDir: string): Promise<string | null>;
