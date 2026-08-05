import { parse as parseTOML } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  buildCodexProfileToml,
  CODEX_MCP_STARTUP_TIMEOUT_SEC,
  CODEX_PROFILE_SWITCH_SERVER_NAME,
  CODEX_REASONING_EFFORTS,
  codexLaunchProfile,
  codexProfileName,
  codexProfileRelativePath,
} from './profile';

const runtime = {
  command: 'npx',
  args: ['-y', '@sandbox-quantum/switch-agent-runtime@0.1.2'],
  envVars: ['SWITCH_API_ENDPOINT', 'SWITCH_API_TOKEN', 'SWITCH_AGENT_ID', 'npm_config_userconfig'],
};

type ServerEntry = {
  command: string;
  args: string[];
  env_vars?: string[];
  env?: Record<string, string>;
  bearer_token?: string;
  startup_timeout_sec?: number;
  default_tools_approval_mode?: string;
};

function switchServerOf(toml: string): ServerEntry {
  const parsed = parseTOML(toml) as { mcp_servers: Record<string, ServerEntry> };
  return parsed.mcp_servers[CODEX_PROFILE_SWITCH_SERVER_NAME];
}

describe('buildCodexProfileToml', () => {
  it('registers the Switch runtime as a stdio server', () => {
    const server = switchServerOf(buildCodexProfileToml({ switchServer: runtime }));

    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', '@sandbox-quantum/switch-agent-runtime@0.1.2']);
  });

  it('forwards the env-var names the runtime needs, since Codex passes it none of its own', () => {
    const server = switchServerOf(buildCodexProfileToml({ switchServer: runtime }));

    expect(server.env_vars).toEqual(runtime.envVars);
  });

  it('names credential env vars without carrying one — the profile has no value channel', () => {
    const toml = buildCodexProfileToml({ switchServer: runtime });
    const server = switchServerOf(toml);

    // A name list is the whole mechanism; any of these would be a value channel.
    expect(server.env).toBeUndefined();
    expect(server.bearer_token).toBeUndefined();
    for (const name of server.env_vars ?? []) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
    expect(toml).not.toMatch(/Bearer /);
  });

  it('declares a startup budget a cold npx fetch can finish inside', () => {
    const server = switchServerOf(buildCodexProfileToml({ switchServer: runtime }));

    expect(server.startup_timeout_sec).toBe(CODEX_MCP_STARTUP_TIMEOUT_SEC);
    // Codex defaults to 10s. Fetching the runtime from the private registry on a
    // host that has never run it can exceed that before the server does any work.
    expect(server.startup_timeout_sec).toBeGreaterThanOrEqual(60);
  });

  it('auto-approves the Switch tools, which no approval_policy would have done', () => {
    const server = switchServerOf(buildCodexProfileToml({ switchServer: runtime }));

    // An agent answering a room is unattended: a prompt on `post_message` stops
    // the turn with nobody to release it. Measured against codex-cli 0.146.0,
    // `approval_policy` does not govern MCP tool calls at all — a write-annotated
    // tool is denied under `never` just as under `untrusted` — so the bypass
    // toggle cannot cover this and only this field can.
    expect(server.default_tools_approval_mode).toBe('approve');
  });

  it('keeps the approval mode inside the enum Codex accepts', () => {
    const server = switchServerOf(buildCodexProfileToml({ switchServer: runtime }));

    // An unrecognised value does not fail loudly: Codex drops the whole server
    // and reports no MCP servers at all, so the session simply has no Switch
    // tools. `approve` is also the only one of the four that admits a tool
    // annotated as writing, which most Switch tools are.
    expect(['auto', 'prompt', 'writes', 'approve']).toContain(
      server.default_tools_approval_mode
    );
  });

  it('omits env_vars for a launch server that needs nothing forwarded', () => {
    const server = switchServerOf(
      buildCodexProfileToml({ switchServer: { ...runtime, envVars: [] } })
    );

    expect(server.env_vars).toBeUndefined();
  });

  it('emits model / effort scalars and the system prompt as developer_instructions', () => {
    const parsed = parseTOML(
      buildCodexProfileToml({
        switchServer: runtime,
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
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
    const toml = buildCodexProfileToml({ switchServer: runtime, instructions: 'be terse' });

    expect(toml).not.toContain('model_instructions_file');
    expect(toml).not.toContain('instructions.md');
  });

  it('omits unset specialization keys so the base config default is inherited', () => {
    const parsed = parseTOML(buildCodexProfileToml({ switchServer: runtime })) as Record<
      string,
      unknown
    >;
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

    const parsed = parseTOML(
      buildCodexProfileToml({ switchServer: runtime, instructions: body })
    ) as Record<string, unknown>;

    expect(parsed.developer_instructions).toBe(body);
  });
});

const WD = '/home/agent/repo';

describe('codexLaunchProfile', () => {
  it('writes the profile under ~/.codex keyed on the (dir, slug) and loads with --profile', () => {
    const profile = codexLaunchProfile({
      slug: 'codex-hoot',
      workingDir: WD,
      switchServer: runtime,
    });
    expect(profile).not.toBeNull();
    expect(profile!.args).toEqual(['--profile', codexProfileName('codex-hoot', WD)]);
    expect(profile!.files).toEqual([
      {
        relativePath: codexProfileRelativePath('codex-hoot', WD),
        content: expect.stringContaining('[mcp_servers.switch]'),
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
      switchServer: runtime,
      instructions,
    })!;

    expect(profile.files).toHaveLength(1);
    expect(profile.files[0].relativePath).toBe(codexProfileRelativePath('codex-hoot', WD));
    const parsed = parseTOML(profile.files[0].content) as Record<string, unknown>;
    expect(parsed.developer_instructions).toBe(instructions);
    expect(profile.args).toEqual(['--profile', codexProfileName('codex-hoot', WD)]);
    expect(profile.args.join(' ')).not.toContain('whoami');
  });

  it('returns a profile for specialization even without a Switch identity', () => {
    const profile = codexLaunchProfile({
      slug: 'a',
      workingDir: WD,
      switchServer: null,
      model: 'gpt-5.6-terra',
    });
    expect(profile).not.toBeNull();
    expect(profile!.files[0].content).toContain('model = "gpt-5.6-terra"');
    expect(profile!.files[0].content).not.toContain('mcp_servers');
  });

  it('returns null when there is nothing to register or specialize', () => {
    expect(codexLaunchProfile({ slug: 'a', workingDir: WD, switchServer: null })).toBeNull();
  });

  it('exposes the stable reasoning-effort levels', () => {
    expect(CODEX_REASONING_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
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
      switchServer: runtime,
      instructions: 'be terse',
    })!;
    const name = codexProfileName(slug, WD);

    expect(profile.args).toEqual(['--profile', name]);
    expect(profile.files.map((file) => file.relativePath)).toEqual([`.codex/${name}.config.toml`]);
    expect(profile.files[0].content).toContain('developer_instructions = "be terse"');
  });
});
