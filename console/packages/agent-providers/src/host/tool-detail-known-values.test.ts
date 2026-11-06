import { describe, expect, it } from 'vitest';
import {
  envKnownValues,
  hostKnownValues,
  isSecretEnvName,
  mcpKnownValues,
} from './tool-detail-known-values';
import { buildRegistry, MARKER, redactText } from './tool-detail-redaction';

// Every secret below is synthetic and put together at run time.

describe('environment filter', () => {
  it('takes a name as secret by long words anywhere and short ones as segments', () => {
    for (const name of [
      'PGPASSWORD',
      'APIKEY',
      'MY_PASSPHRASE',
      'MYSQL_PWD',
      'SWITCH_SERVICE_BEARER',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
      'db-password',
      'TOKENIZER',
    ])
      expect(isSecretEnvName(name), name).toBe(true);
    for (const name of [
      'GIT_AUTHOR_NAME',
      'KEYCLOAK_URL',
      'DBUS_SESSION_BUS_ADDRESS',
      'XDG_SESSION_ID',
      'PATH',
      'MONKEY_BUSINESS',
    ])
      expect(isSecretEnvName(name), name).toBe(false);
  });

  it('takes PWD, OLDPWD, GOOGLE_APPLICATION_CREDENTIALS and SSH_AUTH_SOCK, by their exact names, as no secrets', () => {
    for (const name of ['PWD', 'OLDPWD', 'pwd', 'GOOGLE_APPLICATION_CREDENTIALS', 'SSH_AUTH_SOCK'])
      expect(isSecretEnvName(name), name).toBe(false);
    for (const name of [
      'MYSQL_PWD',
      'DB_PWD',
      'PWD_FILE',
      'GOOGLE_APPLICATION_CREDENTIALS_JSON',
      'SSH_AUTH_TOKEN',
    ])
      expect(isSecretEnvName(name), name).toBe(true);
  });

  it('takes the password and userinfo of a URL value, whatever the name, also decoded', () => {
    const password = ['Hq7', '@', 'Lz2', '/', 'Wx9', '%', 'Pd4'].join('');
    const encoded = encodeURIComponent(password);
    expect(envKnownValues({ DATABASE_URL: `postgres://app:${encoded}@db/x` })).toEqual([
      encoded,
      `app:${encoded}`,
      password,
      `app:${password}`,
    ]);
    const malformed = ['abc', '%zz', 'defgh'].join('');
    expect(envKnownValues({ DATABASE_URL: `postgres://app:${malformed}@db/x` })).toEqual([
      malformed,
      `app:${malformed}`,
    ]);
  });

  it('takes the secret entries of a realistic environment', () => {
    const bearer = 'bearer-' + 'q'.repeat(30);
    expect(
      envKnownValues({
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/home/user',
        PWD: '/home/user/project',
        LANG: 'en_US.UTF-8',
        GIT_AUTHOR_NAME: 'Ada Lovelace',
        KEYCLOAK_URL: 'https://kc.example.test/realms/x',
        GOOGLE_APPLICATION_CREDENTIALS: '/home/user/project/service-account.json',
        SSH_AUTH_SOCK: '/tmp/ssh-XXXX/agent.42',
        SWITCH_SERVICE_BEARER: bearer,
        MYSQL_PWD: 'mysql-' + 'w'.repeat(10),
        SHORT_TOKEN: 'abc',
      })
    ).toEqual([bearer, 'mysql-' + 'w'.repeat(10)]);
  });
});

describe('MCP servers', () => {
  const bearer = ['Hq7L', 'z2Wx', '9Pd4', 'Rt6N'].join('');

  it('takes every authentication header, whatever its scheme', () => {
    const token = ['Wd4K', 'p9Lx', '2Rm7', 'Tq5V'].join('');
    const user = 'deploy';
    const password = ['Ns3H', 'k8Qz', '6Fv1'].join('');
    const basic = Buffer.from(`${user}:${password}`).toString('base64');
    const apiKey = ['Zq8W', 'v3Lm', '5Tr7', 'Hq2N'].join('');
    expect(
      mcpKnownValues({
        a: { transport: 'http', url: 'https://x', headers: { Authorization: `Token ${token}` } },
        b: { transport: 'http', url: 'https://x', headers: { authorization: `Basic ${basic}` } },
        c: { transport: 'http', url: 'https://x', headers: { 'X-Api-Key': apiKey } },
        d: { transport: 'http', url: 'https://x', headers: { Accept: 'application/json' } },
      })
    ).toEqual([
      `Token ${token}`,
      token,
      `Basic ${basic}`,
      basic,
      `${user}:${password}`,
      password,
      apiKey,
    ]);
    // With no scheme word the whole value is the credential.
    const bare = { Authorization: token };
    expect(mcpKnownValues({ a: { transport: 'http', url: 'https://x', headers: bare } })).toEqual([
      token,
    ]);
    // Not valid base64 of text: only the whole value and the credential.
    expect(
      mcpKnownValues({
        a: { transport: 'http', url: 'https://x', headers: { Authorization: 'Basic ////////' } },
      })
    ).toEqual(['Basic ////////', '////////']);
  });

  it('takes nothing from other headers, a plain stdio environment or a short value', () => {
    const secret = ['Vb6N', 'c8Md', '0Ke2', 'Lf4H'].join('');
    expect(
      mcpKnownValues({
        a: { transport: 'http', url: 'https://x', headers: { authorization: 'short' } },
        b: { transport: 'http', url: 'https://x', headers: { 'X-Other': `Bearer ${bearer}` } },
        c: { transport: 'stdio', command: 'x', args: [], env: { PLAIN: secret } },
        d: {
          transport: 'http',
          url: 'https://x',
          headers: { Accept: `application/json; ${bearer}`, 'User-Agent': `switch/${bearer}` },
        },
      })
    ).toEqual([]);
    expect(
      mcpKnownValues({
        a: { transport: 'http', url: 'https://x', headers: { authorization: 'bearer short' } },
      })
    ).toEqual(['bearer short']);
    const env = { LOCAL_API_KEY: secret };
    expect(mcpKnownValues({ s: { transport: 'stdio', command: 'x', args: [], env } })).toEqual([
      secret,
    ]);
  });

  it("takes the password and userinfo of an HTTP server's URL, also decoded", () => {
    const password = ['Az3', 'k7p'].join('');
    const at = (url: string) => mcpKnownValues({ a: { transport: 'http', url } });
    expect(at(`https://bot:${password}@mcp.example/sse`)).toEqual([password, `bot:${password}`]);
    const decoded = ['p', '@', 'ss-word'].join('');
    const encoded = encodeURIComponent(decoded);
    expect(at(`https://bot:${encoded}@mcp.example/sse`)).toEqual([
      encoded,
      `bot:${encoded}`,
      decoded,
      `bot:${decoded}`,
    ]);
    const registry = buildRegistry(at(`https://bot:${password}@mcp.example/sse`));
    expect(redactText(`pass ${password} ok`, registry).text).toBe(`pass ${MARKER} ok`);
  });

  it("takes nothing from an HTTP server's URL with a short password, no password or no parse", () => {
    const five = ['Az3', 'k7'].join('');
    const at = (url: string) => mcpKnownValues({ a: { transport: 'http', url } });
    expect(at(`https://bot:${five}@mcp.example/sse`)).not.toContain(five);
    expect(at('https://mcp.example/sse')).toEqual([]);
    expect(at('https://bot@mcp.example/sse')).toEqual([]);
    expect(() => at('not a url')).not.toThrow();
    expect(at('not a url')).toEqual([]);
    // The URL adds to the headers, which are taken as before.
    const six = ['Az3', 'k7p'].join('');
    expect(
      mcpKnownValues({
        a: {
          transport: 'http',
          url: `https://bot:${six}@mcp.example/sse`,
          headers: { 'X-Api-Key': bearer },
        },
      })
    ).toEqual([six, `bot:${six}`, bearer]);
  });
});

describe('the env/MCP source in a detail', () => {
  const codexBearer = ['Wd4K', 'p9Lx', '2Rm7', 'Tq5V', 'n8'].join('');
  const apiKey = ['Zq8W', 'v3Lm', '5Tr7', 'Hq2N'].join('');
  const password = ['Ns3H', 'k8Qz', '6Fv1'].join('');
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    PWD: '/home/user/project',
    OLDPWD: '/home/user',
    GOOGLE_APPLICATION_CREDENTIALS: '/home/user/project/service-account.json',
    KEYCLOAK_URL: 'https://kc.example.test/realms/x',
    DATABASE_URL: `postgres://app:${password}@db.example.test/app`,
    // Codex is handed an HTTP MCP server's bearer token in its environment.
    SWITCH_MCP_DOCS_BEARER_TOKEN: codexBearer,
  };
  const registry = buildRegistry(
    hostKnownValues({
      env,
      mcpServers: {
        docs: { transport: 'http', url: 'https://mcp.example/x', headers: { 'X-Api-Key': apiKey } },
      },
    })
  );
  const shown = (raw: string) => redactText(raw, registry).text;

  it('masks a Codex MCP bearer token in env, an `X-Api-Key` header and a DATABASE_URL password', () => {
    expect(shown(`echo ${codexBearer}\n`)).toBe(`echo ${MARKER}\n`);
    expect(shown(`key ${apiKey} sent`)).toBe(`key ${MARKER} sent`);
    expect(shown(`login app:${password} ok`)).toBe(`login ${MARKER} ok`);
    expect(shown(`pass ${password} ok`)).toBe(`pass ${MARKER} ok`);
  });

  it('leaves PWD, GOOGLE_APPLICATION_CREDENTIALS and a KEYCLOAK_URL without userinfo', () => {
    for (const raw of [
      `cd ${env.PWD} && ls ${env.OLDPWD}`,
      `cat ${env.GOOGLE_APPLICATION_CREDENTIALS}`,
      `curl ${env.KEYCLOAK_URL}/.well-known/openid-configuration`,
    ])
      expect(shown(raw), raw).toBe(raw);
  });
});

describe('the minimum length: 6 for authentication sources, 8 for the rest', () => {
  const six = ['Az3', 'k7p'].join('');
  const five = ['Az3', 'k7'].join('');
  const http = (headers: Record<string, string>) => ({
    a: { transport: 'http' as const, url: 'https://x', headers },
  });
  const basicOf = (password: string) =>
    `Basic ${Buffer.from(`user:${password}`).toString('base64')}`;
  const urlOf = (password: string) => `postgres://user:${password}@host/db`;
  const shownWith = (values: string[], raw: string) => redactText(raw, buildRegistry(values)).text;

  it('keeps 8 for a secret-named environment entry, a stdio environment or another header', () => {
    expect(envKnownValues({ DB_PASSWORD: six })).toEqual([]);
    expect(envKnownValues({ AUTH_MODE: 'public' })).toEqual([]);
    expect(envKnownValues({ KEYCLOAK_VALUE: six })).toEqual([]);
    const env = { DB_PASSWORD: six };
    expect(mcpKnownValues({ s: { transport: 'stdio', command: 'x', args: [], env } })).toEqual([]);
    expect(mcpKnownValues(http({ 'X-Api-Key': six }))).toEqual([]);
    const authMode = envKnownValues({ AUTH_MODE: 'public' });
    expect(shownWith(authMode, 'public publicize')).toBe('public publicize');
    const dbPassword = envKnownValues({ DB_PASSWORD: six });
    expect(shownWith(dbPassword, `result ${six}`)).toBe(`result ${six}`);
  });

  it('takes a 6-character Bearer, Basic or URL credential', () => {
    const bearer = mcpKnownValues(http({ Authorization: `Bearer ${six}` }));
    expect(bearer).toEqual([`Bearer ${six}`, six]);
    expect(mcpKnownValues(http({ Authorization: six }))).toEqual([six]);
    const basic = mcpKnownValues(http({ Authorization: basicOf(six) }));
    expect(basic).toContain(six);
    expect(basic).toContain(`user:${six}`);
    const url = envKnownValues({ DATABASE_URL: urlOf(six) });
    expect(url).toEqual([six, `user:${six}`]);
    const decoded = ['Az', '@', 'k7p'].join('');
    expect(envKnownValues({ DATABASE_URL: urlOf(encodeURIComponent(decoded)) })).toContain(decoded);
    for (const values of [bearer, basic, url])
      expect(shownWith(values, `result ${six}`)).toBe(`result ${MARKER}`);
  });

  it('takes no 5-character credential from an authentication source', () => {
    expect(mcpKnownValues(http({ Authorization: `Bearer ${five}` }))).toEqual([`Bearer ${five}`]);
    expect(mcpKnownValues(http({ Authorization: five }))).toEqual([]);
    expect(mcpKnownValues(http({ Authorization: basicOf(five) }))).not.toContain(five);
    expect(envKnownValues({ DATABASE_URL: urlOf(five) })).not.toContain(five);
  });

  it('counts an environment value without the white space around it, as MCP headers do', () => {
    expect(envKnownValues({ API_TOKEN: '   abc  ' })).toEqual([]);
    expect(shownWith(envKnownValues({ API_TOKEN: '   abc  ' }), 'abc is a word; abcdef')).toBe(
      'abc is a word; abcdef'
    );
    expect(envKnownValues({ API_TOKEN: ` ${six} \n` })).toEqual([]);
    const eight = ` ${six}xy\n`;
    expect(envKnownValues({ API_TOKEN: eight })).toEqual([eight]);
    expect(shownWith(envKnownValues({ API_TOKEN: eight }), `t=${six}xy`)).toBe(`t=${MARKER}`);
    expect(mcpKnownValues(http({ 'X-Api-Key': '   abc  ' }))).toEqual([]);
  });

  it('counts each credential taken from an authentication source without the white space around it', () => {
    // A decoded Basic password of 3 characters once trimmed is not registered.
    const basic = mcpKnownValues(http({ Authorization: basicOf('   abc  ') }));
    expect(basic).not.toContain('   abc  ');
    expect(basic.some((value) => value.trim() === 'abc')).toBe(false);
    expect(shownWith(basic, 'abc is a word; abcdef')).toBe('abc is a word; abcdef');
    // A six-character one with space around it is, and masked trimmed.
    const padded = mcpKnownValues(http({ Authorization: basicOf(`  ${six} `) }));
    expect(padded).toContain(`  ${six} `);
    expect(shownWith(padded, `result ${six}`)).toBe(`result ${MARKER}`);
    // The same for a URL's userinfo, in the server's URL and in an environment value.
    const spaced = encodeURIComponent('   abc  ');
    const server = { a: { transport: 'http' as const, url: urlOf(spaced), headers: {} } };
    expect(mcpKnownValues(server).some((value) => value.trim() === 'abc')).toBe(false);
    expect(envKnownValues({ DATABASE_URL: urlOf(spaced) }).some((v) => v.trim() === 'abc')).toBe(
      false
    );
    // A credential after a scheme is trimmed with the header; the whole value stays.
    expect(mcpKnownValues(http({ Authorization: 'Bearer abc   ' }))).toEqual(['Bearer abc']);
  });
});
