import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../errors';
import { groupId, readCredentialFile, readEc2Config } from './config';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-ec2-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CREDENTIAL = 'swcc_test-placeholder';

describe('readCredentialFile', () => {
  it('reads the credential, trimmed', async () => {
    const path = join(dir, 'controller');
    writeFileSync(path, `  ${CREDENTIAL}\n`);
    expect(await readCredentialFile(path)).toBe(CREDENTIAL);
  });

  it('refuses anything else without repeating it', async () => {
    for (const body of ['', 'swct_not-a-credential', 'swcc_two words', 'password']) {
      const path = join(dir, 'controller');
      writeFileSync(path, body);
      const error = await readCredentialFile(path).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConfigurationError);
      if (body) expect((error as Error).message).not.toContain(body);
    }
    await expect(readCredentialFile(join(dir, 'missing'))).rejects.toThrow(/ENOENT/);
  });
});

const CONFIG = {
  controllerId: 'ctl-1',
  server: 'https://switch.example.com/',
  relayPort: 47100,
  instanceId: 'i-0123456789abcdef0',
  bootId: '8a6c3d1e-0000-4000-8000-000000000000',
  kms: {
    keyArn: 'arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000',
    region: 'us-east-1',
    grantTokens: ['grant-token-placeholder'],
    context: {
      'switch:tenant': 'tenant-1',
      'switch:owner_id': 'owner-1',
      'switch:controller_id': 'ctl-1',
    },
  },
  sharedHostBundle: '/opt/switch/agent-providers/shared-host-daemon.mjs',
  nodePath: '/opt/switch/node/bin/node',
  providers: {
    claude: '/opt/switch/providers/claude',
    codex: '/opt/switch/providers/codex',
    opencode: '/opt/switch/providers/opencode',
    cursor: '/opt/switch/providers/cursor-agent',
    antigravity: '/opt/switch/providers/antigravity-acp',
  },
};

describe('readEc2Config', () => {
  it('reads the machine configuration the boot unit writes', async () => {
    const path = join(dir, 'controller.json');
    writeFileSync(path, JSON.stringify(CONFIG));
    const config = await readEc2Config(path);
    expect(config.server).toBe('https://switch.example.com');
    expect(config.kms.endpoint).toBeUndefined();
    expect(config.providers.cursor).toBe('/opt/switch/providers/cursor-agent');
  });

  it('reads a machine whose image installed only claude', async () => {
    const path = join(dir, 'controller.json');
    writeFileSync(
      path,
      JSON.stringify({ ...CONFIG, providers: { claude: CONFIG.providers.claude } })
    );
    const config = await readEc2Config(path);
    expect(config.providers).toEqual({ claude: '/opt/switch/providers/claude' });
  });

  it('refuses a context for another controller, or an unsafe instance id', async () => {
    const path = join(dir, 'controller.json');
    writeFileSync(
      path,
      JSON.stringify({
        ...CONFIG,
        kms: { ...CONFIG.kms, context: { ...CONFIG.kms.context, 'switch:controller_id': 'ctl-2' } },
      })
    );
    await expect(readEc2Config(path)).rejects.toThrow(/another controller/);
    writeFileSync(path, JSON.stringify({ ...CONFIG, instanceId: 'i-1\r\nX: y' }));
    await expect(readEc2Config(path)).rejects.toThrow(/instanceId/);
  });
});

describe('groupId', () => {
  it('finds a group by name', async () => {
    const path = join(dir, 'group');
    writeFileSync(path, 'root:x:0:\nswitch-agent:x:998:switch-controller\n');
    expect(await groupId('switch-agent', path)).toBe(998);
    await expect(groupId('nobody-here', path)).rejects.toThrow(ConfigurationError);
  });
});
