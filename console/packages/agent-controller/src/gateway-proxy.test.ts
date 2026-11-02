import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CONFIGURATION } from './exit-codes';
import {
  carriesCredentials,
  forgetGatewayProxy,
  GATEWAY_PROXY_ENV,
  gatewayProxyProblem,
  heldGatewayProxy,
  takeGatewayProxy,
} from './gateway-proxy';
import { main } from './main';

// A made-up proxy user and password: never a real one.
const PASSWORD = 'pw-0123456789abcdef-test-only';
const GATEWAY_PROXY = `http://swgw-livebox:${PASSWORD}@squid-gw.egress-proxy.svc:3128`;

afterEach(() => {
  forgetGatewayProxy();
  delete process.env[GATEWAY_PROXY_ENV];
});

/** The environment a child process started the way the controller starts its children actually sees. */
function childEnvironment(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      // As detached-runtime.ts and launcher-spawn.ts do: this process's environment plus extras.
      { env: { ...env, SWITCH_AGENT_MARKER: 'stand-in' }, stdio: ['ignore', 'pipe', 'inherit'] }
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', () => resolve(out));
  });
}

describe("the gateway's proxy", () => {
  it('is taken out of the environment and held for the gateway', () => {
    const env: NodeJS.ProcessEnv = {
      [GATEWAY_PROXY_ENV]: GATEWAY_PROXY,
      HTTPS_PROXY: 'http://squid-gw.egress-proxy.svc:3128',
    };
    takeGatewayProxy(env);
    expect(env[GATEWAY_PROXY_ENV]).toBeUndefined();
    expect(heldGatewayProxy()).toBe(GATEWAY_PROXY);
    // The generic proxy, without credentials, stays for the agents.
    expect(env.HTTPS_PROXY).toBe('http://squid-gw.egress-proxy.svc:3128');
  });

  it('never reaches a child process the controller starts', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [GATEWAY_PROXY_ENV]: GATEWAY_PROXY,
      HTTPS_PROXY: 'http://squid-gw.egress-proxy.svc:3128',
    };
    takeGatewayProxy(env);
    const seen = await childEnvironment(env);
    expect(seen).toContain('SWITCH_AGENT_MARKER');
    expect(seen).not.toContain(GATEWAY_PROXY_ENV);
    expect(seen).not.toContain(PASSWORD);
    expect(seen).not.toContain('swgw-livebox');
  });

  it('is taken from the environment at start, whatever the command', async () => {
    process.env[GATEWAY_PROXY_ENV] = GATEWAY_PROXY;
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(await main(['--version'])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(process.env[GATEWAY_PROXY_ENV]).toBeUndefined();
    expect(heldGatewayProxy()).toBe(GATEWAY_PROXY);
    const seen = await childEnvironment(process.env);
    expect(seen).not.toContain(PASSWORD);
  });

  it('is refused when it is not an http(s) URL, without naming it, and still leaves the environment', () => {
    for (const bad of [`socks5://u:${PASSWORD}@proxy:1080`, `http://u:${PASSWORD}@`]) {
      const env: NodeJS.ProcessEnv = { [GATEWAY_PROXY_ENV]: bad };
      let message = '';
      try {
        takeGatewayProxy(env);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(GATEWAY_PROXY_ENV);
      expect(message).not.toContain(PASSWORD);
      expect(env[GATEWAY_PROXY_ENV]).toBeUndefined();
      expect(heldGatewayProxy()).toBeNull();
    }
  });

  it('refuses to start when an inherited proxy variable carries credentials too', () => {
    for (const name of [
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'ALL_PROXY',
      'all_proxy',
    ]) {
      const env: NodeJS.ProcessEnv = {
        [GATEWAY_PROXY_ENV]: GATEWAY_PROXY,
        [name]: `http://swgw-livebox:${PASSWORD}@squid-gw.egress-proxy.svc:3128`,
      };
      let message = '';
      try {
        takeGatewayProxy(env);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`${name} carries proxy credentials`);
      expect(message).not.toContain(PASSWORD);
      expect(heldGatewayProxy()).toBeNull();
    }
  });

  it('leaves an authenticating proxy alone when the gateway has no proxy of its own', () => {
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://desk-user:desk-pass@corp-proxy:8080' };
    takeGatewayProxy(env);
    expect(env.HTTPS_PROXY).toBe('http://desk-user:desk-pass@corp-proxy:8080');
    expect(heldGatewayProxy()).toBeNull();
  });

  it('keeps the one already held when a later env file has none, and an empty value clears it', () => {
    takeGatewayProxy({ [GATEWAY_PROXY_ENV]: GATEWAY_PROXY });
    takeGatewayProxy({});
    expect(heldGatewayProxy()).toBe(GATEWAY_PROXY);
    takeGatewayProxy({ [GATEWAY_PROXY_ENV]: '  ' });
    expect(heldGatewayProxy()).toBeNull();
  });
});

describe('split boxes only', () => {
  it("is refused without the split: agents there could read the controller's starting environment", () => {
    expect(gatewayProxyProblem(false)).toBeNull(); // nothing held: nothing to refuse
    takeGatewayProxy({ [GATEWAY_PROXY_ENV]: GATEWAY_PROXY });
    expect(gatewayProxyProblem(true)).toBeNull();
    const problem = gatewayProxyProblem(false) ?? '';
    expect(problem).toContain('is for split boxes only');
    expect(problem).not.toContain(PASSWORD);
  });

  it('lets a loopback split box (--launcher-address) past the check, unlike an unsplit one', async () => {
    // Everything split mode needs, so `run` reaches the gateway-proxy check, then stops on the next check
    // (--controller-id without --server), which proves it got past this one.
    const saved = {
      gateway: process.env.SWITCH_CONTROLLER_PROVIDER_GATEWAY,
      noProxy: process.env.NO_PROXY,
    };
    process.env.SWITCH_CONTROLLER_PROVIDER_GATEWAY = '1';
    process.env.NO_PROXY = '127.0.0.1';
    const args = [
      'run',
      '--data-dir',
      '/nonexistent/never-made',
      '--controller-id',
      'controller-1',
    ];
    const split = [
      '--launcher-address',
      '127.0.0.1:7420',
      '--agents-data-dir',
      '/nonexistent/agents',
      '--agents-workspaces',
      '/nonexistent/agents/workspaces',
    ];
    const run = async (extra: string[]) => {
      process.env[GATEWAY_PROXY_ENV] = GATEWAY_PROXY;
      const lines: string[] = [];
      const write = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        expect(await main([...args, ...extra])).toBe(EXIT_CONFIGURATION);
      } finally {
        process.stderr.write = write;
      }
      return lines.join('');
    };
    try {
      const splitSaid = await run(split);
      expect(splitSaid).not.toContain(`${GATEWAY_PROXY_ENV} is for split boxes only`);
      expect(splitSaid).toContain('--controller-id and --server adopt an identity together');
      const unsplitSaid = await run([]);
      expect(unsplitSaid).toContain(`${GATEWAY_PROXY_ENV} is for split boxes only`);
      for (const said of [splitSaid, unsplitSaid]) expect(said).not.toContain(PASSWORD);
    } finally {
      if (saved.gateway === undefined) delete process.env.SWITCH_CONTROLLER_PROVIDER_GATEWAY;
      else process.env.SWITCH_CONTROLLER_PROVIDER_GATEWAY = saved.gateway;
      if (saved.noProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = saved.noProxy;
    }
  });

  it('stops `run` on a box without --launcher-socket, before anything starts', async () => {
    process.env[GATEWAY_PROXY_ENV] = GATEWAY_PROXY;
    const lines: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main(['run', '--data-dir', '/nonexistent/never-made'])).toBe(EXIT_CONFIGURATION);
    } finally {
      process.stderr.write = write;
    }
    const said = lines.join('');
    expect(said).toContain(`${GATEWAY_PROXY_ENV} is for split boxes only`);
    expect(said).not.toContain(PASSWORD);
    expect(process.env[GATEWAY_PROXY_ENV]).toBeUndefined();
  });
});

describe('carriesCredentials', () => {
  it('finds a user or password, with or without a scheme, even in an unparsable value', () => {
    expect(carriesCredentials('http://u:p@proxy:3128')).toBe(true);
    expect(carriesCredentials('u@proxy:3128')).toBe(true);
    expect(carriesCredentials('http://u:p@[bad')).toBe(true);
    expect(carriesCredentials('http://proxy:3128')).toBe(false);
    expect(carriesCredentials('proxy:3128/path@x')).toBe(false);
    expect(carriesCredentials('')).toBe(false);
  });
});
