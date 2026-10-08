import { createHash } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { ConfigurationError } from './errors';
import { defaultDataDir } from './paths';
import { CommandFailure, type CommandRunner } from './secrets';

/**
 * What the installed service runs: `node <cli> run` on one data directory,
 * with the PATH it was installed from, so the provider CLIs found then are
 * found by the service too.
 */
export type ServiceSpec = {
  node: string;
  cli: string;
  dataDir: string;
  envFile: string | null;
  sharedHostBundle: string | null;
  path: string;
};

/** How the service is known to its init system; see {@link serviceIdentity}. */
export type ServiceIdentity = {
  /** The systemd unit name, without `.service`. */
  unit: string;
  /** The launchd label. */
  label: string;
};

/**
 * One service per data directory: the default one gets the plain name, any
 * other a name carrying a hash of its path, so two controllers on one account
 * each get their own.
 */
export function serviceIdentity(dataDir: string): ServiceIdentity {
  const isDefault =
    dataDir === defaultDataDir({ platform: process.platform, env: process.env, home: homedir() });
  const suffix = isDefault
    ? ''
    : `-${createHash('sha256').update(dataDir).digest('hex').slice(0, 8)}`;
  return {
    unit: `switch-agent-controller${suffix}`,
    label: `com.switch.agent-controller${suffix.replace('-', '.')}`,
  };
}

function runArguments(spec: ServiceSpec, launchd: boolean): string[] {
  return [
    spec.node,
    spec.cli,
    'run',
    '--data-dir',
    spec.dataDir,
    ...(spec.envFile ? ['--env-file', spec.envFile] : []),
    ...(spec.sharedHostBundle ? ['--shared-host-bundle', spec.sharedHostBundle] : []),
    ...(launchd ? ['--launchd'] : []),
  ];
}

/**
 * The systemd user unit: restarted on exit code 1 only, since 2 (configuration),
 * 3 (revoked) and 4 (taken over) would fail the same way again.
 */
export function systemdUnit(spec: ServiceSpec): string {
  const quote = (value: string) => `"${value.replace(/(["\\])/g, '\\$1')}"`;
  return [
    '[Unit]',
    'Description=Switch agents controller',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${runArguments(spec, false).map(quote).join(' ')}`,
    `Environment=${quote(`PATH=${spec.path}`)}`,
    'Restart=on-failure',
    'RestartSec=5',
    'RestartPreventExitStatus=2 3 4 5 6',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The launchd agent. launchd cannot spare particular exit codes from a
 * restart, so the controller runs with `--launchd`, which ends with 0 on the
 * codes that must not restart (having logged why), and `KeepAlive` restarts
 * only an unsuccessful exit.
 */
export function launchdPlist(spec: ServiceSpec, label: string, logFile: string): string {
  const strings = (values: string[]) =>
    values.map((value) => `    <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(runArguments(spec, true))}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(spec.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

/** The exit codes `--launchd` turns into 0, so launchd does not restart into the same failure. */
export const LAUNCHD_FINAL_EXIT_CODES: readonly number[] = [2, 3, 4, 5, 6];

/** Where the service's files are, for this user. */
export type ServicePaths = {
  /** The systemd unit file, or the launchd plist. */
  file: string;
  /** Where launchd writes the controller's log; systemd keeps it in the journal. */
  logFile: string | null;
};

function systemdUserDir(env: NodeJS.ProcessEnv, home: string): string {
  const config = env.XDG_CONFIG_HOME;
  return join(config && isAbsolute(config) ? config : join(home, '.config'), 'systemd', 'user');
}

export function servicePaths(identity: ServiceIdentity, dataDir: string): ServicePaths {
  if (process.platform === 'darwin')
    return {
      file: join(homedir(), 'Library', 'LaunchAgents', `${identity.label}.plist`),
      logFile: join(dataDir, 'controller.log'),
    };
  if (process.platform === 'linux')
    return {
      file: join(systemdUserDir(process.env, homedir()), `${identity.unit}.service`),
      logFile: null,
    };
  throw new ConfigurationError(
    'install-service supports Linux (systemd) and macOS (launchd). Run `switch-agent-controller run` under your own supervisor elsewhere.'
  );
}

/** What installing said, for the person who ran it. */
export type InstallReport = { file: string; notes: string[] };

/** Writes the service for this user, and starts it now and at each login (or boot, with lingering). */
export async function installService(
  spec: ServiceSpec,
  run: CommandRunner
): Promise<InstallReport> {
  const identity = serviceIdentity(spec.dataDir);
  const paths = servicePaths(identity, spec.dataDir);
  await mkdir(dirname(paths.file), { recursive: true });
  const notes: string[] = [];
  if (process.platform === 'darwin') {
    if (!paths.logFile) throw new Error('A launchd agent needs a log file.');
    await writeFile(paths.file, launchdPlist(spec, identity.label, paths.logFile), { mode: 0o644 });
    const domain = `gui/${userInfo().uid}`;
    // Replacing one already loaded: launchd refuses to bootstrap a label it has.
    await run('launchctl', ['bootout', `${domain}/${identity.label}`], null).catch(() => {});
    await run('launchctl', ['bootstrap', domain, paths.file], null);
    notes.push(`It runs while you are logged in, and logs to ${paths.logFile}.`);
    return { file: paths.file, notes };
  }
  await assertSystemdUser(run);
  await writeFile(paths.file, systemdUnit(spec), { mode: 0o644 });
  await run('systemctl', ['--user', 'daemon-reload'], null);
  await run('systemctl', ['--user', 'enable', identity.unit], null);
  await run('systemctl', ['--user', 'restart', identity.unit], null);
  notes.push(`Its log: journalctl --user -u ${identity.unit} -f`);
  if (!(await lingering(run)))
    notes.push(
      `It stops when you log out and starts at your next login. To keep it running and start it at boot, run: sudo loginctl enable-linger ${userInfo().username}`
    );
  return { file: paths.file, notes };
}

/** Stops the service and removes its file; a service that is not installed is not an error. */
export async function uninstallService(dataDir: string, run: CommandRunner): Promise<boolean> {
  const identity = serviceIdentity(dataDir);
  const paths = servicePaths(identity, dataDir);
  const state = await serviceState(dataDir, run);
  if (process.platform === 'darwin')
    await run('launchctl', ['bootout', `gui/${userInfo().uid}/${identity.label}`], null).catch(
      () => {}
    );
  else await run('systemctl', ['--user', 'disable', '--now', identity.unit], null).catch(() => {});
  await rm(paths.file, { force: true });
  if (process.platform === 'linux')
    await run('systemctl', ['--user', 'daemon-reload'], null).catch(() => {});
  return state !== 'not-installed';
}

/** Restarts the installed service, as after an update replaced the files it runs. */
export async function restartService(dataDir: string, run: CommandRunner): Promise<void> {
  const identity = serviceIdentity(dataDir);
  if (process.platform === 'darwin')
    await run('launchctl', ['kickstart', '-k', `gui/${userInfo().uid}/${identity.label}`], null);
  else await run('systemctl', ['--user', 'restart', identity.unit], null);
}

export type ServiceState = 'running' | 'stopped' | 'not-installed';

/** Whether the service for this data directory is installed, and running. */
export async function serviceState(dataDir: string, run: CommandRunner): Promise<ServiceState> {
  const identity = serviceIdentity(dataDir);
  const paths = servicePaths(identity, dataDir);
  try {
    await access(paths.file);
  } catch {
    return 'not-installed';
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run(
        'launchctl',
        ['print', `gui/${userInfo().uid}/${identity.label}`],
        null
      );
      return /state = running/.test(stdout) ? 'running' : 'stopped';
    } catch {
      return 'stopped';
    }
  }
  try {
    const { stdout } = await run('systemctl', ['--user', 'is-active', identity.unit], null);
    return stdout.trim() === 'active' ? 'running' : 'stopped';
  } catch (error) {
    if (error instanceof CommandFailure) return 'stopped';
    throw error;
  }
}

async function assertSystemdUser(run: CommandRunner): Promise<void> {
  try {
    await run('systemctl', ['--user', 'show-environment'], null);
  } catch (error) {
    throw new ConfigurationError(
      `This user has no systemd user manager to install the service with (${(error as Error).message}). Run \`switch-agent-controller run\` under your own supervisor, restarting it on exit code 1 only.`
    );
  }
}

async function lingering(run: CommandRunner): Promise<boolean> {
  try {
    const { stdout } = await run(
      'loginctl',
      ['show-user', userInfo().username, '-p', 'Linger'],
      null
    );
    return /Linger=yes/.test(stdout);
  } catch {
    return false;
  }
}
