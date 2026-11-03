import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_ENV_VARS } from '../host/agent-env';
import { SHARED_GROUP_ENV } from '../host/host-permissions';
import { piAgentDir } from './pi-paths';
import {
  checkPiSignIn,
  PI_CHECK_BUDGET_MS,
  PI_ENV_ONLY,
  PI_INHERIT_ENV,
  PI_LOGIN,
  PI_PROVIDER_ENV,
  PI_PROVIDER_SIGNALS,
  PI_SYSTEMD_ENV,
  piAuthCheckArgs,
  piProfileRefused,
} from './sign-in';

let dir: string;
let home: string;
let binary: string;

/**
 * A stand-in `pi`: `--version` prints `version`; `auth check --provider <p>`
 * answers what `answers/<p>` holds, with the exit code in `answers/<p>.rc`, or,
 * when `answers/<p>.needs` names a variable, ready only if that variable reached
 * it. `answers/<p>.sleep` makes it sleep that many seconds instead of answering;
 * `answers/<p>.signal`, print its answer and die of SIGTERM; `answers/<p>.trap`,
 * wait until told to stop, then print its answer and exit 0; `answers/<p>.ignore`,
 * record its pid in `answers/<p>.pid`, ignore SIGTERM, sleep that many seconds,
 * then print its answer and exit 0. Every call's argv and agent directory are
 * recorded.
 */
const FAKE_PI = (root: string) => `#!/bin/sh
printf '%s\\n' "$*" >> "${root}/argv"
printf '%s\\n' "$PI_CODING_AGENT_DIR" >> "${root}/agent-dir"
if [ "$1" = "--version" ]; then cat "${root}/version"; exit 0; fi
p="$4"
f="${root}/answers/$p"
if [ -f "$f.sleep" ]; then exec sleep "$(cat "$f.sleep")"; fi
if [ -f "$f.signal" ]; then cat "$f"; kill -TERM $$; fi
if [ -f "$f.trap" ]; then
  trap 'cat "$f"; exit 0' TERM
  sleep 5 >/dev/null 2>&1 &
  wait
fi
if [ -f "$f.ignore" ]; then
  trap '' TERM
  echo $$ > "$f.pid"
  sleep "$(cat "$f.ignore")"
  cat "$f"; exit 0
fi
if [ -f "$f.needs" ]; then
  name=$(cat "$f.needs")
  eval "value=\\$$name"
  if [ -n "$value" ]; then echo "{\\"status\\":\\"ready\\",\\"provider\\":\\"$p\\",\\"authType\\":\\"api_key\\"}"; exit 0; fi
  echo "{\\"status\\":\\"not_ready\\",\\"provider\\":\\"$p\\",\\"reason\\":\\"credentials_not_configured\\"}"; exit 1
fi
if [ -f "$f" ]; then cat "$f"; exit $(cat "$f.rc"); fi
echo "{\\"status\\":\\"not_ready\\",\\"provider\\":\\"$p\\",\\"reason\\":\\"provider_not_found\\"}"
exit 1
`;

function answer(provider: string, json: object | string, rc: number): void {
  writeFileSync(
    join(dir, 'answers', provider),
    typeof json === 'string' ? json : JSON.stringify(json)
  );
  writeFileSync(join(dir, 'answers', `${provider}.rc`), String(rc));
}

const ready = (provider: string) =>
  answer(provider, { status: 'ready', provider, authType: 'api_key' }, 0);
const missing = (provider: string) =>
  answer(provider, { status: 'not_ready', provider, reason: 'credentials_not_configured' }, 1);

function calls(): string[] {
  const path = join(dir, 'argv');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
}

function input(env: Record<string, string> = {}) {
  return { binaryPath: binary, cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: home, ...env } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-sign-in-'));
  home = join(dir, 'home');
  mkdirSync(join(dir, 'answers'));
  mkdirSync(home);
  writeFileSync(join(dir, 'version'), '1.4.0\n');
  binary = join(dir, 'pi');
  writeFileSync(binary, FAKE_PI(dir));
  chmodSync(binary, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PI_LOGIN', () => {
  it('passes the core registry’s pattern and opens Pi offline in Switch’s profile', () => {
    // core/tests/switch_core/providers/test_provider_registry.py reads it with this.
    const found = /PI_LOGIN = '([^']+)'/.exec(
      readFileSync(join(import.meta.dirname, 'sign-in.ts'), 'utf8')
    );
    expect(found?.[1]).toBe(PI_LOGIN);
    expect(PI_LOGIN).not.toContain("'");
    expect(PI_LOGIN).toBe(`PI_CODING_AGENT_DIR="${piAgentDir({ HOME: '$HOME' })}" pi --offline`);
    expect(PI_LOGIN.split(' ')).toContain('--offline');
  });
});

describe('checkPiSignIn', () => {
  it('is signed in when Pi can use the provider a key in the environment names', async () => {
    ready('anthropic');
    const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }));
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('anthropic');
    expect(result.loginHelps).toBeUndefined();
  });

  it('asks only `--version --offline` and `auth check … --no-refresh --offline`, in Switch’s profile', async () => {
    ready('anthropic');
    await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }));
    expect(calls()).toEqual(['--version --offline', piAuthCheckArgs('anthropic').join(' ')]);
    const dirs = readFileSync(join(dir, 'agent-dir'), 'utf8').trim().split('\n');
    expect(new Set(dirs)).toEqual(new Set([piAgentDir({ HOME: home })]));
    for (const call of calls()) {
      expect(call).toContain('--offline');
      expect(call).not.toContain('--list-models');
      expect(call).not.toContain('--credentials');
    }
  });

  it('writes nothing: the profile is not created by a check', async () => {
    missing('anthropic');
    await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }));
    expect(existsSync(piAgentDir({ HOME: home }))).toBe(false);
  });

  it('is unconfigured, offering /login, when Pi has no credentials for it', async () => {
    missing('anthropic');
    const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }));
    expect(result.status).toBe('unconfigured');
    expect(result.message).toContain('then type /login, or set a provider API key');
    expect(result.message).toContain(PI_LOGIN);
    expect(result.loginHelps).toBeUndefined();
  });

  it('is unconfigured without asking Pi when nothing names a provider', async () => {
    const result = await checkPiSignIn(input());
    expect(result.status).toBe('unconfigured');
    expect(result.message).toContain('then type /login, or set a provider API key');
    expect(calls()).toEqual(['--version --offline']);
  });

  it('is unknown when Pi answers with no JSON, a broken state or a usage error', async () => {
    for (const [body, rc] of [
      ['Error: Auth checks require --provider', 2],
      [JSON.stringify({ status: 'invalid', provider: 'anthropic', reason: 'invalid_state' }), 1],
      [JSON.stringify({ status: 'ready', provider: 'someone-else' }), 0],
    ] as const) {
      answer('anthropic', body, rc);
      const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }));
      expect(result.status, body).toBe('unknown');
    }
  });

  describe('reads `pi auth check` by its exit and its JSON together (P-05)', () => {
    const json = (status: string, extra: object = {}) =>
      JSON.stringify({ status, provider: 'anthropic', ...extra });
    const READY = json('ready', { authType: 'api_key' });
    const NO_CREDENTIALS = json('not_ready', { reason: 'credentials_not_configured' });
    const NO_PROVIDER = json('not_ready', { reason: 'provider_not_found' });
    const BROKEN = json('invalid', { reason: 'invalid_state' });

    it.each([
      ['ready, exit 0', READY, 0, 'authenticated'],
      ['not_ready credentials_not_configured, exit 1', NO_CREDENTIALS, 1, 'unconfigured'],
      ['not_ready provider_not_found, exit 1', NO_PROVIDER, 1, 'unconfigured'],
      ['ready, exit 2', READY, 2, 'unknown'],
      ['ready, exit 1', READY, 1, 'unknown'],
      ['not_ready, exit 0', NO_CREDENTIALS, 0, 'unknown'],
      ['not_ready, exit 2', NO_CREDENTIALS, 2, 'unknown'],
      ['invalid invalid_state, exit 1', BROKEN, 1, 'unknown'],
      ['a usage error, exit 2', 'Error: Auth checks require --provider', 2, 'unknown'],
    ] as const)('%s → %s', async (_case, body, rc, status) => {
      answer('anthropic', body, rc);
      const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }));
      expect(result.status).toBe(status);
    });

    it('is unknown when Pi dies of a signal after printing ready', async () => {
      answer('anthropic', READY, 0);
      writeFileSync(join(dir, 'answers', 'anthropic.signal'), '');
      const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }));
      expect(result.status).toBe('unknown');
    });

    it('is unknown when Pi does not answer in time', async () => {
      writeFileSync(join(dir, 'answers', 'anthropic.sleep'), '5');
      const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }), {
        budgetMs: 300,
      });
      expect(result.status).toBe('unknown');
    });

    it('is unknown when Pi, told to stop when its time ran out, still exits 0 with ready', async () => {
      answer('anthropic', READY, 0);
      writeFileSync(join(dir, 'answers', 'anthropic.trap'), '');
      const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }), {
        budgetMs: 300,
      });
      expect(result.status).toBe('unknown');
    });

    it('is unknown when its time runs out, at once, with Pi killed, though Pi ignores SIGTERM', async () => {
      for (const provider of ['anthropic', 'openai']) {
        ready(provider);
        writeFileSync(join(dir, 'answers', `${provider}.ignore`), '4');
      }
      const started = performance.now();
      const result = await checkPiSignIn(
        input({ ANTHROPIC_API_KEY: 'fake-not-a-key', OPENAI_API_KEY: 'fake-not-a-key' }),
        { budgetMs: 300 }
      );
      const took = performance.now() - started;
      expect(result.status).toBe('unknown');
      // Its 300 ms for all of them and the version's question, far from the 4 s Pi would go on for.
      expect(took).toBeLessThan(1_500);
      expect(result.message).toContain('did not say whether it can use anthropic.');
      expect(result.message).toContain('not asked about openai');
      expect(calls().slice(1)).toEqual([piAuthCheckArgs('anthropic').join(' ')]);
      const pid = Number(readFileSync(join(dir, 'answers', 'anthropic.pid'), 'utf8'));
      expect(pid).toBeGreaterThan(0);
      // Killed, not left running: gone once Node has reaped it.
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let waited = 0; alive() && waited < 1_000; waited += 20)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(alive()).toBe(false);
    });
  });

  it('is unknown, asking nothing, when it has no time left for any provider', async () => {
    missing('anthropic');
    const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }), {
      budgetMs: 0,
    });
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('not asked about anthropic');
    expect(calls()).toEqual(['--version --offline']);
  });

  it('asks every provider named, however many: a working one past the eighth is signed in', async () => {
    const keys = {
      ANTHROPIC_API_KEY: 'fake-not-a-key',
      ANT_LING_API_KEY: 'fake-not-a-key',
      OPENAI_API_KEY: 'fake-not-a-key',
      AZURE_OPENAI_API_KEY: 'fake-not-a-key',
      AWS_BEARER_TOKEN_BEDROCK: 'fake-not-a-key',
      DEEPSEEK_API_KEY: 'fake-not-a-key',
      NVIDIA_API_KEY: 'fake-not-a-key',
      GEMINI_API_KEY: 'fake-not-a-key',
    };
    for (const provider of ['anthropic', 'ant-ling', 'openai', 'azure', 'amazon-bedrock'])
      missing(provider);
    for (const provider of ['deepseek', 'nvidia', 'google']) missing(provider);
    ready('openrouter');
    mkdirSync(piAgentDir({ HOME: home }), { recursive: true });
    writeFileSync(
      join(piAgentDir({ HOME: home }), 'auth.json'),
      JSON.stringify({ openrouter: { type: 'api_key', key: 'fake-not-a-key' } })
    );
    const result = await checkPiSignIn(input(keys));
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('openrouter');
    expect(calls().slice(1)).toHaveLength(9);
    expect(calls().at(-1)).toBe(piAuthCheckArgs('openrouter').join(' '));
  });

  it('is unknown, never unconfigured, when its time runs out before a provider is asked', async () => {
    const keys = { ANTHROPIC_API_KEY: 'fake-not-a-key', OPENAI_API_KEY: 'fake-not-a-key' };
    writeFileSync(join(dir, 'answers', 'anthropic.sleep'), '5');
    ready('openai');
    const result = await checkPiSignIn(input(keys), { budgetMs: 300 });
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('not asked about openai');
    expect(calls().slice(1)).toEqual([piAuthCheckArgs('anthropic').join(' ')]);
    // Given the time it needs, the same check is signed in.
    rmSync(join(dir, 'answers', 'anthropic.sleep'));
    missing('anthropic');
    expect((await checkPiSignIn(input(keys), { budgetMs: 10_000 })).status).toBe('authenticated');
  });

  it('asks no provider once the time that cut the last one short is spent, whatever the clock says', async () => {
    // The clock stands still, as it may lag the timer by a millisecond: the
    // timer that ended anthropic's check alone says the time is spent.
    const keys = { ANTHROPIC_API_KEY: 'fake-not-a-key', OPENAI_API_KEY: 'fake-not-a-key' };
    writeFileSync(join(dir, 'answers', 'anthropic.sleep'), '5');
    ready('openai');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const result = await checkPiSignIn(input(keys), { budgetMs: 300 });
      expect(result.status).toBe('unknown');
      expect(result.message).toContain('did not say whether it can use anthropic.');
      expect(result.message).toContain('not asked about openai');
      expect(calls().slice(1)).toEqual([piAuthCheckArgs('anthropic').join(' ')]);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps within the time the agent controller gives the whole probe', () => {
    // agent-controller/src/runtime.ts PROBE_TIMEOUT_MS, less the version's at most 15 s.
    expect(PI_CHECK_BUDGET_MS + 15_000).toBeLessThan(90_000);
  });

  it('checks every provider a key or a profile login names, signed in when any is', async () => {
    missing('anthropic');
    ready('openrouter');
    mkdirSync(piAgentDir({ HOME: home }), { recursive: true });
    writeFileSync(
      join(piAgentDir({ HOME: home }), 'auth.json'),
      JSON.stringify({ openrouter: { type: 'api_key', key: 'fake-not-a-key' } })
    );
    const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }));
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('openrouter');
    expect(calls().slice(1)).toEqual([
      piAuthCheckArgs('anthropic').join(' '),
      piAuthCheckArgs('openrouter').join(' '),
    ]);
  });

  it('names every provider it checked when none can be used', async () => {
    missing('anthropic');
    missing('openai');
    const result = await checkPiSignIn(
      input({ ANTHROPIC_API_KEY: 'fake-not-a-key', OPENAI_API_KEY: 'fake-not-a-key' })
    );
    expect(result.status).toBe('unconfigured');
    expect(result.message).toContain('anthropic, openai');
  });

  it('checks only the agent model’s provider when that is known', async () => {
    ready('openai');
    const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }), {
      modelProvider: 'openai',
    });
    expect(result.status).toBe('authenticated');
    expect(calls().slice(1)).toEqual([piAuthCheckArgs('openai').join(' ')]);
  });

  describe('asks about a provider signed in to without a key, with no login in the profile and no model', () => {
    const FEDERATION = {
      ANTHROPIC_FEDERATION_RULE_ID: 'fake-rule',
      ANTHROPIC_ORGANIZATION_ID: 'fake-org',
      ANTHROPIC_IDENTITY_TOKEN_FILE: '/fake/identity-token',
    };

    it('Anthropic’s workload identity federation, signed in when Pi says so', async () => {
      writeFileSync(join(dir, 'answers', 'anthropic.needs'), 'ANTHROPIC_IDENTITY_TOKEN_FILE');
      const result = await checkPiSignIn(input(FEDERATION));
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('anthropic');
      expect(calls().slice(1)).toEqual([piAuthCheckArgs('anthropic').join(' ')]);
      expect(existsSync(piAgentDir({ HOME: home }))).toBe(false);
    });

    it('Anthropic’s workload identity federation, unconfigured when Pi cannot use it', async () => {
      missing('anthropic');
      const result = await checkPiSignIn(input(FEDERATION));
      expect(result.status).toBe('unconfigured');
      expect(calls().slice(1)).toEqual([piAuthCheckArgs('anthropic').join(' ')]);
    });

    it.each([
      ['GOOGLE_CLOUD_PROJECT', { GOOGLE_CLOUD_PROJECT: 'fake-project' }],
      ['GCLOUD_PROJECT', { GCLOUD_PROJECT: 'fake-project' }],
    ])('Vertex’s application default credentials, with a project in %s', async (_, project) => {
      writeFileSync(join(dir, 'answers', 'google-vertex.needs'), 'GOOGLE_CLOUD_LOCATION');
      const result = await checkPiSignIn(
        input({ ...project, GOOGLE_CLOUD_LOCATION: 'fake-location' })
      );
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('google-vertex');
      expect(calls().slice(1)).toEqual([piAuthCheckArgs('google-vertex').join(' ')]);
    });

    it.each([
      ['federation without its token file', { ...FEDERATION, ANTHROPIC_IDENTITY_TOKEN_FILE: '' }],
      [
        'federation ids only',
        { ANTHROPIC_FEDERATION_RULE_ID: 'r', ANTHROPIC_ORGANIZATION_ID: 'o' },
      ],
      ['a Vertex location only', { GOOGLE_CLOUD_LOCATION: 'fake-location' }],
      ['a Vertex project only', { GOOGLE_CLOUD_PROJECT: 'fake-project' }],
    ])('but not for %s, which Pi cannot sign in with either', async (_, env) => {
      ready('anthropic');
      ready('google-vertex');
      const result = await checkPiSignIn(input(env));
      expect(result.status).toBe('unconfigured');
      expect(calls()).toEqual(['--version --offline']);
    });

    it('names only providers Pi has and only variables a session host passes Pi', () => {
      for (const [provider, sets] of Object.entries(PI_PROVIDER_SIGNALS)) {
        expect(PI_PROVIDER_ENV, provider).toHaveProperty([provider]);
        for (const name of sets.flat()) expect(PI_INHERIT_ENV, name).toContain(name);
      }
    });
  });

  it.each(['0.73.0', '1.4.1'])(
    'refuses Pi %s without offering /login, before asking about sign-in',
    async (version) => {
      writeFileSync(join(dir, 'version'), `${version}\n`);
      ready('anthropic');
      const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }));
      expect(result.status).toBe('unconfigured');
      expect(result.loginHelps).toBe(false);
      expect(result.message).toContain('install @earendil-works/pi-coding-agent@1.4.0');
      expect(calls()).toEqual(['--version --offline']);
    }
  );

  it('says why a Pi that could not be asked its version was refused, as unconfigured as before', async () => {
    ready('anthropic');
    for (const [prepare, reason] of [
      [() => rmSync(binary), 'ENOENT'],
      [() => chmodSync(binary, 0o644), 'EACCES'],
    ] as const) {
      writeFileSync(binary, FAKE_PI(dir));
      chmodSync(binary, 0o755);
      prepare();
      const result = await checkPiSignIn(input({ ANTHROPIC_API_KEY: 'fake-not-a-key' }));
      expect(result.status, reason).toBe('unconfigured');
      expect(result.loginHelps, reason).toBe(false);
      expect(result.message, reason).toContain(`did not print its version (${reason})`);
      expect(result.message, reason).toContain('install @earendil-works/pi-coding-agent@1.4.0');
    }
  });

  describe('on an agent controller whose agents are users of their own (systemd, Q5)', () => {
    const systemd = { [SHARED_GROUP_ENV]: '1' };

    it('takes a key from AGENT_ENV_VARS other than Anthropic’s through to Pi (SC28)', async () => {
      expect(AGENT_ENV_VARS).toContain('OPENAI_API_KEY');
      writeFileSync(join(dir, 'answers', 'openai.needs'), 'OPENAI_API_KEY');
      const result = await checkPiSignIn(input({ ...systemd, OPENAI_API_KEY: 'fake-not-a-key' }));
      expect(result.status).toBe('authenticated');
    });

    it('does not offer /login, and names the keys that reach agents, when none is set (SC28)', async () => {
      mkdirSync(piAgentDir({ HOME: home }), { recursive: true });
      writeFileSync(join(piAgentDir({ HOME: home }), 'auth.json'), JSON.stringify({ openai: {} }));
      ready('openai');
      const result = await checkPiSignIn(input(systemd));
      expect(result.status).toBe('unconfigured');
      expect(result.loginHelps).toBe(false);
      expect(result.message).toBe(PI_ENV_ONLY);
      for (const name of PI_SYSTEMD_ENV) expect(result.message).toContain(name);
      // A key the controller never hands an agent is not offered.
      expect(AGENT_ENV_VARS).not.toContain('DEEPSEEK_API_KEY');
      expect(result.message).not.toContain('DEEPSEEK_API_KEY');
      expect(calls()).toEqual(['--version --offline']);
    });

    it('does not offer /login when Pi does not say whether it can use a key (D-2)', async () => {
      answer('openai', 'Error: something went wrong', 2);
      const result = await checkPiSignIn(input({ ...systemd, OPENAI_API_KEY: 'fake-not-a-key' }));
      expect(result.status).toBe('unknown');
      expect(result.loginHelps).toBe(false);
      // Elsewhere /login may yet help.
      const elsewhere = await checkPiSignIn(input({ OPENAI_API_KEY: 'fake-not-a-key' }));
      expect(elsewhere.status).toBe('unknown');
      expect(elsewhere.loginHelps).toBeUndefined();
    });

    it('does not offer /login when the check runs out of time (D-2)', async () => {
      writeFileSync(join(dir, 'answers', 'openai.sleep'), '5');
      const result = await checkPiSignIn(input({ ...systemd, OPENAI_API_KEY: 'fake-not-a-key' }), {
        budgetMs: 300,
      });
      expect(result.status).toBe('unknown');
      expect(result.loginHelps).toBe(false);
    });

    it('does not offer /login when a key is set but Pi cannot use it', async () => {
      missing('openai');
      const result = await checkPiSignIn(input({ ...systemd, OPENAI_API_KEY: 'fake-not-a-key' }));
      expect(result.status).toBe('unconfigured');
      expect(result.loginHelps).toBe(false);
      expect(result.message).toContain(PI_ENV_ONLY);
    });
  });
});

describe('the Pi provider variables', () => {
  /** Never handed to an agent of its own by the controller (`systemd-runtime.ts` PATH_VARIABLES). */
  const CONTROLLER_PATH_VARIABLES = new Set(['GOOGLE_APPLICATION_CREDENTIALS', 'AWS_PROFILE']);

  it('named on systemd are exactly the Pi keys the controller passes an agent', () => {
    const passed = new Set<string>(AGENT_ENV_VARS);
    for (const name of PI_SYSTEMD_ENV) expect(passed.has(name), name).toBe(true);
    const reachable = Object.values(PI_PROVIDER_ENV)
      .flat()
      .filter((name) => passed.has(name) && !CONTROLLER_PATH_VARIABLES.has(name));
    expect(new Set(PI_SYSTEMD_ENV)).toEqual(new Set(reachable));
  });

  it('fit what the controller keeps of a message', () => {
    expect(PI_ENV_ONLY.length).toBeLessThanOrEqual(300);
  });

  it('are what a session host passes Pi, and never its agent directory', () => {
    for (const name of Object.values(PI_PROVIDER_ENV).flat())
      expect(PI_INHERIT_ENV).toContain(name);
    // What Pi's providers.md has a provider read beside its key, Azure's endpoint first.
    for (const name of [
      'AZURE_OPENAI_BASE_URL',
      'AZURE_OPENAI_RESOURCE_NAME',
      'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
      'AZURE_OPENAI_API_VERSION',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_GATEWAY_ID',
      'ANTHROPIC_FEDERATION_RULE_ID',
      'ANTHROPIC_ORGANIZATION_ID',
      'ANTHROPIC_IDENTITY_TOKEN_FILE',
      'ANTHROPIC_SERVICE_ACCOUNT_ID',
      'ANTHROPIC_WORKSPACE_ID',
      // And what AWS's SDK reads beside Bedrock's: a web identity's role, a
      // container endpoint's authorization, the profile files' places.
      'AWS_ROLE_ARN',
      'AWS_ROLE_SESSION_NAME',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
      'AWS_CONFIG_FILE',
      'AWS_SHARED_CREDENTIALS_FILE',
      // And the operator's shutting of the instance metadata service, or of its first version.
      'AWS_EC2_METADATA_DISABLED',
      'AWS_EC2_METADATA_V1_DISABLED',
    ])
      expect(PI_INHERIT_ENV, name).toContain(name);
    expect(PI_INHERIT_ENV).not.toContain('PI_CODING_AGENT_DIR');
    expect(PI_INHERIT_ENV).not.toContain('PI_OFFLINE');
  });
});

describe('piProfileRefused', () => {
  it('does not offer /login for a profile Switch refuses', () => {
    const result = piProfileRefused('it holds a models.json, which Switch does not support.');
    expect(result.status).toBe('unconfigured');
    expect(result.loginHelps).toBe(false);
    expect(result.message).toContain('models.json');
  });
});
