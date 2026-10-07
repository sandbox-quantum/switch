import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { defaultDataDir } from './paths';
import { launchdPlist, serviceIdentity, systemdUnit, type ServiceSpec } from './service';

const SPEC: ServiceSpec = {
  node: '/usr/bin/node',
  cli: '/home/me/.local/lib/node_modules/switch-agent-controller/cli.mjs',
  dataDir: '/srv/controller data',
  envFile: '/home/me/agents.env',
  sharedHostBundle: null,
  path: '/home/me/.local/bin:/usr/bin:/bin',
};

describe('systemdUnit', () => {
  it('runs the controller on its data directory, restarting on exit code 1 only', () => {
    const unit = systemdUnit(SPEC);
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/home/me/.local/lib/node_modules/switch-agent-controller/cli.mjs" "run" "--data-dir" "/srv/controller data" "--env-file" "/home/me/agents.env"'
    );
    expect(unit).toContain('Environment="PATH=/home/me/.local/bin:/usr/bin:/bin"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartPreventExitStatus=2 3 4');
    expect(unit).not.toContain('--launchd');
  });
});

describe('launchdPlist', () => {
  it('runs with --launchd, restarts only an unsuccessful exit, and logs to a file', () => {
    const plist = launchdPlist(
      { ...SPEC, dataDir: '/Users/me/A & B' },
      'com.switch.agent-controller',
      '/Users/me/A & B/controller.log'
    );
    expect(plist).toContain('<string>/Users/me/A &amp; B</string>');
    expect(plist).toContain('<string>--launchd</string>');
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain(
      '<key>StandardErrorPath</key>\n  <string>/Users/me/A &amp; B/controller.log</string>'
    );
  });
});

describe('serviceIdentity', () => {
  it('names the default data directory plainly, and any other with a hash of its path', () => {
    const home = defaultDataDir({ platform: process.platform, env: process.env, home: homedir() });
    expect(serviceIdentity(home)).toEqual({
      unit: 'switch-agent-controller',
      label: 'com.switch.agent-controller',
    });
    const other = serviceIdentity('/srv/controller');
    expect(other.unit).toMatch(/^switch-agent-controller-[0-9a-f]{8}$/);
    expect(other.label).toMatch(/^com\.switch\.agent-controller\.[0-9a-f]{8}$/);
    expect(serviceIdentity('/srv/other').unit).not.toBe(other.unit);
  });
});
