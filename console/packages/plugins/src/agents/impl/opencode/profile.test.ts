import { describe, expect, it } from 'vitest';
import {
  buildOpencodeConfig,
  opencodeLaunchProfile,
  opencodeLaunchProfileFields,
  opencodeProfileName,
  opencodeProfilePaths,
} from './profile';

/** An agent working directory; folded into the profile name for uniqueness. */
const WD = '/home/agent/repo';

const HOME = '__SWITCHDASH_HOME__';

const parse = (content: string) => JSON.parse(content) as Record<string, any>;

/** The config file of a profile, parsed. */
function configOf(profile: NonNullable<ReturnType<typeof opencodeLaunchProfile>>) {
  const file = profile.files.find((f) => f.relativePath.endsWith('.json'))!;
  return parse(file.content);
}

describe('opencodeLaunchProfileFields', () => {
  it('declares exactly the keys the config builder consumes', () => {
    expect(opencodeLaunchProfileFields().map((field) => field.key)).toEqual([
      'model',
      'variant',
      'temperature',
      'topP',
      'maxSteps',
      'webSearch',
      'instructions',
    ]);
  });

  it('offers no Codex-only setting, which OpenCode has no key for', () => {
    // Verbosity and reasoning summary exist for Codex and simply do not exist in
    // OpenCode's config; offering them would collect a value that goes nowhere.
    const keys = opencodeLaunchProfileFields().map((field) => field.key);
    expect(keys).not.toContain('verbosity');
    expect(keys).not.toContain('reasoningSummary');
    expect(keys).not.toContain('effort');
  });

  it('leaves reasoning variant as free text, not a fixed list', () => {
    // The accepted values come from the chosen model's own capabilities, so any
    // list hardcoded here would be wrong for most models.
    const variant = opencodeLaunchProfileFields().find((field) => field.key === 'variant')!;
    expect(variant.type).toBe('text');
    expect(variant.options).toBeUndefined();
  });
});

describe('buildOpencodeConfig', () => {
  it('writes settings onto the default agent, which needs no --agent to select', () => {
    const config = parse(
      buildOpencodeConfig({ model: 'anthropic/claude-sonnet-4-5', variant: 'high' }, null)!
    );

    expect(config.agent.build).toEqual({
      model: 'anthropic/claude-sonnet-4-5',
      variant: 'high',
    });
  });

  it('writes sampling settings as numbers, not the strings the form collects', () => {
    const config = parse(
      buildOpencodeConfig({ temperature: '0.2', topP: '0.9', maxSteps: '40' }, null)!
    );

    expect(config.agent.build).toEqual({ temperature: 0.2, top_p: 0.9, maxSteps: 40 });
  });

  it('drops a numeric setting that is not a number rather than writing null', () => {
    // OpenCode ignores a value it cannot use without saying so, so a junk number
    // would be silently inert either way; leaving the key out at least matches
    // what a blank field does.
    expect(buildOpencodeConfig({ temperature: 'hot' }, null)).toBeNull();
  });

  it('writes web search as a tool permission, which is what OpenCode calls it', () => {
    expect(parse(buildOpencodeConfig({ webSearch: 'true' }, null)!).agent.build).toEqual({
      permission: { websearch: 'allow' },
    });
    expect(parse(buildOpencodeConfig({ webSearch: 'false' }, null)!).agent.build).toEqual({
      permission: { websearch: 'deny' },
    });
  });

  it('omits an unset setting so the user’s own config decides', () => {
    // Unset is not off: omitting the key defers to `~/.config/opencode/opencode.json`,
    // writing one overrides it.
    const config = parse(buildOpencodeConfig({ model: 'x', webSearch: '', variant: '  ' }, null)!);
    expect(config.agent.build).toEqual({ model: 'x' });
  });

  it('ignores a value stored under a key OpenCode does not declare', () => {
    // OpenCode drops a config section containing a key it does not recognise —
    // silently, and whole — so a Codex key surviving into an OpenCode config
    // could take the rest of the agent settings with it.
    expect(buildOpencodeConfig({ reasoningSummary: 'detailed', effort: 'high' }, null)).toBeNull();
  });

  it('registers no MCP server: the global config already has the Switch one', () => {
    // OpenCode merges what OPENCODE_CONFIG names onto the config it already
    // loaded, so restating the Switch server here would be a second copy of the
    // runtime pin, free to drift from the one the connector writes.
    const config = parse(buildOpencodeConfig({ model: 'x' }, null)!);
    expect(config.mcp).toBeUndefined();
  });

  it('returns null when nothing is set, so no config file is written', () => {
    expect(buildOpencodeConfig({}, null)).toBeNull();
    expect(buildOpencodeConfig({ model: '   ' }, null)).toBeNull();
  });

  it('references an instructions file rather than inlining a system prompt', () => {
    // OpenCode's per-agent `prompt` supplies the agent's system prompt rather
    // than adding to it, which for a coding agent means losing the operating
    // instructions it needs. Top-level `instructions` is the additive path.
    const config = parse(buildOpencodeConfig({ instructions: 'be terse' }, '/home/a/inst.md')!);

    expect(config.instructions).toEqual(['/home/a/inst.md']);
    expect(config.agent?.build?.prompt).toBeUndefined();
  });
});

describe('opencodeLaunchProfile', () => {
  it('loads the config from the environment, having no flag that would load it', () => {
    const profile = opencodeLaunchProfile({
      slug: 'oc-hoot',
      workingDir: WD,
      values: { model: 'anthropic/claude-sonnet-4-5' },
    })!;

    expect(profile.args).toEqual([]);
    expect(profile.env).toEqual({
      OPENCODE_CONFIG: `${HOME}/.config/opencode/switch/${opencodeProfileName('oc-hoot', WD)}.json`,
    });
  });

  it('keeps a system prompt in a file, off the command line', () => {
    // The argv and env are re-rendered as a shell string on the SSH and tmux
    // paths, so a free-form body there would be mangled or executed.
    const instructions = 'be terse\n$(whoami) and "quotes"';
    const profile = opencodeLaunchProfile({
      slug: 'oc-hoot',
      workingDir: WD,
      values: { instructions },
    })!;

    const file = profile.files.find((f) => f.relativePath.endsWith('.instructions.md'))!;
    expect(file.content).toBe(instructions);
    expect(JSON.stringify(profile.env)).not.toContain('whoami');
    expect(profile.args).toEqual([]);
  });

  it('points the config at the instructions file by absolute path', () => {
    // The config is read from the home directory while the session runs in the
    // repo, so a relative path would resolve against the wrong root.
    const profile = opencodeLaunchProfile({
      slug: 'oc-hoot',
      workingDir: WD,
      values: { instructions: 'be terse' },
    })!;

    const instructionsPath = configOf(profile).instructions[0] as string;
    expect(instructionsPath.startsWith(`${HOME}/`)).toBe(true);
    expect(instructionsPath).toBe(
      `${HOME}/.config/opencode/switch/${opencodeProfileName('oc-hoot', WD)}.instructions.md`
    );
    expect(profile.files.some((f) => f.relativePath === instructionsPath.slice(HOME.length + 1)));
  });

  it('writes no instructions file when there is no system prompt', () => {
    const profile = opencodeLaunchProfile({
      slug: 'oc-hoot',
      workingDir: WD,
      values: { model: 'x' },
    })!;

    expect(profile.files).toHaveLength(1);
    expect(configOf(profile).instructions).toBeUndefined();
  });

  it('returns null when there is nothing to specialize, rather than an empty config', () => {
    // An agent on the defaults needs no file. Writing an empty one would still
    // put OPENCODE_CONFIG in the environment, pointing at nothing.
    expect(opencodeLaunchProfile({ slug: 'a', workingDir: WD, values: {} })).toBeNull();
  });
});

describe('opencodeProfileName', () => {
  it('gives two agents that share a name in different dirs distinct configs', () => {
    // Agent names are unique only within a location, so the working dir must
    // discriminate — otherwise the second launch overwrites the first's config.
    expect(opencodeProfileName('hoot', '/dir/one')).not.toBe(
      opencodeProfileName('hoot', '/dir/two')
    );
  });

  it('is stable for the same (slug, dir)', () => {
    expect(opencodeProfileName('hoot', WD)).toBe(opencodeProfileName('hoot', WD));
  });

  it('keeps slugs that differ only in rewritten characters on distinct configs', () => {
    expect(opencodeProfileName('a.b', WD)).not.toBe(opencodeProfileName('a-b', WD));
  });

  it('rewrites a dotted Switch agent name into a plain filename stem', () => {
    const name = opencodeProfileName('opencode.yak.cmcdermott', WD);
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(name).toContain('opencode-yak-cmcdermott');
  });
});

describe('opencodeProfilePaths', () => {
  it('names both files so teardown takes the instructions with the config', () => {
    const name = opencodeProfileName('oc-hoot', WD);
    expect(opencodeProfilePaths({ slug: 'oc-hoot', workingDir: WD })).toEqual([
      `.config/opencode/switch/${name}.json`,
      `.config/opencode/switch/${name}.instructions.md`,
    ]);
  });

  it('covers every file the profile can write', () => {
    const profile = opencodeLaunchProfile({
      slug: 'oc-hoot',
      workingDir: WD,
      values: { model: 'x', instructions: 'be terse' },
    })!;
    const paths = opencodeProfilePaths({ slug: 'oc-hoot', workingDir: WD });

    for (const file of profile.files) expect(paths).toContain(file.relativePath);
  });

  it('keeps Switch-owned files in their own directory, not among the user’s', () => {
    for (const path of opencodeProfilePaths({ slug: 'oc-hoot', workingDir: WD })) {
      expect(path.startsWith('.config/opencode/switch/')).toBe(true);
    }
  });
});
