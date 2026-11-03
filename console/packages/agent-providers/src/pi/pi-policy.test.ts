import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeMode } from '../adapter';
import type { PiBridgeToolServer } from './bridge';
import {
  decidePiToolCall,
  piMcpToolOwner,
  piWriteTarget,
  type PiPolicyCall,
  type PiPolicyDecision,
  type PiPolicySession,
} from './pi-policy';

/**
 * READY §5 (`pi-policy.test.ts`), SC5 (`10_implementation_plan.md:77`), ER-03 and ER-05:
 * mode × tool × origin; Switch's own servers never ask; a connector asks outside `full-access`
 * and names itself; `auto` asks like `approval-required`; a tool that only looks like MCP asks;
 * the MCP resource tools ask and name the connector; `auto-accept-edits` writes only inside
 * `cwd` and never into Switch's state.
 *
 * Owner metadata as Pi 1.4.0 reports it (recorded `evidence/probes/p06/notes-collide-reg.jsonl`:
 * `namespace: { name: 'mcp__team_docs', aliases: ['team-docs'] }`, `sourceInfo.path:
 * 'builtin:mcp'`).
 */

const MODES: RuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'];

let root = '';
let home = '';
let hostHome = '';
let cwd = '';
let state = '';
let outside = '';

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-policy-')));
  if (!root) throw new Error('setup: no temporary directory');
  home = join(root, 'home');
  hostHome = join(root, 'hosthome');
  cwd = join(root, 'work');
  state = join(home, '.local', 'state', 'switch');
  outside = join(root, 'outside');
  for (const dir of [
    join(state, 'pi', 'agent'),
    join(hostHome, '.local', 'state', 'switch', 'pi'),
    join(cwd, 'src'),
    outside,
    join(root, 'extra-state'),
  ])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.ts'), 'a');
  writeFileSync(join(outside, 'x.txt'), 'x');
  writeFileSync(join(state, 'pi', 'agent', 'settings.json'), '{}');
  symlinkSync(outside, join(cwd, 'link-out'));
  symlinkSync(join(cwd, 'src'), join(cwd, 'link-in'));
  symlinkSync(state, join(cwd, 'link-state'));
  symlinkSync(join(hostHome, '.local', 'state', 'switch'), join(cwd, 'link-hoststate'));
  symlinkSync(join(root, 'extra-state'), join(cwd, 'link-extra'));
  symlinkSync(join(root, 'nowhere', 'file'), join(cwd, 'dangling'));
  symlinkSync(join(outside, 'x.txt'), join(cwd, 'file-out'));
  symlinkSync(join(cwd, 'loop-b'), join(cwd, 'loop-a'));
  symlinkSync(join(cwd, 'loop-a'), join(cwd, 'loop-b'));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function session(
  runtimeMode: RuntimeMode,
  overrides: Partial<PiPolicySession> = {}
): PiPolicySession {
  return {
    runtimeMode,
    cwd,
    mcpServers: ['switch', 'echo', 'team-docs', 'atlassian'],
    connectorMcpServers: ['atlassian'],
    env: { HOME: home },
    hostHome,
    protectedRoots: [join(root, 'extra-state')],
    ...overrides,
  };
}

function owner(alias: string, overrides: Partial<PiBridgeToolServer> = {}): PiBridgeToolServer {
  return {
    namespace: `mcp__${alias.replace(/-/g, '_')}`,
    aliases: [alias],
    sourcePath: 'builtin:mcp',
    ...overrides,
  };
}

function call(
  toolName: string,
  input: unknown = {},
  server: PiBridgeToolServer | null = null
): PiPolicyCall {
  return { toolName, toolCallId: 'toolu_1', server, input };
}

/** `allow`, or `ask` with the connector the card names (`-` for none). */
function summary(decision: PiPolicyDecision): string {
  if (decision.kind === 'ask') return `ask:${decision.connector ?? '-'}`;
  return decision.kind;
}

describe('MCP tools: mode × origin (rules 2, 3, 6; ER-05)', () => {
  // [origin, call, expected per mode: approval-required, auto-accept-edits, auto, full-access]
  const cases: Array<[string, () => PiPolicyCall, [string, string, string, string]]> = [
    [
      'switch (own, auto-approved)',
      () => call('mcp__switch__post', { text: 'hi' }, owner('switch')),
      ['allow', 'allow', 'allow', 'allow'],
    ],
    [
      'echo (session server, auto-approved)',
      () => call('mcp__echo__echo', { text: 'hi' }, owner('echo')),
      ['allow', 'allow', 'allow', 'allow'],
    ],
    [
      'team-docs (dash in the name)',
      () => call('mcp__team_docs__search', {}, owner('team-docs')),
      ['allow', 'allow', 'allow', 'allow'],
    ],
    [
      'atlassian (connector)',
      () => call('mcp__atlassian__search', { q: 'x' }, owner('atlassian')),
      ['ask:atlassian', 'ask:atlassian', 'ask:atlassian', 'allow'],
    ],
    [
      'MCP-like name without a namespace',
      () => call('mcp__switch__post', {}, null),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'namespace from another source',
      () => call('mcp__switch__post', {}, owner('switch', { sourcePath: '/ext/evil.mjs' })),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'no source path',
      () => call('mcp__switch__post', {}, owner('switch', { sourcePath: null })),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'alias that is not a session server',
      () => call('mcp__other__x', {}, owner('other')),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'alias that does not match the namespace',
      () => call('mcp__switch__post', {}, owner('switch', { aliases: ['atlassian'] })),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'namespace that does not match its alias',
      () => call('mcp__switch__post', {}, owner('switch', { namespace: 'mcp__evil' })),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'two aliases',
      () => call('mcp__switch__post', {}, owner('switch', { aliases: ['switch', 'echo'] })),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'no alias',
      () => call('mcp__switch__post', {}, owner('switch', { aliases: [] })),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'name outside its namespace',
      () => call('mcp__atlassian__search', {}, owner('switch')),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'bare namespace as the name',
      () => call('mcp__switch__', {}, owner('switch')),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'connector tool reported under an auto-approved alias',
      () => call('mcp__atlassian__search', {}, owner('atlassian', { aliases: ['switch'] })),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'resource tool on a connector',
      () => call('read_mcp_resource', { server: 'atlassian', uri: 'a://1' }),
      ['ask:atlassian', 'ask:atlassian', 'ask:atlassian', 'allow'],
    ],
    [
      'resource tool on Switch',
      () => call('read_mcp_resource', { server: 'switch', uri: 's://1' }),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'resource listing of every server',
      () => call('list_mcp_resources', {}),
      ['ask:atlassian', 'ask:atlassian', 'ask:atlassian', 'allow'],
    ],
    [
      'resource templates of every server',
      () => call('list_mcp_resource_templates', {}),
      ['ask:atlassian', 'ask:atlassian', 'ask:atlassian', 'allow'],
    ],
    [
      'resource tool on an unknown server',
      () => call('read_mcp_resource', { server: 'nope', uri: 'n://1' }),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      'resource tool with a namespace (not builtin)',
      () => call('read_mcp_resource', { server: 'switch' }, owner('switch')),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
  ];
  const rows = cases.flatMap(([origin, make, expected]) =>
    MODES.map((mode, index) => [origin, mode, make, expected[index]] as const)
  );
  it.each(rows)('%s in %s → %s', (_origin, mode, make, expected) => {
    expect(summary(decidePiToolCall(session(mode), make()))).toBe(expected);
  });

  it('a resource listing with no connector in the session names none', () => {
    const decision = decidePiToolCall(
      session('auto', { connectorMcpServers: [] }),
      call('list_mcp_resources')
    );
    expect(decision).toMatchObject({
      kind: 'ask',
      rule: 'mcp-resource',
      requestType: 'mcp_tool_approval',
    });
    expect(decision).not.toHaveProperty('connector');
  });

  it('cards for MCP tools are MCP approvals with the server and tool in the title', () => {
    const decision = decidePiToolCall(
      session('approval-required'),
      call('mcp__atlassian__search', { q: 'open issues' }, owner('atlassian'))
    );
    expect(decision).toEqual({
      kind: 'ask',
      rule: 'connector',
      requestType: 'mcp_tool_approval',
      title: 'atlassian wants to run search',
      detail: '{"q":"open issues"}',
      connector: 'atlassian',
      options: [
        { decision: 'accept', label: 'Allow once' },
        { decision: 'decline', label: 'Decline' },
        { decision: 'cancel', label: 'Cancel' },
      ],
    });
    const unknown = decidePiToolCall(session('auto'), call('mcp__switch__post', {}, null));
    expect(unknown).toMatchObject({
      rule: 'mcp-unresolved-owner',
      requestType: 'mcp_tool_approval',
    });
  });

  it('two session servers with one namespace leave the owner unresolved', () => {
    const servers = ['team-docs', 'team_docs'];
    expect(
      piMcpToolOwner(call('mcp__team_docs__x', {}, owner('team-docs')), servers)
    ).toBeUndefined();
    expect(piMcpToolOwner(call('mcp__team_docs__x', {}, owner('team-docs')), ['team-docs'])).toBe(
      'team-docs'
    );
  });

  it('a long server name: a cut name keeps the first 55 characters of the whole name', () => {
    const long = `s${'x'.repeat(60)}`;
    const cutName = `mcp__${long}`.slice(0, 55) + '_0123abcd';
    expect(cutName).toHaveLength(64);
    expect(piMcpToolOwner(call(cutName, {}, owner(long)), [long])).toBe(long);
    expect(piMcpToolOwner(call('short', {}, owner(long)), [long])).toBeUndefined();
  });

  // Pi 1.4.0 `createMcpToolName` (`tools.js:45-51`) for a server `a` + `b`… whose prefix
  // (`mcp__<alias>__`) has `length` characters. Pi keeps a whole name of at most 64 characters
  // whatever the prefix (`:47`), and cuts a longer or taken one to its first 55 characters, `_` and
  // eight hex digits (`:48-50`). The hashes are what Pi's own function returned for the tool `x`
  // when another tool took its name (`taken`) and for the tool `y` × 64 (`long`).
  const longAlias = (length: number) => `a${'b'.repeat(length - 8)}`;
  const piCuts: Array<[number, string, string]> = [
    [54, '0576fa4f', '5f7aa9cc'],
    [55, '56997395', '7d4880d0'],
    [56, 'c610145d', '46b8c18a'],
    [60, 'a050a93a', 'a72b3d40'],
    [63, 'b8ea3db0', 'e9ccf6f5'],
    [64, '794a879e', 'a1104b48'],
  ];
  it.each(piCuts)(
    'a %i-character prefix: every name Pi gives is the alias’s',
    (length, taken, long) => {
      const alias = longAlias(length);
      const prefix = `mcp__${alias}__`;
      expect(prefix).toHaveLength(length);
      const ownerOf = (name: string) => piMcpToolOwner(call(name, {}, owner(alias)), [alias]);
      const cut = (tool: string, hash: string) => `${prefix}${tool}`.slice(0, 55) + `_${hash}`;
      if (length < 64) {
        // Kept whole: `x`, and a tool that makes the name exactly 64 characters.
        expect(ownerOf(`${prefix}x`)).toBe(alias);
        expect(ownerOf(`${prefix}${'y'.repeat(64 - length)}`)).toBe(alias);
      } else {
        // `x` makes 65 characters, which Pi never gives (it cuts it to `taken`).
        expect(ownerOf(`${prefix}x`)).toBeUndefined();
      }
      expect(cut('x', taken)).toHaveLength(64);
      expect(ownerOf(cut('x', taken))).toBe(alias);
      expect(ownerOf(cut('y'.repeat(64), long))).toBe(alias);
      expect(ownerOf(prefix)).toBeUndefined();
      expect(ownerOf(`mcp__other__${'z'.repeat(52)}`)).toBeUndefined();
      // Over 64 characters, even with a suffix like Pi's.
      expect(ownerOf(`${prefix}${'y'.repeat(64)}_${long}`)).toBeUndefined();
    }
  );

  // A prefix of more than 55 characters is not whole in a cut name, so the start Pi keeps and the
  // suffix are all that tell a cut name of this server from another 64-character name.
  it.each([60, 63, 64])(
    'a %i-character prefix: other 64-character names have no owner',
    (length) => {
      const alias = longAlias(length);
      const kept = `mcp__${alias}__`.slice(0, 55);
      const ownerOf = (name: string) => piMcpToolOwner(call(name, {}, owner(alias)), [alias]);
      const names = [
        `mcp__other__`.padEnd(55, 'z') + '_a72b3d40', // a foreign start, a suffix like Pi's
        `${kept.slice(0, 54)}c_a72b3d40`, // the last kept character differs
        `${kept}xa72b3d40`, // no `_` before the hash
        `${kept}_A72B3D40`, // upper-case hex
        `${kept}_a72b3d4g`, // not hex
        `${kept}y_a72b3d4`, // seven hex digits
      ];
      for (const name of names) {
        expect(name).toHaveLength(64);
        expect(ownerOf(name)).toBeUndefined();
      }
      expect(ownerOf(`${kept}_a72b3d40`)).toBe(alias);
    }
  );

  it('a short name another tool took is cut too and keeps its owner (`tools.js:47`)', () => {
    // `createMcpToolName('echo', 'a-b', () => true)` in Pi 1.4.0.
    const taken = 'mcp__echo__a_b_6e4d3e73';
    expect(taken.length).toBeLessThan(64);
    expect(piMcpToolOwner(call(taken, {}, owner('echo')), ['echo'])).toBe('echo');
    expect(
      piMcpToolOwner(call('mcp__other__a_b_6e4d3e73', {}, owner('echo')), ['echo'])
    ).toBeUndefined();
  });

  // Pi turns everything but `[A-Za-z0-9_]` into `_` (`tools.js:46`), so a name with any other
  // character is none Pi gives; the name Pi gives for the same tool keeps its owner.
  const unsanitized: Array<[string, string]> = [
    ['a-b', 'a_b'],
    ['a/b', 'a_b'],
    ['a b', 'a_b'],
    ['ą', '_'],
    ['a\u0007b', 'a_b'],
    ['a\nb', 'a_b'],
  ];
  const unsanitizedCases = ['echo', longAlias(60)].flatMap((alias) =>
    unsanitized.map(([raw, pi]) => [alias.length, alias, raw, pi] as const)
  );
  it.each(unsanitizedCases)(
    'a %i-character server: a tool name with a character Pi replaces has no owner (%#)',
    (_length, alias, raw, pi) => {
      const prefix = `mcp__${alias}__`;
      const ownerOf = (name: string) => piMcpToolOwner(call(name, {}, owner(alias)), [alias]);
      expect(`${prefix}${raw}`.length).toBeLessThanOrEqual(64);
      expect(ownerOf(`${prefix}${raw}`)).toBeUndefined();
      expect(ownerOf(`${prefix}${pi}`)).toBe(alias);
      // The server auto-approved: a card outside `full-access`, never rule 2.
      for (const mode of MODES) {
        const decision = decidePiToolCall(
          session(mode, { mcpServers: ['switch', alias], connectorMcpServers: [] }),
          call(`${prefix}${raw}`, {}, owner(alias))
        );
        if (mode === 'full-access')
          expect(decision).toEqual({ kind: 'allow', rule: 'full-access' });
        else
          expect(decision).toMatchObject({
            kind: 'ask',
            rule: 'mcp-unresolved-owner',
            requestType: 'mcp_tool_approval',
          });
        expect(
          decidePiToolCall(
            session(mode, { mcpServers: ['switch', alias], connectorMcpServers: [] }),
            call(`${prefix}${pi}`, {}, owner(alias))
          )
        ).toEqual({ kind: 'allow', rule: 'auto-approved-server' });
      }
    }
  );

  it('a character Pi replaces in the server part has no owner either', () => {
    // Pi refuses such a server name (`core/mcp-servers.js:48`) and would name its tool `mcp__a_b__x`.
    expect(piMcpToolOwner(call('mcp__a.b__x', {}, owner('a.b')), ['a.b'])).toBeUndefined();
    expect(piMcpToolOwner(call('mcp__a b__x', {}, owner('a b')), ['a b'])).toBeUndefined();
  });

  // The decision itself for a server with a long prefix: rule 2 for one the session auto-approves,
  // a card naming the connector for a connector.
  const longDecisions = [56, 60, 63].flatMap((length) =>
    MODES.map((mode) => [length, mode] as const)
  );
  it.each(longDecisions)('a %i-character prefix in %s', (length, mode) => {
    const alias = longAlias(length);
    const prefix = `mcp__${alias}__`;
    const hash = piCuts.find(([l]) => l === length)?.[2] ?? '';
    for (const name of [`${prefix}x`, `${prefix}${'y'.repeat(64)}`.slice(0, 55) + `_${hash}`]) {
      const own = decidePiToolCall(
        session(mode, { mcpServers: ['switch', alias], connectorMcpServers: [] }),
        call(name, {}, owner(alias))
      );
      expect(own).toEqual({ kind: 'allow', rule: 'auto-approved-server' });
      const connector = decidePiToolCall(
        session(mode, { mcpServers: ['switch', alias], connectorMcpServers: [alias] }),
        call(name, {}, owner(alias))
      );
      if (mode === 'full-access') expect(connector).toEqual({ kind: 'allow', rule: 'full-access' });
      else
        expect(connector).toMatchObject({
          kind: 'ask',
          rule: 'connector',
          requestType: 'mcp_tool_approval',
          connector: alias,
        });
    }
  });

  // An MCP tool named like one of Pi's own takes the MCP rules (rule 2 or a card), never rules 4-6.
  const builtinNamed = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'].flatMap((tool) =>
    MODES.map((mode) => [tool, mode] as const)
  );
  it.each(builtinNamed)('%s reported with an MCP server in %s is an MCP tool', (tool, mode) => {
    const input = tool === 'bash' ? { command: 'ls' } : { path: 'src/a.ts', content: 'x' };
    const decision = decidePiToolCall(session(mode), call(tool, input, owner('switch')));
    if (mode === 'full-access') expect(decision).toEqual({ kind: 'allow', rule: 'full-access' });
    else
      expect(decision).toMatchObject({
        kind: 'ask',
        rule: 'mcp-unresolved-owner',
        requestType: 'mcp_tool_approval',
      });
  });
});

describe('MCP resource tools: the server Pi reads (ER-05)', () => {
  // The first connector of this session is `jira`, so a fallback is told apart from `atlassian`.
  const withTwo = (mode: RuntimeMode) =>
    session(mode, {
      mcpServers: ['switch', 'jira', 'atlassian'],
      connectorMcpServers: ['jira', 'atlassian'],
    });
  // [input.server, connector on the card, server in the title]
  const cases: Array<[string, unknown, string, string]> = [
    ['"atlassian"', 'atlassian', 'atlassian', 'atlassian'],
    ['" atlassian "', ' atlassian ', 'atlassian', 'atlassian'],
    ['"\\tatlassian\\n"', '\tatlassian\n', 'atlassian', 'atlassian'],
    ['"" (every server)', '', 'jira', 'MCP resources'],
    ['"   " (every server)', '   ', 'jira', 'MCP resources'],
    ['no field (every server)', undefined, 'jira', 'MCP resources'],
    ['null (every server)', null, 'jira', 'MCP resources'],
    ['not a string (Pi refuses it)', 42, 'jira', 'MCP resources'],
    ['" switch " (not a connector)', ' switch ', '-', 'switch'],
  ];
  const rows = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].flatMap(
    (tool) =>
      cases.map(
        ([name, server, connector, title]) => [tool, name, server, connector, title] as const
      )
  );
  it.each(rows)('%s with server %s → connector %s', (tool, _name, server, connector, title) => {
    const input = server === undefined ? { uri: 'a://1' } : { server, uri: 'a://1' };
    const decision = decidePiToolCall(withTwo('approval-required'), call(tool, input));
    expect(summary(decision)).toBe(`ask:${connector}`);
    expect(decision).toMatchObject({
      rule: 'mcp-resource',
      title: `${title} wants to run ${tool}`,
      detail: JSON.stringify(input),
    });
  });
});

describe("Pi's own tools: mode × tool (rules 3–6)", () => {
  const inside = () => ({ path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] });
  const cases: Array<[string, () => PiPolicyCall, [string, string, string, string]]> = [
    ['bash', () => call('bash', { command: 'ls' }), ['ask:-', 'ask:-', 'ask:-', 'allow']],
    ['read', () => call('read', { path: '/etc/hostname' }), ['allow', 'allow', 'allow', 'allow']],
    ['grep', () => call('grep', { pattern: 'x' }), ['allow', 'allow', 'allow', 'allow']],
    ['find', () => call('find', { pattern: '*.ts' }), ['allow', 'allow', 'allow', 'allow']],
    ['ls', () => call('ls', {}), ['allow', 'allow', 'allow', 'allow']],
    ['edit inside cwd', () => call('edit', inside()), ['ask:-', 'allow', 'ask:-', 'allow']],
    [
      'write inside cwd',
      () => call('write', { path: 'src/new.ts', content: 'x' }),
      ['ask:-', 'allow', 'ask:-', 'allow'],
    ],
    [
      'write outside cwd',
      () => call('write', { path: '../outside/y.txt', content: 'x' }),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    [
      "write into Switch's state",
      () => call('write', { path: `${state}/pi/agent/settings.json`, content: '{}' }),
      ['ask:-', 'ask:-', 'ask:-', 'allow'],
    ],
    ['another tool', () => call('todo', { item: 'x' }), ['ask:-', 'ask:-', 'ask:-', 'allow']],
  ];
  const rows = cases.flatMap(([tool, make, expected]) =>
    MODES.map((mode, index) => [tool, mode, make, expected[index]] as const)
  );
  it.each(rows)('%s in %s → %s', (_tool, mode, make, expected) => {
    expect(summary(decidePiToolCall(session(mode), make()))).toBe(expected);
  });

  it('request types follow the tool', () => {
    const type = (c: PiPolicyCall) => {
      const decision = decidePiToolCall(session('approval-required'), c);
      return decision.kind === 'ask' ? decision.requestType : decision.kind;
    };
    expect(type(call('bash', { command: 'ls' }))).toBe('command_execution_approval');
    expect(type(call('edit', inside()))).toBe('file_change_approval');
    expect(type(call('write', { path: 'x', content: '' }))).toBe('file_change_approval');
    expect(type(call('todo', {}))).toBe('tool_approval');
  });

  it('a command card titles the command and shows it as the detail, cut with a note', () => {
    const decision = decidePiToolCall(session('auto'), call('bash', { command: 'echo hi' }));
    expect(decision).toMatchObject({ title: 'Pi wants to run echo hi', detail: 'echo hi' });
    const long = decidePiToolCall(session('auto'), call('bash', { command: 'x'.repeat(1500) }));
    expect(long.kind === 'ask' && long.detail).toMatch(/… \(500 more characters not shown\)$/);
    expect(long.kind === 'ask' && long.title.length).toBe(200);
  });

  it('calls the bridge cannot send are refused without a card', () => {
    expect(decidePiToolCall(session('full-access'), call(''))).toMatchObject({
      kind: 'deny',
      rule: 'invalid-call',
    });
    expect(
      decidePiToolCall(session('full-access'), { ...call('read'), toolCallId: '' })
    ).toMatchObject({ kind: 'deny' });
  });
});

describe('auto-accept-edits: the path boundary (ER-03)', () => {
  // [case, path (a function: paths need the temporary root), allowed, reason]
  const cases: Array<[string, () => unknown, boolean, string]> = [
    ['relative path inside', () => 'src/new.ts', true, 'inside-cwd'],
    ['existing file inside', () => 'src/a.ts', true, 'inside-cwd'],
    ['absolute path inside', () => join(cwd, 'src', 'a.ts'), true, 'inside-cwd'],
    ['new directories inside (realpath of the parent)', () => 'new/dir/f.ts', true, 'inside-cwd'],
    ['symlink that stays inside', () => 'link-in/b.ts', true, 'inside-cwd'],
    ['leading @ (Pi drops it)', () => '@src/a.ts', true, 'inside-cwd'],
    ['file:// URL inside', () => pathToFileURL(join(cwd, 'src', 'a.ts')).href, true, 'inside-cwd'],
    ['Unicode space (Pi makes it a space)', () => 'src/a\u00A0b.ts', true, 'inside-cwd'],
    ['.. out of cwd', () => '../outside/y.txt', false, 'outside-cwd'],
    ['.. through a subdirectory', () => 'src/../../outside/y.txt', false, 'outside-cwd'],
    ['@ with .. out of cwd', () => '@../outside/y.txt', false, 'outside-cwd'],
    ['absolute path outside', () => join(outside, 'x.txt'), false, 'outside-cwd'],
    ['symlinked directory leaving cwd', () => 'link-out/y.txt', false, 'outside-cwd'],
    ['symlinked file leaving cwd', () => 'file-out', false, 'outside-cwd'],
    [
      'new directories under a symlink leaving cwd',
      () => 'link-out/new/dir/f',
      false,
      'outside-cwd',
    ],
    ['cwd itself', () => '.', false, 'outside-cwd'],
    ['the parent of cwd', () => '..', false, 'outside-cwd'],
    ['cwd spelled in another case', () => join(root, 'WORK', 'src', 'a.ts'), false, 'outside-cwd'],
    [
      '~ to the profile in state',
      () => '~/.local/state/switch/pi/agent/settings.json',
      false,
      'switch-state',
    ],
    [
      'absolute path into state',
      () => join(state, 'pi', 'agent', 'auth.json'),
      false,
      'switch-state',
    ],
    ['state spelled in another case', () => '~/.LOCAL/State/SWITCH/pi/x', false, 'switch-state'],
    ['symlink into state', () => 'link-state/pi/agent/settings.json', false, 'switch-state'],
    ["symlink into the host's state", () => 'link-hoststate/pi/x', false, 'switch-state'],
    ['symlink into an extra protected root', () => 'link-extra/x', false, 'switch-state'],
    ['dangling symlink', () => 'dangling', false, 'unresolved'],
    ['symlink loop', () => 'loop-a/x', false, 'unresolved'],
    ['empty path', () => '', false, 'unresolved'],
    ['no path', () => undefined, false, 'unresolved'],
    ['path that is not a string', () => ['src/a.ts'], false, 'unresolved'],
    ['NUL in the path', () => 'src/a\0.ts', false, 'unresolved'],
  ];
  it.each(cases)('%s → allowed: %s (%s)', (_name, path, allowed, reason) => {
    const target = piWriteTarget(session('auto-accept-edits'), path());
    expect(target.reason).toBe(reason);
    expect(target.within).toBe(allowed);
    const decision = decidePiToolCall(
      session('auto-accept-edits'),
      call('write', { path: path(), content: 'x' })
    );
    expect(decision.kind).toBe(allowed ? 'allow' : 'ask');
    expect(decision.rule).toBe(allowed ? 'edit-inside-cwd' : 'edit-outside-boundary');
  });

  it('a cwd inside the state allows no write', () => {
    const inState = join(state, 'pi');
    const s = session('auto-accept-edits', { cwd: inState });
    expect(piWriteTarget(s, 'agent/new.json').reason).toBe('switch-state');
    expect(decidePiToolCall(s, call('edit', { path: 'agent/settings.json', edits: [] })).kind).toBe(
      'ask'
    );
  });

  it("the state of the host's home counts without HOME in the session env", () => {
    const s = session('auto-accept-edits', { env: {}, cwd: hostHome });
    expect(piWriteTarget(s, '.local/state/switch/pi/x').reason).toBe('switch-state');
    expect(piWriteTarget(s, '~/.local/state/switch/pi/x').reason).toBe('switch-state');
  });

  it('a cwd that does not resolve allows no write', () => {
    const s = session('auto-accept-edits', { cwd: join(root, 'missing-cwd') });
    expect(decidePiToolCall(s, call('write', { path: 'a.ts', content: '' })).kind).toBe('ask');
    expect(
      piWriteTarget(session('auto-accept-edits', { cwd: 'relative/cwd' }), 'a.ts').reason
    ).toBe('unresolved');
  });

  it('the card says why and shows the resolved target', () => {
    const decision = decidePiToolCall(
      session('auto-accept-edits'),
      call('write', { path: 'link-state/pi/agent/settings.json', content: '{}' })
    );
    expect(decision).toMatchObject({
      kind: 'ask',
      requestType: 'file_change_approval',
      title: `Pi wants to write ${join(state, 'pi', 'agent', 'settings.json')} in Switch's own state`,
      detail: '{"path":"link-state/pi/agent/settings.json","content":"{}"}',
    });
    const out = decidePiToolCall(
      session('auto-accept-edits'),
      call('edit', { path: '../outside/x.txt', edits: [] })
    );
    expect(out.kind === 'ask' && out.title).toBe(
      `Pi wants to edit ${join(outside, 'x.txt')} outside the working directory`
    );
  });

  it('an unexpected error from the file system is outside, not an allow', () => {
    const fs = {
      lstat: () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
      realpath: (p: string) => p,
    };
    expect(piWriteTarget(session('auto-accept-edits'), 'src/a.ts', fs).within).toBe(false);
    expect(
      decidePiToolCall(session('auto-accept-edits'), call('write', { path: 'src/a.ts' }), fs).kind
    ).toBe('ask');
  });

  // `lstat` fails with `code` on the target only (and, for `then`, with that on its parent next);
  // everything else exists and is its own `realpath`. Only a name that is not there yet
  // (`ENOENT`, `ENOTDIR`) sends the check to the parent; any other error is outside.
  const errno = (code: string | undefined) =>
    Object.assign(new Error(code ?? 'no code'), code === undefined ? {} : { code });
  it.each([
    ['ENOENT', undefined, true, 'inside-cwd'],
    ['ENOTDIR', undefined, true, 'inside-cwd'],
    ['EACCES', undefined, false, 'unresolved'],
    ['EPERM', undefined, false, 'unresolved'],
    ['ELOOP', undefined, false, 'unresolved'],
    ['EIO', undefined, false, 'unresolved'],
    [undefined, undefined, false, 'unresolved'],
    ['ENOENT', 'EACCES', false, 'unresolved'],
    ['ENOENT', 'ENOENT', true, 'inside-cwd'],
  ] as const)(
    'lstat failing with %s on the target (then %s on its parent) → allowed: %s (%s)',
    (code, then, allowed, reason) => {
      const target = join(cwd, 'src', 'deep', 'new.ts');
      const parent = join(cwd, 'src', 'deep');
      const fs = {
        lstat: (p: string) => {
          if (p === target) throw errno(code);
          if (p === parent && then !== undefined) throw errno(then);
          return {};
        },
        realpath: (p: string) => p,
      };
      const s = session('auto-accept-edits');
      const result = piWriteTarget(s, 'src/deep/new.ts', fs);
      expect(result.reason).toBe(reason);
      expect(result.within).toBe(allowed);
      if (allowed) expect(result.resolved).toBe(target);
      expect(
        decidePiToolCall(s, call('write', { path: 'src/deep/new.ts', content: 'x' }), fs).kind
      ).toBe(allowed ? 'allow' : 'ask');
    }
  );
});
