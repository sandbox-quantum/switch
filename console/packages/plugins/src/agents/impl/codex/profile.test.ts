import { parse as parseTOML } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  buildCodexProfileToml,
  CODEX_REASONING_EFFORTS,
  CODEX_REASONING_SUMMARIES,
  CODEX_VERBOSITY_LEVELS,
  codexLaunchProfile,
  codexLaunchProfileFields,
  codexProfileName,
  codexProfileRelativePath,
} from './profile';

describe('buildCodexProfileToml', () => {
  it('registers no MCP server — the connector plugin owns that now', () => {
    // The plugin's bundled `.mcp.json` declares the Switch server, so writing it
    // here too would duplicate it for Switch Console sessions only. Nothing may be
    // layered onto a plugin-provided server either: any `mcp_servers.switch.*`
    // without a transport of its own makes Codex reject the whole config
    // ("invalid transport"), taking the session with it.
    const toml = buildCodexProfileToml({
      model: 'gpt-5.6-terra',
      effort: 'high',
      instructions: 'be terse',
    });

    expect(toml).not.toContain('mcp_servers');
    expect(toml).not.toContain('switch-agent-runtime');
  });

  it('carries no credential, and no channel that could hold one', () => {
    const toml = buildCodexProfileToml({
      model: 'gpt-5.6-terra',
      instructions: 'be terse',
    });

    // The file is baked into launch specs and shipped to VMs, so it must stay
    // safe to write anywhere.
    expect(toml).not.toMatch(/Bearer /);
    expect(toml).not.toContain('SWITCH_API_TOKEN');
    expect(toml).not.toContain('env_vars');
  });

  it('emits model / effort scalars and the system prompt as developer_instructions', () => {
    const parsed = parseTOML(
      buildCodexProfileToml({
        model: 'gpt-5.6-terra',
        effort: 'high',
        instructions: 'be terse',
      })
    ) as Record<string, unknown>;

    expect(parsed.model).toBe('gpt-5.6-terra');
    expect(parsed.model_reasoning_effort).toBe('high');
    expect(parsed.developer_instructions).toBe('be terse');
  });

  it('never references an instructions file, which would replace Codex’s own manual', () => {
    // Measured on codex-cli 0.146.0: with `model_instructions_file` set, the
    // request's `instructions` is the file and nothing else — the 20,751-char
    // operating manual (exec/apply_patch protocol, sandbox escalation, planning
    // tool, final-answer formatting) is gone. `developer_instructions` leaves it
    // intact and adds a developer message, which is what the UI promises.
    const toml = buildCodexProfileToml({ instructions: 'be terse' });

    expect(toml).not.toContain('model_instructions_file');
    expect(toml).not.toContain('instructions.md');
  });

  it('omits unset specialization keys so the base config default is inherited', () => {
    const parsed = parseTOML(buildCodexProfileToml({})) as Record<string, unknown>;
    expect(parsed.model).toBeUndefined();
    expect(parsed.model_reasoning_effort).toBeUndefined();
    expect(parsed.developer_instructions).toBeUndefined();
  });

  it('round-trips a hostile multi-line body through TOML unchanged', () => {
    // The body is free-form user text and reaches the VM as file content — over
    // SFTP, base64 over SSH, or baked into the sidecar's launch spec. TOML
    // escaping has to be lossless for all of it, including the characters a
    // shell would eat if this ever moved onto argv.
    const body = [
      'line with "double quotes" and \'single\'',
      '$(whoami) `id -u` ${HOME}',
      'back\\slash and\ttab',
      'a """ triple quote and a # hash and [a table]',
      'trailing newline follows',
      '',
    ].join('\n');

    const parsed = parseTOML(buildCodexProfileToml({ instructions: body })) as Record<
      string,
      unknown
    >;

    expect(parsed.developer_instructions).toBe(body);
  });
});

const WD = '/home/agent/repo';

describe('codexLaunchProfile', () => {
  it('writes the profile under ~/.codex keyed on the (dir, slug) and loads with --profile', () => {
    const profile = codexLaunchProfile({
      slug: 'codex-hoot',
      workingDir: WD,
      model: 'gpt-5.6-terra',
    });
    expect(profile).not.toBeNull();
    expect(profile!.args).toEqual(['--profile', codexProfileName('codex-hoot', WD)]);
    expect(profile!.files).toEqual([
      {
        relativePath: codexProfileRelativePath('codex-hoot', WD),
        content: expect.stringContaining('model = "gpt-5.6-terra"'),
      },
    ]);
    expect(codexProfileRelativePath('codex-hoot', WD)).toBe(
      `.codex/${codexProfileName('codex-hoot', WD)}.config.toml`
    );
  });

  it('keeps a system prompt inside the one profile file, off the command line', () => {
    // The argv is re-rendered as a shell string on the SSH and tmux paths, so a
    // free-form body there would be mangled (newlines flattened) or executed
    // (`$(…)`, backticks). Two fixed tokens is the whole command-line surface.
    const instructions = 'be terse\n$(whoami) and "quotes"';
    const profile = codexLaunchProfile({
      slug: 'codex-hoot',
      workingDir: WD,
      instructions,
    })!;

    expect(profile.files).toHaveLength(1);
    expect(profile.files[0].relativePath).toBe(codexProfileRelativePath('codex-hoot', WD));
    const parsed = parseTOML(profile.files[0].content) as Record<string, unknown>;
    expect(parsed.developer_instructions).toBe(instructions);
    expect(profile.args).toEqual(['--profile', codexProfileName('codex-hoot', WD)]);
    expect(profile.args.join(' ')).not.toContain('whoami');
  });

  it('returns a profile for specialization alone', () => {
    const profile = codexLaunchProfile({ slug: 'a', workingDir: WD, model: 'gpt-5.6-terra' });
    expect(profile).not.toBeNull();
    expect(profile!.files[0].content).toContain('model = "gpt-5.6-terra"');
    expect(profile!.files[0].content).not.toContain('mcp_servers');
  });

  it('returns null when there is nothing to specialize, rather than an empty profile', () => {
    // An agent on the defaults needs no file. Writing an empty one would still
    // put `--profile <name>` on the command line, pointing at nothing.
    expect(codexLaunchProfile({ slug: 'a', workingDir: WD })).toBeNull();
  });

  it('exposes the stable reasoning-effort levels', () => {
    expect(CODEX_REASONING_EFFORTS).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('codexProfileName', () => {
  it('rewrites a dotted Switch agent name onto the alphabet Codex accepts', () => {
    const name = codexProfileName('codex.yak.cmcdermott', WD);
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(name).toContain('codex-yak-cmcdermott');
  });

  it('gives two agents that share a name in different dirs distinct profiles', () => {
    // Agent names are unique only within a location, so the working dir must
    // discriminate — otherwise the second launch overwrites the first's profile.
    expect(codexProfileName('hoot', '/dir/one')).not.toBe(codexProfileName('hoot', '/dir/two'));
  });

  it('is stable for the same (slug, dir)', () => {
    expect(codexProfileName('hoot', WD)).toBe(codexProfileName('hoot', WD));
  });

  it('keeps slugs that differ only in rewritten characters on distinct profiles', () => {
    expect(codexProfileName('a.b', WD)).not.toBe(codexProfileName('a-b', WD));
  });

  it('drives the profile file and the --profile argv from the same name', () => {
    const slug = 'codex.yak.cmcdermott';
    const profile = codexLaunchProfile({
      slug,
      workingDir: WD,
      instructions: 'be terse',
    })!;
    const name = codexProfileName(slug, WD);

    expect(profile.args).toEqual(['--profile', name]);
    expect(profile.files.map((file) => file.relativePath)).toEqual([`.codex/${name}.config.toml`]);
    expect(profile.files[0].content).toContain('developer_instructions = "be terse"');
  });
});

describe('codexLaunchProfileFields', () => {
  it('declares exactly the keys the profile builder consumes', () => {
    expect(codexLaunchProfileFields().map((field) => field.key)).toEqual([
      'model',
      'effort',
      'verbosity',
      'reasoningSummary',
      'webSearch',
      'instructions',
    ]);
  });

  it('offers every reasoning effort the profile accepts, plus an unset default', () => {
    const effort = codexLaunchProfileFields().find((field) => field.key === 'effort');

    expect(effort?.options?.map((option) => option.value)).toEqual([
      '',
      ...CODEX_REASONING_EFFORTS,
    ]);
  });

  it('writes every declared field, so a field cannot be collected and then dropped', () => {
    const filled = Object.fromEntries(
      codexLaunchProfileFields().map((field) => [
        field.key,
        field.key === 'webSearch' ? 'true' : 'x',
      ])
    );

    const toml = parseTOML(buildCodexProfileToml(filled));

    expect(Object.keys(toml).sort()).toEqual([
      'developer_instructions',
      'model',
      'model_reasoning_effort',
      'model_reasoning_summary',
      'model_verbosity',
      'tools',
    ]);
    expect((toml.tools as Record<string, unknown>).web_search).toBe(true);
  });

  it('offers only the verbosity and summary values Codex accepts', () => {
    const optionsFor = (key: string) =>
      codexLaunchProfileFields()
        .find((field) => field.key === key)
        ?.options?.map((option) => option.value);

    expect(optionsFor('verbosity')).toEqual(['', ...CODEX_VERBOSITY_LEVELS]);
    expect(optionsFor('reasoningSummary')).toEqual(['', ...CODEX_REASONING_SUMMARIES]);
  });

  it('turns web search off explicitly, which is not the same as leaving it unset', () => {
    const off = parseTOML(buildCodexProfileToml({ webSearch: 'false' }));
    expect((off.tools as Record<string, unknown>).web_search).toBe(false);

    // Unset writes nothing at all, so the user's own config still decides.
    // An empty profile still stringifies to a newline, which is why the
    // no-profile check in `codexLaunchProfile` tests the trimmed result.
    expect(buildCodexProfileToml({ webSearch: '' }).trim()).toBe('');
  });
});
