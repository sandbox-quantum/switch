import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageDir } from './releases';
import {
  agentPath,
  agentUnitTemplate,
  controllerSystemUnit,
  defaultReleasesDir,
  ensureReleases,
  homeRootOf,
  planReleases,
  parsePasswd,
  polkitRule,
  type SeparateUsersConfig,
  separateUserNames,
  separateUsersConfigSchema,
  slotName,
  unitCredentialsPath,
} from './separate-users';

const config: SeparateUsersConfig = {
  v: 1,
  user: 'builder',
  uid: 1001,
  gid: 990,
  dataDir: '/home/builder/.local/state/switch/agent-controller',
  agentsDir: '/var/lib/switch-agents/1001',
  agentUsers: 4,
  node: '/usr/bin/node',
  bundle: '/usr/lib/node_modules/switch-agent-controller/shared-host.mjs',
  releasesDir: null,
};

function lines(text: string): string[] {
  return text.split('\n');
}

// Linux only: systemd and Linux users.
describe.skipIf(process.platform === 'win32')('separate users', () => {
  it('names everything after the controller user’s uid', () => {
    const names = separateUserNames(1001);
    expect(names.group).toBe('switch-agents-1001');
    expect(names.agentUnit(3)).toBe('switch-agent-1001@03.service');
    expect(names.agentUser(3)).toBe('sa1001-03');
    expect(names.controllerUnit).toBe('switch-agent-controller-1001.service');
    expect(unitCredentialsPath(config, 3)).toBe(
      '/run/credentials/switch-agent-1001@03.service/relay'
    );
    expect(() => slotName(0)).toThrow();
    expect(() => slotName(100)).toThrow();
    // A user name systemd and useradd both take: at most 31 characters, even for a 10-digit uid.
    expect(separateUserNames(4_294_967_294).agentUser(99).length).toBeLessThanOrEqual(31);
  });

  it('writes an agent unit that runs as the agent’s user and sees only its own directory', () => {
    const unit = lines(
      agentUnitTemplate(config, {
        sh: '/bin/sh',
        find: '/usr/bin/find',
        chown: '/usr/bin/chown',
        path: '/usr/local/bin:/usr/bin:/bin',
      })
    );
    expect(unit).toContain('User=sa1001-%i');
    expect(unit).toContain('Group=switch-agents-1001');
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /usr/lib/node_modules/switch-agent-controller/shared-host.mjs /var/lib/switch-agents/1001/agent/watcher /var/lib/switch-agents/1001/agent/watcher/config.json --watch-worker'
    );
    expect(unit).toContain(
      'LoadCredential=relay:/home/builder/.local/state/switch/agent-controller/units/%i/relay.json'
    );
    expect(unit).toContain('TemporaryFileSystem=/var/lib/switch-agents/1001:ro');
    // Every agent sees its own directory at the same path, whichever user it runs as.
    expect(unit).toContain(
      'BindPaths=/var/lib/switch-agents/1001/%i:/var/lib/switch-agents/1001/agent'
    );
    expect(unit).toContain('Environment=HOME=/var/lib/switch-agents/1001/agent/home');
    expect(unit).toContain('InaccessiblePaths=-/home/builder/.local/state/switch/agent-controller');
    expect(unit).toContain('ProtectHome=yes');
    expect(unit).toContain('ProtectProc=invisible');
    expect(unit).toContain('RestrictSUIDSGID=yes');
    expect(unit).toContain('IPAddressDeny=169.254.169.254/32 fd00:ec2::254/128');
    // Root hands back only what another agent user owns, never following a link.
    expect(unit).toContain(
      `ExecStartPre=+/bin/sh -c 'dir=/var/lib/switch-agents/1001/agent; [ -d "$$dir" ] || dir=/var/lib/switch-agents/1001/%i; exec /usr/bin/find "$$dir" -xdev -mindepth 1 -group switch-agents-1001 ! -user sa1001-%i ! -user 1001 -exec /usr/bin/chown --no-dereference sa1001-%i {} +'`
    );
  });

  it('lets the controller’s user manage its agents’ units and nothing else', () => {
    const rule = polkitRule(config);
    expect(rule).toContain('subject.user !== "builder"');
    expect(rule).toContain('/^switch-agent-1001@[0-9]{2}\\.service$/');
    expect(rule).toContain('["start", "stop", "restart", "reset-failed"]');
  });

  it('runs the controller as a system service of its user, in the agents’ group', () => {
    const unit = lines(
      controllerSystemUnit(config, {
        cli: '/usr/lib/node_modules/switch-agent-controller/cli.mjs',
        envFile: '/etc/switch/agents.env',
        path: '/usr/local/bin:/usr/bin:/bin',
      })
    );
    expect(unit).toContain('User=builder');
    expect(unit).toContain('SupplementaryGroups=switch-agents-1001');
    expect(unit).toContain('RestartPreventExitStatus=2 3 4 5 6');
    const exec = unit.find((line) => line.startsWith('ExecStart='))!;
    expect(exec).toContain(
      '"run" "--data-dir" "/home/builder/.local/state/switch/agent-controller"'
    );
    expect(exec).toContain('"--agent-runtime" "separate-user"');
    expect(exec).toContain('"--env-file" "/etc/switch/agents.env"');
  });

  it('keeps out of the agents’ PATH what they cannot reach', () => {
    expect(
      agentPath('/home/builder/.local/bin:/usr/local/bin:relative:/root/bin:/usr/bin', [
        '/srv/builder',
      ])
    ).toBe('/usr/local/bin:/usr/bin');
    expect(homeRootOf('/srv/builder/bin/claude', ['/srv/builder'])).toBe('/srv/builder');
    expect(homeRootOf('/home/builder/.local/bin/claude', [])).toBe('/home');
    expect(homeRootOf('/usr/local/bin/claude', [])).toBeNull();
    expect(homeRootOf('/homestead/bin', [])).toBeNull();
  });

  it('reads a passwd entry and checks a setup', () => {
    expect(parsePasswd('builder:x:1001:1001:Builder:/home/builder:/bin/bash\n')).toEqual({
      name: 'builder',
      uid: 1001,
      gid: 1001,
      home: '/home/builder',
    });
    expect(separateUsersConfigSchema.safeParse(config).success).toBe(true);
    expect(
      separateUsersConfigSchema.safeParse({ ...config, agentsDir: '/var/lib/with space' }).success
    ).toBe(false);
    expect(separateUsersConfigSchema.safeParse({ ...config, agentUsers: 100 }).success).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('releases directory', () => {
  const baked = {
    cli: '/opt/switch/controller/lib/node_modules/switch-agent-controller/cli.mjs',
    bundle: '/opt/switch/controller/lib/node_modules/switch-agent-controller/shared-host.mjs',
    uid: 2000,
    dataDir: '/data/.switch-controller',
    agentsDir: '/data/agents',
    homes: ['/nonexistent'],
  };

  it('runs the controller and its agents through current', () => {
    const plan = planReleases({ ...baked, releasesDir: '/data/controller-releases' });
    expect(plan).toEqual({
      dir: '/data/controller-releases',
      prefix: '/opt/switch/controller',
      cli: '/data/controller-releases/current/lib/node_modules/switch-agent-controller/cli.mjs',
      bundle:
        '/data/controller-releases/current/lib/node_modules/switch-agent-controller/shared-host.mjs',
    });
    expect(planReleases({ ...baked, releasesDir: null })?.dir).toBe(
      '/var/lib/switch-agent-controller-2000/releases'
    );
    expect(defaultReleasesDir(2000)).toBe('/var/lib/switch-agent-controller-2000/releases');

    const unitConfig: SeparateUsersConfig = {
      ...config,
      dataDir: baked.dataDir,
      agentsDir: baked.agentsDir,
      bundle: plan!.bundle,
      releasesDir: plan!.dir,
    };
    const agentUnit = lines(
      agentUnitTemplate(unitConfig, {
        sh: '/bin/sh',
        find: '/usr/bin/find',
        chown: '/usr/bin/chown',
        path: '/usr/bin:/bin',
      })
    );
    expect(agentUnit).toContain(
      'ExecStart=/usr/bin/node /data/controller-releases/current/lib/node_modules/switch-agent-controller/shared-host.mjs /data/agents/agent/watcher /data/agents/agent/watcher/config.json --watch-worker'
    );
    const controllerUnit = lines(
      controllerSystemUnit(unitConfig, { cli: plan!.cli, envFile: null, path: '/usr/bin:/bin' })
    );
    const exec = controllerUnit.find((line) => line.startsWith('ExecStart='))!;
    expect(exec).toContain(
      '"/usr/bin/node" "/data/controller-releases/current/lib/node_modules/switch-agent-controller/cli.mjs" "run"'
    );
    expect(exec).toContain(
      '"--shared-host-bundle" "/data/controller-releases/current/lib/node_modules/switch-agent-controller/shared-host.mjs"'
    );
    // 7 is restarting into an update: systemd must start it again.
    expect(controllerUnit).toContain('Restart=on-failure');
    const prevented = controllerUnit.find((line) => line.startsWith('RestartPreventExitStatus='))!;
    expect(prevented.split('=')[1]!.split(' ')).not.toContain('7');
  });

  it('keeps a bundle named outside the controller’s install where it is', () => {
    expect(
      planReleases({ ...baked, bundle: '/opt/shared-host.mjs', releasesDir: null })?.bundle
    ).toBe('/opt/shared-host.mjs');
  });

  it('has none for a controller that is not an npm install, and refuses one named for it', () => {
    const checkout = {
      ...baked,
      cli: '/srv/switch/console/packages/agent-controller/dist/cli.mjs',
    };
    expect(planReleases({ ...checkout, releasesDir: null })).toBeNull();
    expect(() => planReleases({ ...checkout, releasesDir: '/srv/releases' })).toThrow(
      /--releases-dir needs the controller installed with npm/
    );
  });

  it('refuses a directory agents cannot read', () => {
    for (const releasesDir of [
      '/data/.switch-controller/releases',
      '/data/agents/releases',
      '/home/builder/releases',
      '/nonexistent/releases',
      '/data',
      '/srv/with space',
    ])
      expect(() => planReleases({ ...baked, releasesDir }), releasesDir).toThrow(/--releases-dir/);
  });
});

describe.skipIf(process.platform === 'win32')('ensureReleases', () => {
  let dir: string;
  let releases: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ensure-releases-'));
    releases = join(dir, 'var', 'releases');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function release(prefix: string, version: string): string {
    mkdirSync(packageDir(prefix), { recursive: true });
    writeFileSync(join(packageDir(prefix), 'package.json'), JSON.stringify({ version }));
    return prefix;
  }

  const ensure = (prefix: string, version: string) =>
    ensureReleases({ releasesDir: releases, prefix, version, owner: null });

  it('makes the directory, readable by all, and points current at the installing release', async () => {
    const baked = release(join(dir, 'opt'), '0.30.0');
    await ensure(baked, '0.30.0');
    expect(statSync(releases).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(releases, 'current'))).toBe(baked);
  });

  it('replaces a dangling current, and one older than the installing release', async () => {
    const baked = release(join(dir, 'opt'), '0.30.0');
    mkdirSync(releases, { recursive: true });
    symlinkSync(join(releases, '0.29.0'), join(releases, 'current'));
    await ensure(baked, '0.30.0');
    expect(readlinkSync(join(releases, 'current'))).toBe(baked);

    rmSync(join(releases, 'current'));
    symlinkSync(release(join(releases, '0.29.0'), '0.29.0'), join(releases, 'current'));
    await ensure(baked, '0.30.0');
    expect(readlinkSync(join(releases, 'current'))).toBe(baked);
  });

  it('keeps a current as new as the installing release, or newer: an update applied since', async () => {
    const baked = release(join(dir, 'opt'), '0.30.0');
    mkdirSync(releases, { recursive: true });
    const updated = release(join(releases, '0.31.0'), '0.31.0');
    symlinkSync(updated, join(releases, 'current'));
    const note = await ensure(baked, '0.30.0');
    expect(readlinkSync(join(releases, 'current'))).toBe(updated);
    expect(note).toContain('0.31.0');
    // A newer image wins.
    const newer = release(join(dir, 'opt-new'), '0.32.0');
    await ensure(newer, '0.32.0');
    expect(readlinkSync(join(releases, 'current'))).toBe(newer);
    await ensure(newer, '0.32.0');
    expect(readlinkSync(join(releases, 'current'))).toBe(newer);
  });

  it('refuses a current that is not a link, and a directory that is a link', async () => {
    const baked = release(join(dir, 'opt'), '0.30.0');
    mkdirSync(join(releases, 'current'), { recursive: true });
    await expect(ensure(baked, '0.30.0')).rejects.toThrow(/is not a link/);
    rmSync(releases, { recursive: true });
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), releases);
    await expect(ensure(baked, '0.30.0')).rejects.toThrow(/is not a directory/);
  });
});
