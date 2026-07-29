import { describe, expect, it } from 'vitest';
import {
  agentSettingsRelativePath,
  SWITCH_AGENTS_DIR_RELATIVE,
  SWITCH_AGENTS_GITIGNORE_RELATIVE,
  SWITCH_SETTINGS_RELATIVE_PATH,
  SWITCH_SUBAGENTS_DIR_RELATIVE,
} from './switch-settings-paths';

// These relative paths are handed to a `PluginFs` that may be a remote POSIX
// host over SFTP, so they must never carry a Windows separator. `path.join`
// would, when switchdash itself runs on Windows.
describe('relative Switch settings paths', () => {
  const relatives = {
    SWITCH_SETTINGS_RELATIVE_PATH,
    SWITCH_SUBAGENTS_DIR_RELATIVE,
    SWITCH_AGENTS_DIR_RELATIVE,
    SWITCH_AGENTS_GITIGNORE_RELATIVE,
    'agentSettingsRelativePath()': agentSettingsRelativePath('some-agent'),
  };

  for (const [name, value] of Object.entries(relatives)) {
    it(`${name} uses forward slashes only`, () => {
      expect(value).not.toContain('\\');
    });
  }

  it('resolves to the documented POSIX layout', () => {
    expect(SWITCH_SETTINGS_RELATIVE_PATH).toBe('.claude/settings.local.json');
    expect(SWITCH_SUBAGENTS_DIR_RELATIVE).toBe('.claude/switch-subagents');
    expect(SWITCH_AGENTS_DIR_RELATIVE).toBe('.switch/agents');
    expect(SWITCH_AGENTS_GITIGNORE_RELATIVE).toBe('.switch/agents/.gitignore');
    expect(agentSettingsRelativePath('cc-hoot-main')).toBe('.switch/agents/cc-hoot-main.json');
  });
});
