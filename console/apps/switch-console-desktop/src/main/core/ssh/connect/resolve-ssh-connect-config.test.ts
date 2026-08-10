import { PassThrough } from 'node:stream';
import type { IdentityCallback, ParsedKey, SignCallback } from 'ssh2';
import { BaseAgent, utils } from 'ssh2';
import { describe, expect, it } from 'vitest';
import type { SshConfig } from '@shared/core/ssh/ssh';
import {
  createSshConnectConfigResolver,
  resolveSshConnectConfig,
  type SshConnectDeps,
} from './resolve-ssh-connect-config';

function baseConfig(partial: Partial<SshConfig> = {}): SshConfig {
  return {
    name: 'Conn',
    host: 'manual.example.com',
    port: 22,
    username: 'alice',
    authType: 'password',
    useAgent: false,
    ...partial,
  };
}

function deps(overrides: Partial<SshConnectDeps> = {}): SshConnectDeps {
  return {
    readFile: async () => 'PRIVATE KEY',
    resolveSshConfig: async () => ({
      hostname: 'resolved.internal',
      user: 'resolved-user',
      port: 2201,
      identityFile: [],
      identityAgent: '/tmp/resolved-agent.sock',
      identityAgentDisabled: false,
      identitiesOnly: false,
      proxyCommand: undefined,
      proxyJump: undefined,
      forwardAgent: false,
    }),
    spawnProxyCommand: () => ({
      sock: new PassThrough(),
      cleanup: () => {},
      debugLogs: ['proxy-command'],
    }),
    spawnProxyJump: () => ({
      sock: new PassThrough(),
      cleanup: () => {},
      debugLogs: ['proxy-jump'],
    }),
    createAgent: () =>
      ({
        getIdentities: (callback) => callback(undefined, []),
        sign: (
          _pubKey,
          _data,
          callbackOrOptions?: SignCallback | object,
          callback?: SignCallback
        ) => {
          const cb = typeof callbackOrOptions === 'function' ? callbackOrOptions : callback;
          cb?.(undefined, Buffer.from('signature'));
        },
        getStream: (callback) => callback(undefined, new PassThrough()),
      }) satisfies BaseAgent,
    env: { SSH_AUTH_SOCK: '/tmp/default-agent.sock' },
    ...overrides,
  };
}

function parseFixturePublicKey(): ParsedKey {
  const parsed = utils.parseKey(
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILI4wa2zRZoB26D015dsafYmu3jDCI7rh26bFXZrUiAp test-key'
  );
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

function parseOtherFixturePublicKey(): ParsedKey {
  const parsed = utils.parseKey(
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDirp5l3HstiHjo9xk1xLcKc7sa5iwQll5OPktBKCnbUjJN6VoE+muKOczApr6ktC3lMShukoUU15w91Pqg+g4oox7qgf+lfQE3IAQH0oVl9mCHS/gngg6I7QocwE2ShMV4au6uw+SphEnQcvgKpipF0g3LWyANTqNQg64MPldnOWkNdvV+1mgJ6L04dJaswpvOJslzrgkUzu1SgrpWXrhiI+DGw1c4lgxOt6VUlh5u2w2skWaHdddAAENW61Yxhvwjois2zzOPGx/pzo3a0peST0bgQMoqKniDRvMOYP99EQ9D28uLn035mzKNYIooTc9lK/C2jItA3fwq9PHfCM1D other-key'
  );
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

describe('resolveSshConnectConfig', () => {
  it('uses ssh -G as authoritative for alias-backed ProxyCommand', async () => {
    const spawned: string[] = [];
    const result = await resolveSshConnectConfig(
      {
        kind: 'transient',
        config: baseConfig({
          sshConfigAlias: 'corp-dev',
          authType: 'agent',
        }),
      },
      deps({
        resolveSshConfig: async () => ({
          hostname: 'dev.internal',
          user: 'deploy',
          port: 2222,
          identityFile: [],
          identityAgent: '/tmp/agent.sock',
          identityAgentDisabled: false,
          identitiesOnly: false,
          proxyCommand: 'cloudflared access ssh --hostname %h',
          proxyJump: 'ignored-because-command-wins',
          forwardAgent: true,
        }),
        spawnProxyCommand: (command, tokens) => {
          spawned.push(`${command} ${tokens.host}:${tokens.port} ${tokens.username}`);
          return {
            sock: new PassThrough(),
            cleanup: () => {},
            debugLogs: ['command debug'],
          };
        },
      })
    );

    expect(result.config).toMatchObject({
      host: 'dev.internal',
      port: 2222,
      username: 'deploy',
      agent: '/tmp/agent.sock',
      agentForward: true,
    });
    expect(result.config.sock).toBeDefined();
    expect(spawned).toEqual(['cloudflared access ssh --hostname %h dev.internal:2222 deploy']);
    expect(result.debugLogs).toEqual(['command debug']);
  });

  it('ignores manual ProxyCommand but supports manual ProxyJump and ForwardAgent', async () => {
    const jumps: string[] = [];
    const result = await resolveSshConnectConfig(
      {
        kind: 'transient',
        config: {
          ...baseConfig({
            authType: 'password',
            forwardAgent: true,
            proxyJump: 'bastion',
          }),
          password: 'secret',
          proxyCommand: 'not part of SshConfig but should not execute',
        } as SshConfig & { password: string; proxyCommand: string },
      },
      deps({
        spawnProxyCommand: () => {
          throw new Error('manual proxy command must not execute');
        },
        spawnProxyJump: (jumpSpec, host, port) => {
          jumps.push(`${jumpSpec}->${host}:${port}`);
          return {
            sock: new PassThrough(),
            cleanup: () => {},
            debugLogs: ['jump debug'],
          };
        },
      })
    );

    expect(result.config).toMatchObject({
      host: 'manual.example.com',
      port: 22,
      username: 'alice',
      password: 'secret',
      agentForward: true,
      agent: '/tmp/default-agent.sock',
    });
    expect(jumps).toEqual(['bastion->manual.example.com:22']);
    expect(result.debugLogs).toEqual(['jump debug']);
  });

  it('honors alias-resolved IdentityAgent none and SSH_AUTH_SOCK values', async () => {
    await expect(
      resolveSshConnectConfig(
        {
          kind: 'transient',
          config: baseConfig({ sshConfigAlias: 'corp-dev', authType: 'agent' }),
        },
        deps({
          resolveSshConfig: async () => ({
            hostname: 'dev.internal',
            user: 'alice',
            port: 22,
            identityFile: [],
            identityAgent: undefined,
            identityAgentDisabled: true,
            identitiesOnly: false,
            proxyCommand: undefined,
            proxyJump: undefined,
            forwardAgent: false,
          }),
        })
      )
    ).rejects.toThrow('SSH agent is disabled');

    await expect(
      resolveSshConnectConfig(
        {
          kind: 'transient',
          config: baseConfig({ sshConfigAlias: 'corp-dev', authType: 'agent' }),
        },
        deps({
          env: { SSH_AUTH_SOCK: '/tmp/default-agent.sock' },
          resolveSshConfig: async () => ({
            hostname: 'dev.internal',
            user: 'alice',
            port: 22,
            identityFile: [],
            identityAgent: 'SSH_AUTH_SOCK',
            identityAgentDisabled: false,
            identitiesOnly: false,
            proxyCommand: undefined,
            proxyJump: undefined,
            forwardAgent: false,
          }),
        })
      )
    ).resolves.toMatchObject({
      config: { agent: '/tmp/default-agent.sock' },
    });
  });

  it('limits alias-backed agent auth to IdentityFile keys when IdentitiesOnly is enabled', async () => {
    const readFiles: string[] = [];
    const allowedKey = parseFixturePublicKey();
    const deniedKey = parseOtherFixturePublicKey();
    const result = await resolveSshConnectConfig(
      {
        kind: 'transient',
        config: baseConfig({ sshConfigAlias: 'corp-dev', authType: 'agent' }),
      },
      deps({
        readFile: async (path) => {
          readFiles.push(path);
          return 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILI4wa2zRZoB26D015dsafYmu3jDCI7rh26bFXZrUiAp test-key';
        },
        env: { SSH_AUTH_SOCK: '/tmp/default-agent.sock' },
        createAgent: () =>
          ({
            getIdentities: (callback) =>
              callback(undefined, [{ pubKey: { pubKey: allowedKey } }, deniedKey]),
            sign: (
              _pubKey,
              _data,
              callbackOrOptions?: SignCallback | object,
              callback?: SignCallback
            ) => {
              const cb = typeof callbackOrOptions === 'function' ? callbackOrOptions : callback;
              cb?.(undefined, Buffer.from('signature'));
            },
            getStream: (callback) => callback(undefined, new PassThrough()),
          }) satisfies BaseAgent,
        resolveSshConfig: async () => ({
          hostname: 'dev.internal',
          user: 'alice',
          port: 22,
          identityFile: ['~/.ssh/corp_ed25519'],
          identityAgent: 'SSH_AUTH_SOCK',
          identityAgentDisabled: false,
          identitiesOnly: true,
          proxyCommand: undefined,
          proxyJump: undefined,
          forwardAgent: false,
        }),
      })
    );

    expect(readFiles).toEqual([
      expect.stringContaining('/.ssh/corp_ed25519'),
      expect.stringContaining('/.ssh/corp_ed25519.pub'),
    ]);
    expect(result.config.agent).toEqual(
      expect.objectContaining({ kind: 'identity-filtered-agent' })
    );
    const agent = result.config.agent as BaseAgent;
    const identities = await new Promise<unknown[]>((resolve, reject) => {
      agent.getIdentities((error, keys) => {
        if (error) reject(error);
        else resolve(keys ?? []);
      });
    });
    expect(identities).toHaveLength(1);
    const signature = await new Promise<Buffer>((resolve, reject) => {
      agent.sign(allowedKey, Buffer.from('payload'), (error, signed) => {
        if (error) reject(error);
        else resolve(signed ?? Buffer.alloc(0));
      });
    });
    expect(signature.toString()).toBe('signature');
    await expect(
      new Promise((resolve, reject) => {
        agent.getStream?.((error, stream) => {
          if (error) reject(error);
          else resolve(stream);
        });
      })
    ).resolves.toBeInstanceOf(PassThrough);
  });

  it('builds an IdentitiesOnly agent ssh2 accepts when ForwardAgent is enabled', async () => {
    const allowedKey = parseFixturePublicKey();
    const result = await resolveSshConnectConfig(
      {
        kind: 'transient',
        config: baseConfig({ sshConfigAlias: 'corp-dev', authType: 'agent' }),
      },
      deps({
        readFile: async () =>
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILI4wa2zRZoB26D015dsafYmu3jDCI7rh26bFXZrUiAp test-key',
        env: { SSH_AUTH_SOCK: '/tmp/default-agent.sock' },
        createAgent: () =>
          ({
            getIdentities: (callback: IdentityCallback) => callback(undefined, [allowedKey]),
            sign: (_pubKey: unknown, _data: unknown, _options: unknown, callback?: SignCallback) =>
              callback?.(undefined, Buffer.from('signature')),
          }) as unknown as BaseAgent,
        resolveSshConfig: async () => ({
          hostname: 'dev.internal',
          user: 'alice',
          port: 22,
          identityFile: ['~/.ssh/corp_ed25519'],
          identityAgent: 'SSH_AUTH_SOCK',
          identityAgentDisabled: false,
          identitiesOnly: true,
          proxyCommand: undefined,
          proxyJump: undefined,
          forwardAgent: true,
        }),
      })
    );

    expect(result.config.agentForward).toBe(true);
    // ssh2 gates custom agents on `instanceof BaseAgent` and drops anything
    // that only duck-types the interface, which breaks agent forwarding.
    expect(result.config.agent).toBeInstanceOf(BaseAgent);
  });

  it('does not expose agent getStream when the wrapped agent does not support it', async () => {
    const result = await resolveSshConnectConfig(
      {
        kind: 'transient',
        config: baseConfig({ sshConfigAlias: 'corp-dev', authType: 'agent' }),
      },
      deps({
        readFile: async () =>
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILI4wa2zRZoB26D015dsafYmu3jDCI7rh26bFXZrUiAp test-key',
        createAgent: () =>
          ({
            getIdentities: (callback) => callback(undefined, [parseFixturePublicKey()]),
            sign: (
              _pubKey,
              _data,
              callbackOrOptions?: SignCallback | object,
              callback?: SignCallback
            ) => {
              const cb = typeof callbackOrOptions === 'function' ? callbackOrOptions : callback;
              cb?.(undefined, Buffer.from('signature'));
            },
          }) satisfies BaseAgent,
        resolveSshConfig: async () => ({
          hostname: 'dev.internal',
          user: 'alice',
          port: 22,
          identityFile: ['~/.ssh/corp_ed25519'],
          identityAgent: 'SSH_AUTH_SOCK',
          identityAgentDisabled: false,
          identitiesOnly: true,
          proxyCommand: undefined,
          proxyJump: undefined,
          forwardAgent: false,
        }),
      })
    );

    const agent = result.config.agent as BaseAgent;
    expect('getStream' in agent).toBe(false);
    expect(agent.getStream).toBeUndefined();
  });

  it('rejects IdentitiesOnly when no IdentityFile public or private keys can be loaded', async () => {
    await expect(
      resolveSshConnectConfig(
        {
          kind: 'transient',
          config: baseConfig({ sshConfigAlias: 'corp-dev', authType: 'agent' }),
        },
        deps({
          readFile: async () => {
            throw new Error('missing key');
          },
          resolveSshConfig: async () => ({
            hostname: 'dev.internal',
            user: 'alice',
            port: 22,
            identityFile: ['~/.ssh/missing'],
            identityAgent: '/tmp/auth-agent.sock',
            identityAgentDisabled: false,
            identitiesOnly: true,
            proxyCommand: undefined,
            proxyJump: undefined,
            forwardAgent: false,
          }),
        })
      )
    ).rejects.toThrow('IdentitiesOnly is enabled');
  });

  it('uses SSH_AUTH_SOCK for ForwardAgent yes even when IdentityAgent disables auth agent selection', async () => {
    await expect(
      resolveSshConnectConfig(
        {
          kind: 'transient',
          config: {
            ...baseConfig({ sshConfigAlias: 'corp-dev', authType: 'password' }),
            password: 'pw',
          },
        },
        deps({
          env: { SSH_AUTH_SOCK: '/tmp/default-agent.sock' },
          resolveSshConfig: async () => ({
            hostname: 'dev.internal',
            user: 'alice',
            port: 22,
            identityFile: [],
            identityAgent: undefined,
            identityAgentDisabled: true,
            identitiesOnly: false,
            proxyCommand: undefined,
            proxyJump: undefined,
            forwardAgent: true,
          }),
        })
      )
    ).resolves.toMatchObject({
      config: {
        password: 'pw',
        agentForward: true,
        agent: '/tmp/default-agent.sock',
      },
    });
  });

  it('fails clearly when required auth or forwarding credentials are unavailable', async () => {
    await expect(
      resolveSshConnectConfig(
        {
          kind: 'transient',
          config: baseConfig({ authType: 'password' }),
        },
        deps()
      )
    ).rejects.toThrow('No password found');

    await expect(
      resolveSshConnectConfig(
        {
          kind: 'transient',
          config: baseConfig({ authType: 'key', privateKeyPath: undefined }),
        },
        deps({
          resolveSshConfig: async () => ({
            ...(await deps().resolveSshConfig('x')),
            identityFile: [],
          }),
        })
      )
    ).rejects.toThrow('Private key path is required');

    await expect(
      resolveSshConnectConfig(
        {
          kind: 'transient',
          config: baseConfig({ authType: 'agent' }),
        },
        deps({
          env: {},
          resolveSshConfig: async () => {
            throw new Error('no matching ssh config');
          },
        })
      )
    ).rejects.toThrow('SSH agent socket not found');

    await expect(
      resolveSshConnectConfig(
        {
          kind: 'transient',
          config: { ...baseConfig({ authType: 'password', forwardAgent: true }), password: 'pw' },
        },
        deps({ env: {} })
      )
    ).rejects.toThrow('no SSH agent socket is available');
  });

  it('uses ForwardAgent socket values from ssh config instead of the default agent', async () => {
    await expect(
      resolveSshConnectConfig(
        {
          kind: 'transient',
          config: {
            ...baseConfig({ sshConfigAlias: 'corp-dev', authType: 'password' }),
            password: 'pw',
          },
        },
        deps({
          env: { WORK_AGENT: '/tmp/work-agent.sock', SSH_AUTH_SOCK: '/tmp/default-agent.sock' },
          resolveSshConfig: async () => ({
            hostname: 'dev.internal',
            user: 'alice',
            port: 22,
            identityFile: [],
            identityAgent: undefined,
            identityAgentDisabled: false,
            identitiesOnly: false,
            proxyCommand: undefined,
            proxyJump: undefined,
            forwardAgent: true,
            forwardAgentValue: '$WORK_AGENT',
          }),
        })
      )
    ).resolves.toMatchObject({
      config: {
        agentForward: true,
        agent: '/tmp/work-agent.sock',
      },
    });
  });

  it('rejects split auth and forwarding agent sockets when using agent auth', async () => {
    await expect(
      resolveSshConnectConfig(
        {
          kind: 'transient',
          config: baseConfig({ sshConfigAlias: 'corp-dev', authType: 'agent' }),
        },
        deps({
          resolveSshConfig: async () => ({
            hostname: 'dev.internal',
            user: 'alice',
            port: 22,
            identityFile: [],
            identityAgent: '/tmp/auth-agent.sock',
            identityAgentDisabled: false,
            identitiesOnly: false,
            proxyCommand: undefined,
            proxyJump: undefined,
            forwardAgent: true,
            forwardAgentValue: '/tmp/forward-agent.sock',
          }),
        })
      )
    ).rejects.toThrow('different SSH agent sockets');
  });

  it('rejects split ForwardAgent sockets when IdentitiesOnly wraps agent auth', async () => {
    await expect(
      resolveSshConnectConfig(
        {
          kind: 'transient',
          config: baseConfig({ sshConfigAlias: 'corp-dev', authType: 'agent' }),
        },
        deps({
          readFile: async () =>
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILI4wa2zRZoB26D015dsafYmu3jDCI7rh26bFXZrUiAp test-key',
          resolveSshConfig: async () => ({
            hostname: 'dev.internal',
            user: 'alice',
            port: 22,
            identityFile: ['~/.ssh/corp_ed25519'],
            identityAgent: '/tmp/auth-agent.sock',
            identityAgentDisabled: false,
            identitiesOnly: true,
            proxyCommand: undefined,
            proxyJump: undefined,
            forwardAgent: true,
            forwardAgentValue: '/tmp/forward-agent.sock',
          }),
        })
      )
    ).rejects.toThrow('different SSH agent sockets');
  });

  it('creates a production resolver with explicit dependencies', async () => {
    const resolver = createSshConnectConfigResolver(deps());

    await expect(
      resolver({
        kind: 'transient',
        config: { ...baseConfig({ authType: 'password' }), password: 'pw' },
      })
    ).resolves.toMatchObject({
      config: { password: 'pw' },
    });
  });

  it('returns the live proxy debug log array rather than a one-time snapshot', async () => {
    const debugLogs: string[] = [];
    const result = await resolveSshConnectConfig(
      {
        kind: 'transient',
        config: { ...baseConfig({ authType: 'password', proxyJump: 'bastion' }), password: 'pw' },
      },
      deps({
        spawnProxyJump: () => ({
          sock: new PassThrough(),
          cleanup: () => {},
          debugLogs,
        }),
      })
    );

    debugLogs.push('late stderr');
    expect(result.debugLogs).toContain('late stderr');
  });

  it('preserves ConnectTimeout 0 as an infinite ssh2 ready timeout', async () => {
    const result = await resolveSshConnectConfig(
      {
        kind: 'transient',
        config: baseConfig({ sshConfigAlias: 'corp-dev', authType: 'agent' }),
      },
      deps({
        resolveSshConfig: async () => ({
          hostname: 'dev.internal',
          user: 'deploy',
          port: 22,
          identityFile: [],
          identityAgent: '/tmp/agent.sock',
          identityAgentDisabled: false,
          identitiesOnly: false,
          proxyCommand: undefined,
          proxyJump: undefined,
          forwardAgent: false,
          connectTimeout: 0,
        }),
      })
    );

    expect(result.config.readyTimeout).toBe(0);
  });

  it('uses the first alias identity file and inline passphrase for key auth', async () => {
    const readFiles: string[] = [];
    const result = await resolveSshConnectConfig(
      {
        kind: 'transient',
        config: {
          ...baseConfig({ sshConfigAlias: 'corp-dev', authType: 'key', privateKeyPath: undefined }),
          passphrase: 'inline-passphrase',
        },
      },
      deps({
        readFile: async (path) => {
          readFiles.push(path);
          return 'KEY DATA';
        },
        resolveSshConfig: async () => ({
          hostname: 'dev.internal',
          user: 'deploy',
          port: 2222,
          identityFile: ['~/.ssh/corp_ed25519', '~/.ssh/fallback'],
          identityAgent: undefined,
          identityAgentDisabled: false,
          identitiesOnly: true,
          proxyCommand: undefined,
          proxyJump: undefined,
          forwardAgent: false,
        }),
      })
    );

    expect(readFiles).toEqual([expect.stringContaining('/.ssh/corp_ed25519')]);
    expect(result.config).toMatchObject({
      host: 'dev.internal',
      port: 2222,
      username: 'deploy',
      privateKey: 'KEY DATA',
      passphrase: 'inline-passphrase',
    });
  });

  it('offers an unencrypted IdentityFile key from disk alongside the agent (gcloud/IAP)', async () => {
    const keyPair = utils.generateKeyPairSync('ed25519');
    const readFiles: string[] = [];
    const result = await resolveSshConnectConfig(
      {
        kind: 'transient',
        config: baseConfig({ sshConfigAlias: 'dev-vm', authType: 'agent' }),
      },
      deps({
        readFile: async (path) => {
          readFiles.push(path);
          return keyPair.private;
        },
        env: { SSH_AUTH_SOCK: '/tmp/default-agent.sock' },
        resolveSshConfig: async () => ({
          hostname: 'dev.internal',
          user: 'louis',
          port: 22,
          identityFile: ['~/.ssh/google_compute_engine'],
          identityAgent: 'SSH_AUTH_SOCK',
          identityAgentDisabled: false,
          identitiesOnly: false,
          proxyCommand: undefined,
          proxyJump: undefined,
          forwardAgent: false,
        }),
      })
    );

    expect(readFiles).toEqual([expect.stringContaining('/.ssh/google_compute_engine')]);
    expect(result.config).toMatchObject({
      agent: '/tmp/default-agent.sock',
      privateKey: keyPair.private,
    });
  });

  it('uses an on-disk IdentityFile key when the agent socket is unavailable', async () => {
    const keyPair = utils.generateKeyPairSync('ed25519');
    const result = await resolveSshConnectConfig(
      {
        kind: 'transient',
        config: baseConfig({ sshConfigAlias: 'dev-vm', authType: 'agent' }),
      },
      deps({
        readFile: async () => keyPair.private,
        env: {},
        resolveSshConfig: async () => ({
          hostname: 'dev.internal',
          user: 'louis',
          port: 22,
          identityFile: ['~/.ssh/google_compute_engine'],
          identityAgent: 'SSH_AUTH_SOCK',
          identityAgentDisabled: false,
          identitiesOnly: false,
          proxyCommand: undefined,
          proxyJump: undefined,
          forwardAgent: false,
        }),
      })
    );

    expect(result.config.privateKey).toBe(keyPair.private);
    expect(result.config.agent).toBeUndefined();
  });

  it('treats a blank private key path as absent for alias-backed key auth', async () => {
    const readFiles: string[] = [];
    const result = await resolveSshConnectConfig(
      {
        kind: 'transient',
        config: baseConfig({ sshConfigAlias: 'corp-dev', authType: 'key', privateKeyPath: '' }),
      },
      deps({
        readFile: async (path) => {
          readFiles.push(path);
          return 'ALIAS KEY';
        },
        resolveSshConfig: async () => ({
          hostname: 'dev.internal',
          user: 'deploy',
          port: 2222,
          identityFile: ['~/.ssh/corp_ed25519'],
          identityAgent: undefined,
          identityAgentDisabled: false,
          identitiesOnly: true,
          proxyCommand: undefined,
          proxyJump: undefined,
          forwardAgent: false,
        }),
      })
    );

    expect(readFiles).toEqual([expect.stringContaining('/.ssh/corp_ed25519')]);
    expect(result.config.privateKey).toBe('ALIAS KEY');
  });
});
