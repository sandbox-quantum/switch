import { describe, expect, it } from 'vitest';
import {
  agentPath,
  agentUnitTemplate,
  controllerSystemUnit,
  homeRootOf,
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
};

function lines(text: string): string[] {
  return text.split('\n');
}

describe('separate users', () => {
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
