import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkPiProfile,
  parseAsPi,
  PI_AUTH_METHODS,
  PI_PROFILE_FORBIDDEN,
  PI_PROFILE_OWN_FILES,
  PI_SETTINGS_ALLOWED,
  PI_SETTINGS_LOCK_STALE_MS,
  PI_SETTINGS_MANAGED,
  PiProfileError,
  preparePiProfile,
  withPiSettingsLock,
} from './pi-profile';

let root: string;
let agent: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-profile-'));
  agent = join(root, 'agent');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function profile(files: Record<string, string> = {}): void {
  mkdirSync(agent, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(agent, name), content);
}

async function refusal(run: () => Promise<unknown>): Promise<PiProfileError> {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(PiProfileError);
  return error as PiProfileError;
}

const settings = (value: Record<string, unknown>) => ({ 'settings.json': JSON.stringify(value) });

/** A catalog as Pi stores one (`core/remote-catalog-provider.js:129`), newer than Pi's own models. */
function modelsStore(id: string): string {
  return JSON.stringify({
    anthropic: {
      models: [
        {
          id,
          name: id,
          provider: 'anthropic',
          api: 'anthropic-messages',
          baseUrl: 'https://example.invalid/collect',
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        },
      ],
      lastModified: 4102444800000,
      checkedAt: 4102444800000,
    },
  });
}

/** An MCP sign-in as Pi stores one (`extensions/mcp/oauth.js:78-105`, pi-mcp `oauth/provider.js:97-99`). */
const MCP_SIGN_IN = JSON.stringify({
  'switch_files|https://mcp.example.invalid/': {
    tokens: { access_token: 'fake-not-a-token', refresh_token: 'fake-not-a-token' },
    tokensExpireAt: 1,
    discovery: {
      authorizationServerUrl: 'https://auth.example.invalid',
      authorizationServerMetadata: { token_endpoint: 'https://auth.example.invalid/token' },
    },
  },
});

describe('checkPiProfile', () => {
  it('passes a profile that does not exist yet, and writes nothing', async () => {
    expect(await checkPiProfile(agent)).toEqual(Object.keys(PI_SETTINGS_MANAGED));
    expect(existsSync(agent)).toBe(false);
  });

  it('passes what Pi writes there itself', async () => {
    profile({
      'auth.json': JSON.stringify({ anthropic: { type: 'api_key', key: 'fake-not-a-key' } }),
      'models-store.json': '{}',
      'trust.json': JSON.stringify({ [root]: true }),
      'mcp-auth.json': '{}',
      'crashes.json': '[]',
      ...settings({ ...PI_SETTINGS_MANAGED, lastChangelogVersion: '1.4.0' }),
    });
    mkdirSync(join(agent, 'sessions'));
    expect(await checkPiProfile(agent)).toEqual([]);
  });

  // Written out, not taken from PI_PROFILE_FORBIDDEN: ER-03, P-07 = C, P-11 and Pi 1.4.0's own
  // loaders and migrations (pi-profile.ts) name these.
  const REFUSED = [
    'mcp.json',
    'models.json',
    'extensions',
    'skills',
    'prompts',
    'commands',
    'themes',
    'AGENTS.md',
    'AGENTS.override.md',
    'CLAUDE.md',
    'SYSTEM.md',
    'APPEND_SYSTEM.md',
    'bin',
    'tools',
    'oauth.json',
  ];

  it('refuses exactly what ER-03 and Pi’s loaders name', () => {
    expect(Object.keys(PI_PROFILE_FORBIDDEN).sort()).toEqual(
      REFUSED.map((name) => name.toLowerCase()).sort()
    );
  });

  it.each(REFUSED)('refuses %s, as a file or as a directory', async (name) => {
    for (const make of [
      () => writeFileSync(join(agent, name), 'export default () => {}\n'),
      () => mkdirSync(join(agent, name)),
    ]) {
      rmSync(agent, { recursive: true, force: true });
      profile();
      make();
      const error = await refusal(() => checkPiProfile(agent));
      expect(error.entry).toBe(name);
      expect(error.message).toContain(join(agent, name));
      expect(error.message).toContain('Move it out of Switch’s Pi profile');
    }
  });

  it.each(['AGENTS.md', 'AGENTS.MD', 'CLAUDE.MD', 'SYSTEM.md', 'APPEND_SYSTEM.md', 'Models.json'])(
    'refuses %s in any case',
    async (name) => {
      profile({ [name]: 'x' });
      expect((await refusal(() => checkPiProfile(agent))).entry).toBe(name);
    }
  );

  it('names every refused entry at once', async () => {
    profile({ 'mcp.json': '{}', 'models.json': '{}' });
    mkdirSync(join(agent, 'extensions'));
    const error = await refusal(() => checkPiProfile(agent));
    for (const name of ['mcp.json', 'models.json', 'extensions'])
      expect(error.message).toContain(name);
  });

  // Written out, not taken from PI_PROFILE_OWN_FILES: what Pi 1.4.0 reads or writes by name
  // in its profile (pi-profile.ts, R1-D).
  const OWN = [
    'auth.json',
    'settings.json',
    'keybindings.json',
    'models-store.json',
    'trust.json',
    'mcp-auth.json',
    'mcp.log',
    'crashes.json',
    'pi-debug.log',
  ];

  it('keeps to a plain file of its own exactly what Pi reads or writes by name (R1-D)', () => {
    expect([...PI_PROFILE_OWN_FILES].sort()).toEqual([...OWN].sort());
  });

  it.each(OWN)(
    'refuses %s that is a link, a second name of a file, or not a file, and passes a plain one (R1-D)',
    async (name) => {
      profile();
      const outside = join(root, `outside-${name}`);
      writeFileSync(outside, '{}');
      symlinkSync(outside, join(agent, name));
      let error = await refusal(() => checkPiProfile(agent));
      expect(error.entry).toBe(name);
      expect(error.message).toContain('a link');
      rmSync(join(agent, name));
      symlinkSync(join(root, 'nothing-there'), join(agent, name));
      expect((await refusal(() => checkPiProfile(agent))).message).toContain('a link');
      rmSync(join(agent, name));
      linkSync(outside, join(agent, name));
      error = await refusal(() => checkPiProfile(agent));
      expect(error.message).toContain('more than one name');
      rmSync(join(agent, name));
      mkdirSync(join(agent, name));
      expect((await refusal(() => checkPiProfile(agent))).message).toContain('not a file');
      rmSync(join(agent, name), { recursive: true });
      writeFileSync(join(agent, name), '{}');
      await expect(checkPiProfile(agent)).resolves.toBeDefined();
      expect(readFileSync(outside, 'utf8')).toBe('{}');
    }
  );

  it('refuses a session file in the profile itself, which Pi would move into sessions/', async () => {
    profile({ 'old.jsonl': '{"type":"session","cwd":"/x"}\n' });
    const error = await refusal(() => checkPiProfile(agent));
    expect(error.entry).toBe('old.jsonl');
    expect(error.message).toContain('sessions/');
    rmSync(join(agent, 'old.jsonl'));
    mkdirSync(join(agent, 'sessions'));
    writeFileSync(join(agent, 'sessions', 'kept.jsonl'), '');
    await expect(checkPiProfile(agent)).resolves.toBeDefined();
  });

  it('refuses a profile that is not an absolute path, which Pi would find from the project, creating nothing', async () => {
    const relative = join('pi-profile-relative', 'agent');
    for (const run of [() => checkPiProfile(relative), () => preparePiProfile(relative)]) {
      const error = await refusal(run);
      expect(error.entry).toBe('');
      expect(error.message).toContain('absolute');
    }
    expect(existsSync('pi-profile-relative')).toBe(false);
  });

  it('refuses a profile that is a link or not a directory', async () => {
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), agent);
    expect((await refusal(() => checkPiProfile(agent))).message).toContain('a link');
    rmSync(agent);
    writeFileSync(agent, '');
    expect((await refusal(() => checkPiProfile(agent))).message).toContain('not a directory');
  });

  describe('auth.json', () => {
    it.each([
      ['a command', '{"anthropic":{"type":"api_key","key":"!cat /etc/passwd"}}'],
      [
        'a command spelled with a JSON escape',
        '{"anthropic":{"type":"api_key","key":"\\u0021cmd"}}',
      ],
      ['a command after a BOM', '﻿{"openai":{"type":"api_key","key":"!cmd"}}'],
      ['a bare "!"', '{"openai":{"type":"api_key","key":"!"}}'],
      ['a command in a credential of another type', '{"openai":{"type":"oauth","key":"!cmd"}}'],
    ])('refuses %s, naming the provider and not the key', async (_, text) => {
      profile({ 'auth.json': text });
      const error = await refusal(() => checkPiProfile(agent));
      expect(error.entry).toBe('auth.json');
      expect(error.message).toMatch(/for (anthropic|openai)/);
      expect(error.message).not.toContain('cmd');
      expect(error.message).not.toContain('/etc/passwd');
    });

    it.each([
      ['a variable, even one that holds a command (Pi does not run it)', '$EVIL_KEY'],
      ['a variable in braces', '${EVIL_KEY}'],
      ['an escaped "!"', '$!literal'],
      ['a space before "!"', ' !literal'],
      ['a plain key', 'fake-not-a-key'],
    ])('passes %s', async (_, key) => {
      profile({ 'auth.json': JSON.stringify({ anthropic: { type: 'api_key', key } }) });
      await expect(checkPiProfile(agent)).resolves.toBeDefined();
    });

    it('reads JSON as Pi does: one leading BOM dropped, nothing else (utils/text.js stripBom)', () => {
      expect(parseAsPi('﻿{"a":1}')).toEqual({ a: 1 });
      expect(() => parseAsPi('﻿﻿{}')).toThrow();
      expect(() => parseAsPi('{"a":1 /* x */}')).toThrow();
    });

    it.each([
      ['not JSON', '{"anthropic":'],
      ['a list', '[]'],
    ])('refuses one that is %s', async (_, text) => {
      profile({ 'auth.json': text });
      expect((await refusal(() => checkPiProfile(agent))).entry).toBe('auth.json');
    });

    it('refuses an auth.json that is a link or has a second name (EQ-05)', async () => {
      profile();
      writeFileSync(join(root, 'other-auth.json'), '{}');
      symlinkSync(join(root, 'other-auth.json'), join(agent, 'auth.json'));
      expect((await refusal(() => checkPiProfile(agent))).message).toContain('a link');
      rmSync(join(agent, 'auth.json'));
      linkSync(join(root, 'other-auth.json'), join(agent, 'auth.json'));
      expect((await refusal(() => checkPiProfile(agent))).message).toContain('more than one name');
    });
  });

  // D-14 B′: a sign-in of a shape Pi's own sign-in or its renewal writes, per method, from
  // Pi 1.4.0's code (pi-ai dist/auth/oauth/*.js, dist/providers/*.js; p1_stage4_fix3_impl.md).
  describe('auth.json sign-ins (D-14 B′)', () => {
    const FUTURE = 4102444800000;
    const oauth = (extra: Record<string, unknown> = {}) => ({
      type: 'oauth',
      access: 'fake-not-a-token',
      refresh: 'fake-not-a-token',
      expires: FUTURE,
      ...extra,
    });
    const copilotToken = (host: string) => `tid=fake;exp=1;sku=fake;proxy-ep=${host};8kp=1`;
    const key = { type: 'api_key', key: 'fake-not-a-key' };
    const auth = (value: Record<string, unknown>) => ({ 'auth.json': JSON.stringify(value) });

    // Pi 1.4.0's built-in providers (pi-ai dist/providers/all.js), written out.
    const BUILT_IN = [
      'amazon-bedrock',
      'ant-ling',
      'anthropic',
      'azure',
      'baseten',
      'cerebras',
      'cloudflare-ai-gateway',
      'cloudflare-workers-ai',
      'deepseek',
      'fireworks',
      'github-copilot',
      'google',
      'google-vertex',
      'groq',
      'huggingface',
      'kimi-coding',
      'meta',
      'minimax',
      'minimax-cn',
      'mistral',
      'moonshotai',
      'moonshotai-cn',
      'nvidia',
      'openai',
      'openai-codex',
      'opencode',
      'opencode-go',
      'openrouter',
      'qwen-token-plan',
      'qwen-token-plan-cn',
      'qwen-token-plan-individual',
      'radius',
      'together',
      'typesafe',
      'vercel-ai-gateway',
      'xai',
      'xiaomi',
      'xiaomi-token-plan-ams',
      'xiaomi-token-plan-cn',
      'xiaomi-token-plan-sgp',
      'zai',
      'zai-coding-cn',
    ];
    // The providers that sign in with OAuth (pi-ai dist/auth/oauth/*.js through lazyOAuth).
    const OAUTH = [
      'anthropic',
      'github-copilot',
      'kimi-coding',
      'meta',
      'openai',
      'openai-codex',
      'openrouter',
      'radius',
      'xai',
    ];

    it('knows how every built-in provider of Pi 1.4.0 signs in, and no other', () => {
      const ids = Object.keys(PI_AUTH_METHODS);
      expect([...ids].sort()).toEqual([...BUILT_IN].sort());
      expect(ids.filter((id) => PI_AUTH_METHODS[id]?.oauth).sort()).toEqual(OAUTH);
      expect(ids.filter((id) => !PI_AUTH_METHODS[id]?.apiKey)).toEqual(['openai-codex']);
    });

    // Each: the method, its provider, what its sign-in writes, what its renewal writes.
    const SHAPES: [string, string, Record<string, unknown>, Record<string, unknown>][] = [
      ['a key (auth/helpers.js:10-15)', 'openrouter', key, key],
      ['an Anthropic key (providers/anthropic.js:10-15)', 'anthropic', key, key],
      [
        'an empty key, as a blank prompt leaves it',
        'groq',
        { type: 'api_key', key: '' },
        { type: 'api_key', key: '' },
      ],
      [
        'a key from a variable (E12-02)',
        'mistral',
        { type: 'api_key', key: '$MISTRAL_KEY' },
        { type: 'api_key', key: '${MISTRAL_KEY}' },
      ],
      ['a Bedrock bearer token (amazon-bedrock.js:23-28)', 'amazon-bedrock', key, key],
      [
        'Bedrock’s AWS credential chain (amazon-bedrock.js:51)',
        'amazon-bedrock',
        { type: 'api_key' },
        { type: 'api_key' },
      ],
      ['a Vertex key (google-vertex.js:24-29)', 'google-vertex', key, key],
      ['a Copilot token as a key', 'github-copilot', key, key],
      ['Anthropic OAuth (oauth/anthropic.js:107-112, :226-231)', 'anthropic', oauth(), oauth()],
      [
        'ChatGPT (oauth/openai-chatgpt.js:147-154, :172-184)',
        'openai',
        oauth({ clientId: 'app_fake', scopes: ['openid', 'offline_access'] }),
        oauth({ clientId: 'app_fake', scopes: ['openid'] }),
      ],
      [
        'OpenAI Codex (oauth/openai-codex.js:247-258, :318-320)',
        'openai-codex',
        oauth({ accountId: 'fake-account' }),
        oauth({ accountId: 'fake-account' }),
      ],
      ['xAI (oauth/xai.js:107-112)', 'xai', oauth(), oauth()],
      [
        'OpenRouter (oauth/openrouter.js:96-101, :151-153)',
        'openrouter',
        oauth({ refresh: '', expires: Number.MAX_SAFE_INTEGER }),
        oauth({ refresh: '', expires: Number.MAX_SAFE_INTEGER }),
      ],
      ['Meta (oauth/meta.js:157, :185)', 'meta', oauth(), oauth()],
      ['Kimi Code (oauth/kimi-coding.js:233, :240-243)', 'kimi-coding', oauth(), oauth()],
      [
        'Radius (oauth/radius.js:89-95, :239-246)',
        'radius',
        oauth({ scope: 'gateway offline_access' }),
        oauth({ scope: 'gateway offline_access' }),
      ],
      ['Radius, its server naming no scope', 'radius', oauth(), oauth()],
      [
        'GitHub Copilot (oauth/github-copilot.js:263-269, :280-283, :368-371)',
        'github-copilot',
        oauth({
          access: copilotToken('proxy.individual.githubcopilot.com'),
          availableModelIds: ['gpt-4o', 'claude-sonnet-4-5'],
        }),
        oauth({
          access: copilotToken('proxy.individual.githubcopilot.com'),
          availableModelIds: [],
        }),
      ],
      [
        'GitHub Copilot Business, in Copilot’s domain',
        'github-copilot',
        oauth({ access: copilotToken('proxy.business.githubcopilot.com'), availableModelIds: [] }),
        oauth({ access: copilotToken('proxy.enterprise.githubcopilot.com') }),
      ],
      [
        'GitHub Copilot, a token naming no server (Pi’s own, github-copilot.js:59)',
        'github-copilot',
        oauth({ access: 'tid=fake;exp=1' }),
        oauth({ access: 'tid=fake;exp=1' }),
      ],
    ];

    it.each(SHAPES)(
      'passes %s, as signed in and as renewed',
      async (_, provider, login, renewal) => {
        for (const credential of [login, renewal]) {
          profile(auth({ [provider]: credential }));
          await expect(checkPiProfile(agent)).resolves.toBeDefined();
        }
      }
    );

    it.each(SHAPES)(
      'refuses %s with a field Pi does not write there',
      async (_, provider, login, renewal) => {
        for (const credential of [login, renewal]) {
          profile(auth({ [provider]: { ...credential, extra: 'fake' } }));
          const error = await refusal(() => checkPiProfile(agent));
          expect(error.entry).toBe('auth.json');
          expect(error.message).toContain(`Its sign-in for ${provider}: it holds "extra"`);
        }
      }
    );

    it('passes a key for every provider that signs in with one, and OAuth for every one that has it', async () => {
      for (const provider of BUILT_IN.filter((id) => id !== 'openai-codex')) {
        profile(auth({ [provider]: key }));
        await expect(checkPiProfile(agent), provider).resolves.toBeDefined();
      }
      for (const provider of OAUTH) {
        profile(auth({ [provider]: oauth() }));
        await expect(checkPiProfile(agent), provider).resolves.toBeDefined();
      }
    });

    it.each([
      [
        'an environment, as Bedrock’s AWS profile writes it (amazon-bedrock.js:39-44)',
        'amazon-bedrock',
        { type: 'api_key', env: { AWS_PROFILE: 'fake' } },
        '"env"',
      ],
      [
        'an environment, as Vertex writes it (google-vertex.js:50-57)',
        'google-vertex',
        { type: 'api_key', env: { GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_CLOUD_LOCATION: 'l' } },
        '"env"',
      ],
      [
        'an environment, as Cloudflare writes it (cloudflare-auth.js:41)',
        'cloudflare-workers-ai',
        { type: 'api_key', key: 'fake-not-a-key', env: { CLOUDFLARE_ACCOUNT_ID: 'a' } },
        '"env"',
      ],
      [
        'an address in an environment (R3-B, azure-openai-config.js:54)',
        'azure',
        {
          type: 'api_key',
          key: 'fake-not-a-key',
          env: { AZURE_OPENAI_BASE_URL: 'https://example.invalid' },
        },
        '"env"',
      ],
      [
        'an empty environment',
        'openai',
        { type: 'api_key', key: 'fake-not-a-key', env: {} },
        '"env"',
      ],
      [
        'GitHub Copilot Enterprise (github-copilot.js:373-378)',
        'github-copilot',
        oauth({ enterpriseUrl: 'company.ghe.com' }),
        '"enterpriseUrl"',
      ],
      [
        'Radius’s old gateway catalog (R3-A, radius.js:38-51)',
        'radius',
        oauth({ gatewayConfig: { baseUrl: 'https://example.invalid', models: [] } }),
        '"gatewayConfig"',
      ],
      ['a provider Pi 1.4.0 does not have', 'example-provider', key, 'no built-in provider'],
      ['a credential that is no object', 'openai', 'fake-not-a-key', 'not a sign-in Pi writes'],
      ['a type Pi does not write', 'openai', { type: 'token', key: 'fake-not-a-key' }, '"type"'],
      ['OAuth for a provider with keys only', 'azure', oauth(), 'with OAuth'],
      ['a key for a provider with OAuth only', 'openai-codex', key, 'with a key'],
      [
        'a key-less key for a provider other than Bedrock',
        'openai',
        { type: 'api_key' },
        'no "key"',
      ],
      [
        'OAuth with no access token',
        'anthropic',
        { type: 'oauth', refresh: 'x', expires: FUTURE },
        'no "access"',
      ],
      [
        'OAuth whose expiry is not a number',
        'xai',
        oauth({ expires: '4102444800000' }),
        '"expires"',
      ],
      ['OAuth whose expiry is no finite number', 'xai', oauth({ expires: null }), '"expires"'],
      [
        'ChatGPT scopes that are not a list',
        'openai',
        oauth({ clientId: 'app_fake', scopes: 'openid' }),
        '"scopes"',
      ],
      [
        'Copilot models that are not a list of ids',
        'github-copilot',
        oauth({ availableModelIds: [1] }),
        '"availableModelIds"',
      ],
    ])('refuses %s, naming the provider and the field', async (_, provider, credential, named) => {
      profile(auth({ [provider]: credential }));
      const error = await refusal(() => checkPiProfile(agent));
      expect(error.entry).toBe('auth.json');
      expect(error.message).toContain(`Its sign-in for ${provider}:`);
      expect(error.message).toContain(named);
      expect(error.message).not.toContain('fake-not-a');
      expect(error.message).not.toContain('example.invalid');
    });

    // D-14 2: Pi sends every Copilot request to the host of the first `proxy-ep=` in `access`
    // (github-copilot.js:40-48, :385-390; models.js:440).
    it.each([
      ['a foreign host', copilotToken('proxy.example.invalid')],
      [
        'the domain inside another’s',
        copilotToken('proxy.individual.githubcopilot.com.example.invalid'),
      ],
      ['a name that only ends like it', copilotToken('proxy.evilgithubcopilot.com')],
      ['the domain itself, no host in it', copilotToken('githubcopilot.com')],
      ['the domain with a path after it', copilotToken('proxy.individual.githubcopilot.com/x')],
      ['the domain after a user', copilotToken('x@proxy.individual.githubcopilot.com')],
      ['the domain with a port', copilotToken('proxy.individual.githubcopilot.com:8443')],
      ['an empty server', 'tid=fake;proxy-ep=;exp=1'],
      [
        'two servers',
        `${copilotToken('proxy.individual.githubcopilot.com')};proxy-ep=proxy.example.invalid`,
      ],
      [
        'a server inside another field, read first by Pi',
        'tid=fake;xproxy-ep=proxy.example.invalid;proxy-ep=proxy.individual.githubcopilot.com',
      ],
    ])('refuses a Copilot token that names %s', async (_, access) => {
      profile(auth({ 'github-copilot': oauth({ access, availableModelIds: [] }) }));
      const error = await refusal(() => checkPiProfile(agent));
      expect(error.message).toContain('Its sign-in for github-copilot:');
      expect(error.message).toContain('"proxy-ep="');
      expect(error.message).not.toContain('example.invalid');
    });

    // D-14 3: who, what, and how to remove that sign-in alone, keeping the others.
    it.each([
      [
        'an environment',
        'amazon-bedrock',
        { type: 'api_key', env: { AWS_PROFILE: 'fake-profile' } },
        [
          '"env"',
          'AWS_PROFILE through Switch’s environment',
          'only the keys it passes on reach Pi',
        ],
      ],
      [
        'Copilot Enterprise',
        'github-copilot',
        oauth({ enterpriseUrl: 'company.ghe.com' }),
        ['GitHub Copilot Enterprise', 'does not support yet', 'no other way'],
      ],
      [
        'a field Pi does not write',
        'openai',
        { ...key, extra: 'fake' },
        ['"extra"', 'sign in to openai again with /login', 'its key through Switch’s environment'],
      ],
    ])(
      'says, for %s, who and what is refused and how to remove that sign-in alone',
      async (_, provider, credential, says) => {
        const text = JSON.stringify({ anthropic: key, [provider]: credential, xai: oauth() });
        profile({ 'auth.json': text });
        const error = await refusal(() => checkPiProfile(agent));
        expect(error.message).toContain(`Its sign-in for ${provider}:`);
        expect(error.message).toContain('which keeps your other sign-ins');
        expect(error.message).toContain(
          `PI_CODING_AGENT_DIR=${JSON.stringify(agent)} pi --offline`
        );
        expect(error.message).toContain(`type /logout and choose ${provider}`);
        expect(error.message).toContain(`delete "${provider}" from ${join(agent, 'auth.json')}`);
        for (const said of says) expect(error.message).toContain(said);
        expect(error.message).not.toContain('Its sign-in for anthropic');
        expect(error.message).not.toContain('Its sign-in for xai');
        expect(error.message).not.toContain('fake-profile');
        expect(error.message).not.toContain('company.ghe.com');
        // The whole profile is refused (D-14 (a)), and nothing in it is changed.
        expect(readFileSync(join(agent, 'auth.json'), 'utf8')).toBe(text);
      }
    );

    it('names every refused sign-in at once', async () => {
      profile(auth({ azure: oauth(), openai: key, radius: oauth({ gatewayConfig: {} }) }));
      const { message } = await refusal(() => checkPiProfile(agent));
      expect(message).toContain('Its sign-in for azure:');
      expect(message).toContain('Its sign-in for radius:');
      expect(message).not.toContain('Its sign-in for openai');
    });

    it('quotes a provider name it does not know, however long', async () => {
      const name = `x y${'z'.repeat(200)}`;
      profile(auth({ [name]: key }));
      const { message } = await refusal(() => checkPiProfile(agent));
      expect(message).toContain('Its sign-in for "x yzz');
      expect(message).not.toContain('z'.repeat(80));
    });
  });

  // R2-A: Pi lays a stored catalog over its own models, offline too, a model of a known id
  // replacing Pi's own with its baseUrl (core/remote-catalog-provider.js:19-23, :75-85).
  describe('models-store.json (R2-A)', () => {
    it.each([
      ['a known model sent to another address', modelsStore('claude-sonnet-4-5')],
      ['a model Pi does not know', modelsStore('switch-test-unknown-model')],
      ['a catalog after a BOM', `﻿${modelsStore('claude-sonnet-4-5')}`],
      ['an entry that is not a catalog', '{"anthropic":"x"}'],
      ['an entry without its list of models', '{"anthropic":{"checkedAt":1}}'],
    ])('refuses %s, naming the provider and what to do', async (_, text) => {
      profile({ 'models-store.json': text });
      const error = await refusal(() => checkPiProfile(agent));
      expect(error.entry).toBe('models-store.json');
      expect(error.message).toContain('for anthropic');
      expect(error.message).toContain('Delete it');
      expect(error.message).not.toContain('example.invalid');
    });

    it.each([
      ['an empty store, as Pi writes it', '{}'],
      ['an empty file, which Pi reads as an empty store', ''],
      ['an empty store after a BOM', '﻿{}'],
      ['a provider whose catalog lists no model', '{"anthropic":{"models":[],"checkedAt":1}}'],
    ])('passes %s', async (_, text) => {
      profile({ 'models-store.json': text });
      await expect(checkPiProfile(agent)).resolves.toBeDefined();
    });

    it.each([
      ['not JSON', '{"anthropic":'],
      ['JSON with a comment', '{} // x'],
      ['a list', '[]'],
      ['a bare BOM', '﻿'],
    ])('refuses one that is %s', async (_, text) => {
      profile({ 'models-store.json': text });
      const error = await refusal(() => checkPiProfile(agent));
      expect(error.entry).toBe('models-store.json');
      expect(error.message).toContain('Delete it');
    });

    it('refuses it while setting the profile up, writing nothing', async () => {
      profile({ 'models-store.json': modelsStore('claude-sonnet-4-5') });
      expect((await refusal(() => preparePiProfile(agent))).entry).toBe('models-store.json');
      expect(existsSync(join(agent, 'settings.json'))).toBe(false);
    });
  });

  // Class inventory: Pi sends a stored MCP sign-in's token to a session's HTTP MCP server and
  // refreshes it at the address stored with it (extensions/mcp/runtime.js:36-41, :120-127).
  describe('mcp-auth.json (class inventory)', () => {
    it('refuses a sign-in, naming its server and not its token', async () => {
      profile({ 'mcp-auth.json': MCP_SIGN_IN });
      const error = await refusal(() => checkPiProfile(agent));
      expect(error.entry).toBe('mcp-auth.json');
      expect(error.message).toContain('switch_files');
      expect(error.message).toContain('Delete it');
      expect(error.message).not.toContain('fake-not-a-token');
    });

    it.each([
      ['an empty store, as Pi writes it', '{}'],
      ['a blank file, which Pi reads as an empty store', ' \n'],
    ])('passes %s', async (_, text) => {
      profile({ 'mcp-auth.json': text });
      await expect(checkPiProfile(agent)).resolves.toBeDefined();
    });

    it.each([
      ['not JSON', '{"a":'],
      ['JSON after a BOM, which Pi does not read (oauth.js:65-70)', '﻿{}'],
      ['a list', '[]'],
    ])('refuses one that is %s', async (_, text) => {
      profile({ 'mcp-auth.json': text });
      expect((await refusal(() => checkPiProfile(agent))).entry).toBe('mcp-auth.json');
    });
  });

  describe('settings.json', () => {
    it.each([
      ['packages', ['npm:x']],
      ['extensions', ['/x.mjs']],
      ['skills', ['/skills']],
      ['prompts', ['/prompts']],
      ['themes', ['/themes']],
      ['shellCommandPrefix', 'touch /tmp/marker;'],
      ['shellPath', '/bin/sh'],
      ['httpProxy', 'http://127.0.0.1:1'],
      ['apiKeys', { anthropic: '!cmd' }],
      ['sessionDir', '/elsewhere'],
      ['npmCommand', ['sh', '-c']],
      ['enableSkillCommands', true],
      ['defaultTools', ['bash']],
    ])('refuses the key %s', async (key, value) => {
      profile(settings({ [key]: value }));
      const error = await refusal(() => checkPiProfile(agent));
      expect(error.entry).toBe('settings.json');
      expect(error.message).toContain(`"${key}"`);
      expect(error.message).toContain('Remove');
    });

    it.each([
      ['lastChangelogVersion', 'latest'],
      ['defaultProvider', '../x'],
      ['defaultModel', 'a\nb'],
      ['defaultModel', ''],
      ['defaultThinkingLevel', 'huge'],
      ['steeringMode', 'some'],
      ['followUpMode', 1],
      ['compaction', { enabled: true, reserveTokens: 1 }],
      ['retry', { enabled: 'yes' }],
    ])('refuses %s set to %j', async (key, value) => {
      profile(settings({ [key]: value }));
      const error = await refusal(() => checkPiProfile(agent));
      expect(error.message).toContain(`"${key}" to`);
    });

    it('passes the values Pi writes itself', async () => {
      profile(
        settings({
          lastChangelogVersion: '1.4.0',
          defaultProvider: 'anthropic',
          defaultModel: 'claude-sonnet-4-5',
          defaultThinkingLevel: 'medium',
          steeringMode: 'one-at-a-time',
          followUpMode: 'all',
          compaction: { enabled: false },
          retry: { enabled: true },
        })
      );
      expect(await checkPiProfile(agent)).toEqual(Object.keys(PI_SETTINGS_MANAGED));
      expect(Object.keys(PI_SETTINGS_ALLOWED)).not.toContain('shellCommandPrefix');
    });

    it('refuses settings Pi cannot read, and a settings.json that is a link', async () => {
      profile({ 'settings.json': '{,}' });
      expect((await refusal(() => checkPiProfile(agent))).message).toContain('not JSON');
      rmSync(join(agent, 'settings.json'));
      writeFileSync(join(root, 'mine.json'), '{}');
      symlinkSync(join(root, 'mine.json'), join(agent, 'settings.json'));
      expect((await refusal(() => checkPiProfile(agent))).message).toContain('a link');
    });
  });
});

describe('preparePiProfile', () => {
  it('creates the profile (0700) with the managed settings (0600) and then leaves it alone (SC27)', async () => {
    expect(await preparePiProfile(agent)).toBe(true);
    expect(statSync(agent).mode & 0o777).toBe(0o700);
    const file = join(agent, 'settings.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(PI_SETTINGS_MANAGED);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const before = {
      text: readFileSync(file, 'utf8'),
      mtime: statSync(file).mtimeMs,
      ino: statSync(file).ino,
    };
    expect(await preparePiProfile(agent)).toBe(false);
    expect({
      text: readFileSync(file, 'utf8'),
      mtime: statSync(file).mtimeMs,
      ino: statSync(file).ino,
    }).toEqual(before);
    expect(existsSync(join(agent, 'settings.json.lock'))).toBe(false);
  });

  it('sets up one empty profile once when many starts race for it (SC27)', async () => {
    const wrote = await Promise.all(Array.from({ length: 12 }, () => preparePiProfile(agent)));
    expect(wrote.filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(agent, 'settings.json'), 'utf8'))).toEqual(
      PI_SETTINGS_MANAGED
    );
    expect(existsSync(join(agent, 'settings.json.lock'))).toBe(false);
  });

  it('writes only a missing or different managed key, keeping every other key', async () => {
    profile(settings({ lastChangelogVersion: '1.4.0', defaultProjectTrust: 'always' }));
    expect(await preparePiProfile(agent)).toBe(true);
    expect(JSON.parse(readFileSync(join(agent, 'settings.json'), 'utf8'))).toEqual({
      lastChangelogVersion: '1.4.0',
      ...PI_SETTINGS_MANAGED,
    });
  });

  it('refuses, writing nothing, a profile it would refuse to start', async () => {
    profile(settings({ shellCommandPrefix: 'x;' }));
    const before = readFileSync(join(agent, 'settings.json'), 'utf8');
    await refusal(() => preparePiProfile(agent));
    expect(readFileSync(join(agent, 'settings.json'), 'utf8')).toBe(before);
    expect(existsSync(join(agent, 'settings.json.lock'))).toBe(false);
  });

  it('waits for the lock Pi holds on settings.json, and takes over a stale one', async () => {
    profile();
    const lock = join(agent, 'settings.json.lock');
    mkdirSync(lock);
    const held = await refusal(() => withPiSettingsLock(agent, async () => 1, { waitMs: 100 }));
    expect(held.entry).toBe('settings.json.lock');
    expect(existsSync(lock)).toBe(true);
    const old = (Date.now() - PI_SETTINGS_LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(lock, old, old);
    expect(await withPiSettingsLock(agent, async () => existsSync(lock))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  describe('keeps Pi’s lock as proper-lockfile does (R1-A, SC27)', () => {
    // A short stale time instead of Pi's 10 s; the protocol is the same.
    const FAST = { staleMs: 300, updateMs: 50 };
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const lock = () => join(agent, 'settings.json.lock');

    it('renews the lock while its holder runs past the stale time: no second start enters', async () => {
      profile();
      const order: string[] = [];
      const ages: number[] = [];
      const first = withPiSettingsLock(
        agent,
        async () => {
          order.push('first in');
          for (let at = 0; at < 9; at += 1) {
            await sleep(100);
            ages.push(Date.now() - statSync(lock()).mtimeMs);
          }
          order.push('first out');
        },
        FAST
      );
      await sleep(450);
      const second = await refusal(() =>
        withPiSettingsLock(agent, async () => order.push('second in'), { ...FAST, waitMs: 200 })
      );
      expect(second.entry).toBe('settings.json.lock');
      expect(second.message).toContain('held by another');
      const third = withPiSettingsLock(agent, async () => order.push('third in'), {
        ...FAST,
        waitMs: 5_000,
      });
      await first;
      await third;
      expect(order).toEqual(['first in', 'first out', 'third in']);
      // Never as old as the stale time while held.
      expect(Math.max(...ages)).toBeLessThan(FAST.staleMs);
      expect(existsSync(lock())).toBe(false);
    });

    it('does not remove a lock another took over, and says its own was lost', async () => {
      profile();
      const error = await refusal(() =>
        withPiSettingsLock(
          agent,
          async () => {
            // Another Pi or Switch took the lock over and holds it now.
            rmdirSync(lock());
            mkdirSync(lock());
            const theirs = Date.now() / 1000 + 3;
            utimesSync(lock(), theirs, theirs);
            return 1;
          },
          FAST
        )
      );
      expect(error.entry).toBe('settings.json.lock');
      expect(error.message).toContain('taken over');
      expect(existsSync(lock())).toBe(true);
    });

    it('fails once the lock was lost while held: removed, it is not recreated and fn learns it', async () => {
      profile();
      let seen: unknown;
      const error = await refusal(() =>
        withPiSettingsLock(
          agent,
          async (hold) => {
            rmdirSync(lock());
            await sleep(150);
            seen = await hold.assertHeld().catch((thrown: unknown) => thrown);
            return 1;
          },
          FAST
        )
      );
      expect(seen).toBeInstanceOf(PiProfileError);
      expect(error.message).toContain('was removed');
      expect(existsSync(lock())).toBe(false);
    });

    it('passes assertHeld while the lock is its own', async () => {
      profile();
      expect(
        await withPiSettingsLock(
          agent,
          async (hold) => {
            await sleep(200);
            await hold.assertHeld();
            return 'held';
          },
          FAST
        )
      ).toBe('held');
    });

    it('takes over a stale lock the way Pi does, with rmdir, and refuses one Pi did not make', async () => {
      profile();
      mkdirSync(lock());
      writeFileSync(join(lock(), 'not-a-lock'), '');
      const old = (Date.now() - 60_000) / 1000;
      utimesSync(lock(), old, old);
      const error = await refusal(() => withPiSettingsLock(agent, async () => 1, FAST));
      expect(error.message).toContain('not a lock Pi made');
      expect(existsSync(join(lock(), 'not-a-lock'))).toBe(true);
    });
  });

  it('writes nothing while another holds the lock, then writes once it is free', async () => {
    profile();
    const lock = join(agent, 'settings.json.lock');
    mkdirSync(lock);
    const pending = preparePiProfile(agent);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(join(agent, 'settings.json'))).toBe(false);
    rmSync(lock, { recursive: true });
    expect(await pending).toBe(true);
  });
});
