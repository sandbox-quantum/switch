import {
  access,
  chmod,
  chown,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ConfigurationError } from './errors';
import { defaultDataDir } from './paths';
import { CommandFailure, type CommandRunner } from './secrets';

/**
 * Running every agent as a Linux user of its own.
 *
 * Root sets it up once (`sudo switch-agent-controller install-service
 * --separate-users`): a pool of system users for one controller's agents, all
 * in a group of their own that the controller also gets; a systemd template
 * unit that runs an agent as one of them; a polkit rule that lets the
 * controller's user start, stop and restart those units and nothing else; and
 * the controller itself as a system service of that user. After that the
 * controller needs no root: each agent it is given claims a free user from the
 * pool, and runs as `switch-agent-<uid>@<NN>.service`, seeing only its own
 * directory.
 *
 * Everything is named after the controller user's uid, so several controllers
 * on one machine each get their own.
 */

export const SEPARATE_USERS_CONFIG_DIR = '/etc/switch-agent-controller';
const SYSTEMD_SYSTEM_DIR = '/etc/systemd/system';
const POLKIT_RULES_DIR = '/etc/polkit-1/rules.d';
const AGENTS_PARENT = '/var/lib/switch-agents';
export const MAX_AGENT_USERS = 99;
export const DEFAULT_AGENT_USERS = 16;
/** Where agents cannot reach, so nothing an agent runs may live there. */
const HOME_ROOTS = ['/home', '/root', '/run/user'];

const absolutePath = z.string().refine((value) => isAbsolute(value) && isUnitSafe(value), {
  message: 'must be an absolute path of letters, digits and ._/@+-',
});

export const separateUsersConfigSchema = z.strictObject({
  v: z.literal(1),
  user: z.string().regex(/^[a-z_][a-z0-9_.-]*\$?$/i),
  uid: z.number().int().positive(),
  gid: z.number().int().positive(),
  dataDir: absolutePath,
  agentsDir: absolutePath,
  agentUsers: z.number().int().min(1).max(MAX_AGENT_USERS),
  node: absolutePath,
  bundle: absolutePath,
});
export type SeparateUsersConfig = z.infer<typeof separateUsersConfigSchema>;

/** The names one controller's agents run under, all derived from its user's uid. */
export function separateUserNames(uid: number) {
  return {
    group: `switch-agents-${uid}`,
    controllerUnit: `switch-agent-controller-${uid}.service`,
    agentTemplate: `switch-agent-${uid}@.service`,
    agentUnitPattern: `switch-agent-${uid}@*.service`,
    polkitRule: join(POLKIT_RULES_DIR, `50-switch-agent-controller-${uid}.rules`),
    config: separateUsersConfigPath(uid),
    agentUnit: (slot: number) => `switch-agent-${uid}@${slotName(slot)}.service`,
    agentUser: (slot: number) => `sa${uid}-${slotName(slot)}`,
  };
}

export function separateUsersConfigPath(uid: number): string {
  return join(SEPARATE_USERS_CONFIG_DIR, `separate-users-${uid}.json`);
}

/** `1` → `01`: the instance name of an agent's unit, and the suffix of its user. */
export function slotName(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_AGENT_USERS)
    throw new Error(`Agent user ${slot} is not one of 1–${MAX_AGENT_USERS}.`);
  return String(slot).padStart(2, '0');
}

/** Where agents' directories are when setup names none. */
export function defaultAgentsDir(uid: number): string {
  return join(AGENTS_PARENT, String(uid));
}

/** Where the directory of the agent agent user `slot` runs is, on the machine. */
export function agentRoot(config: SeparateUsersConfig, slot: number): string {
  return join(config.agentsDir, slotName(slot));
}

/**
 * Where an agent sees its own directory, whichever agent user it runs as: the
 * same path for every agent, each in its own mount namespace, so the paths
 * an agent records (its sessions' working directory, its provider's state)
 * stay valid when it later runs as another user.
 */
export function unitAgentRoot(config: SeparateUsersConfig): string {
  return join(config.agentsDir, 'agent');
}

/** Where the controller keeps what agent user `slot`'s unit loads: its relay credentials and environment. */
export function unitFilesDir(config: SeparateUsersConfig, slot: number): string {
  return join(config.dataDir, 'units', slotName(slot));
}

/** The path a unit's process reads its relay credentials from, as systemd hands them over. */
export function unitCredentialsPath(config: SeparateUsersConfig, slot: number): string {
  return join('/run/credentials', separateUserNames(config.uid).agentUnit(slot), 'relay');
}

/** The home directory `path` is under, where agents cannot reach; null when it is under none. */
export function homeRootOf(path: string, homes: string[]): string | null {
  for (const home of [...HOME_ROOTS, ...homes])
    if (path === home || isWithin(home, path)) return home;
  return null;
}

/** Characters a path may hold to be written into a unit file as is (no quoting, no `%`). */
function isUnitSafe(value: string): boolean {
  return /^[A-Za-z0-9._/@+-]+$/.test(value);
}

function isWithin(root: string, path: string): boolean {
  const rest = relative(resolve(root), resolve(path));
  return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

/**
 * The template unit an agent runs as: one of the pool's users, in the
 * controller's agents' group, with only its own directory to see and write
 * (at `unitAgentRoot`),
 * no access to the controller's data, the home directories or the cloud
 * instance metadata, and systemd restarting it after a crash.
 *
 * Before it starts, root hands it back anything in its directory owned by
 * another agent user (its directory moves to whichever user it is given):
 * only files in the agents' group, never through a link, and never what the
 * controller wrote. Nothing of the agent runs then: its unit is stopped, so
 * nothing can swap a path mid-walk. A file outside the agents' group is never
 * touched, so not even a controller that pointed an agent's directory
 * elsewhere could have root hand it a file it does not already share.
 */
export function agentUnitTemplate(
  config: SeparateUsersConfig,
  tools: { sh: string; find: string; chown: string; path: string }
): string {
  const names = separateUserNames(config.uid);
  const onMachine = `${config.agentsDir}/%i`;
  const root = unitAgentRoot(config);
  const user = `sa${config.uid}-%i`;
  return [
    '# Written by switch-agent-controller install-service --separate-users;',
    '# run that again rather than editing this file.',
    '[Unit]',
    `Description=Switch agent %i of the agents controller run by ${config.user}`,
    'StartLimitIntervalSec=600',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    `User=${user}`,
    `Group=${names.group}`,
    'UMask=0007',
    'Environment=SWITCH_HOST_SHARED_GROUP=1',
    `Environment=HOME=${root}/home`,
    `Environment=PATH=${tools.path}`,
    `EnvironmentFile=-${config.dataDir}/units/%i/environment`,
    `LoadCredential=relay:${config.dataDir}/units/%i/relay.json`,
    `WorkingDirectory=${root}`,
    // Some systemd versions run a `+` command inside the unit's mount
    // namespace, where the directory is at `root`; others outside it.
    `ExecStartPre=+${tools.sh} -c 'dir=${root}; [ -d "$$dir" ] || dir=${onMachine}; exec ${tools.find} "$$dir" -xdev -mindepth 1 -group ${names.group} ! -user ${user} ! -user ${config.uid} -exec ${tools.chown} --no-dereference ${user} {} +'`,
    `ExecStart=${config.node} ${config.bundle} ${root}/watcher ${root}/watcher/config.json --watch-worker`,
    'StandardInput=null',
    'StandardOutput=journal',
    'StandardError=journal',
    'Restart=on-failure',
    'RestartSec=3',
    `TemporaryFileSystem=${config.agentsDir}:ro`,
    `BindPaths=${onMachine}:${root}`,
    `InaccessiblePaths=-${config.dataDir}`,
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'NoNewPrivileges=yes',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'ProtectProc=invisible',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'ProtectHostname=yes',
    'RestrictRealtime=yes',
    'RestrictSUIDSGID=yes',
    'LockPersonality=yes',
    'RemoveIPC=yes',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
    'IPAddressDeny=169.254.169.254/32 fd00:ec2::254/128',
    '',
  ].join('\n');
}

/** The polkit rule: the controller's user may start, stop, restart and reset its agents' units, and nothing else. */
export function polkitRule(config: SeparateUsersConfig): string {
  return `// Written by switch-agent-controller install-service --separate-users.
// ${config.user} may start, stop, restart and reset its agents' units, and
// nothing else. Every other request falls through to the defaults.
polkit.addRule(function (action, subject) {
  if (action.id !== "org.freedesktop.systemd1.manage-units" || subject.user !== ${JSON.stringify(config.user)}) return;
  var unit = action.lookup("unit"), verb = action.lookup("verb");
  if (/^switch-agent-${config.uid}@[0-9]{2}\\.service$/.test(unit) &&
      ["start", "stop", "restart", "reset-failed"].indexOf(verb) >= 0) return polkit.Result.YES;
});
`;
}

/**
 * The controller as a system service of its user, with the agents' group as a
 * supplementary group, so it can read what its agents write. Restarted on exit
 * code 1 only, as the user service is.
 */
export function controllerSystemUnit(
  config: SeparateUsersConfig,
  run: { cli: string; envFile: string | null; path: string }
): string {
  const quote = (value: string) => `"${value.replace(/(["\\])/g, '\\$1').replace(/%/g, '%%')}"`;
  const args = [
    config.node,
    run.cli,
    'run',
    '--data-dir',
    config.dataDir,
    '--agent-runtime',
    'separate-user',
    '--shared-host-bundle',
    config.bundle,
    ...(run.envFile ? ['--env-file', run.envFile] : []),
  ];
  return [
    '# Written by switch-agent-controller install-service --separate-users;',
    '# run that again rather than editing this file.',
    '[Unit]',
    `Description=Switch agents controller run by ${config.user}, each agent as a user of its own`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `User=${config.user}`,
    `SupplementaryGroups=${separateUserNames(config.uid).group}`,
    `ExecStart=${args.map(quote).join(' ')}`,
    `Environment=${quote(`PATH=${run.path}`)}`,
    'Restart=on-failure',
    'RestartSec=5',
    'RestartPreventExitStatus=2 3 4 5 6',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/** `PATH` without the entries agents cannot reach. */
export function agentPath(path: string, homes: string[]): string {
  const kept = path
    .split(delimiter)
    .filter((entry) => isAbsolute(entry) && isUnitSafe(entry) && !homeRootOf(entry, homes));
  return [...new Set(kept)].join(delimiter) || '/usr/local/bin:/usr/bin:/bin';
}

/** One line of `getent passwd`. */
export type PasswdEntry = { name: string; uid: number; gid: number; home: string };

export function parsePasswd(line: string): PasswdEntry {
  const fields = line.trim().split(':');
  if (fields.length < 7) throw new Error(`Not a passwd entry: ${line.trim()}`);
  return {
    name: fields[0]!,
    uid: Number(fields[2]),
    gid: Number(fields[3]),
    home: fields[5]!,
  };
}

/** The setup made for the controller user `uid`, or null when there is none. */
async function readSetup(uid: number): Promise<SeparateUsersConfig | null> {
  const path = separateUsersConfigPath(uid);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigurationError(`${path} cannot be read: ${(error as Error).message}`);
  }
  const parsed = separateUsersConfigSchema.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new ConfigurationError(
      `${path} is not a setup this controller can read (${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}). Run the setup again.`
    );
  if (parsed.data.uid !== uid)
    throw new ConfigurationError(`${path} was set up for uid ${parsed.data.uid}, not ${uid}.`);
  return parsed.data;
}

/**
 * The setup for the controller running as `uid` on `dataDir`, or null when
 * agents are not set up to run as users of their own for it.
 */
export async function findSeparateUsersConfig(
  uid: number,
  dataDir: string
): Promise<SeparateUsersConfig | null> {
  const config = await readSetup(uid);
  return config && resolve(config.dataDir) === resolve(dataDir) ? config : null;
}

/** The setup for the controller running as `uid` on `dataDir`; a missing or different one is a configuration error. */
export async function loadSeparateUsersConfig(
  uid: number,
  dataDir: string
): Promise<SeparateUsersConfig> {
  const config = await readSetup(uid);
  const path = separateUsersConfigPath(uid);
  if (!config)
    throw new ConfigurationError(
      `Agents cannot run as users of their own here: ${path} does not exist. Set it up once as root: sudo switch-agent-controller install-service --separate-users --data-dir ${dataDir}`
    );
  if (resolve(config.dataDir) !== resolve(dataDir))
    throw new ConfigurationError(
      `${path} was set up for the data directory ${config.dataDir}, not ${dataDir}. Run the setup again with --data-dir ${dataDir}.`
    );
  return config;
}

/** What the agents' group and unit need from the running controller process. */
export function assertControllerCanRunSeparateUsers(config: SeparateUsersConfig): void {
  if (!process.getgroups?.().includes(config.gid))
    throw new ConfigurationError(
      `This controller is not in the agents' group ${separateUserNames(config.uid).group}, so it cannot read what its agents write. Run it as the service the setup installed: sudo systemctl start ${separateUserNames(config.uid).controllerUnit}`
    );
}

export type SetupInput = {
  user: string;
  /** The controller's data directory; the user's default one when null. */
  dataDir: string | null;
  agentsDir: string | null;
  agentUsers: number;
  node: string;
  cli: string;
  bundle: string;
  envFile: string | null;
  path: string;
  /**
   * Queue the controller's restart rather than wait for it: for a caller the
   * controller's unit is ordered after, such as a machine's boot service.
   */
  noBlock: boolean;
};

export type SetupReport = { notes: string[] };

/**
 * Sets everything up as root, and starts the controller as a system service.
 * Run again, it rewrites the files from what it is given and adds agent users
 * up to `agentUsers`; it never removes one.
 */
export async function installSeparateUsers(
  input: SetupInput,
  run: CommandRunner
): Promise<SetupReport> {
  await assertSetupHost();
  run = onSystemPath(run);
  const account = parsePasswd((await run('getent', ['passwd', input.user], null)).stdout);
  if (account.uid === 0)
    throw new ConfigurationError('The controller must run as a user other than root.');
  const homes = [account.home];
  const names = separateUserNames(account.uid);
  for (const [what, path] of [
    ['Node', input.node],
    ['The controller', input.cli],
    ['The shared-host bundle', input.bundle],
  ] as const) {
    const home = homeRootOf(path, homes);
    if (home)
      throw new ConfigurationError(
        `${what} is at ${path}, under ${home}, which agents running as users of their own cannot reach. Install Node and the controller system-wide (sudo npm install --global <the release's .tgz URL>) and run the setup again.`
      );
    if (!isUnitSafe(path))
      throw new ConfigurationError(
        `${what} is at ${path}; a path in a unit file must hold only letters, digits and ._/@+-.`
      );
  }
  if (input.envFile && !isAbsolute(input.envFile))
    throw new ConfigurationError(`--env-file must be an absolute path, not ${input.envFile}.`);
  const dataDir = resolve(
    input.dataDir ?? defaultDataDir({ platform: process.platform, env: {}, home: account.home })
  );
  await assertEnrolled(dataDir, account);
  await assertNoUserService(dataDir, account);

  const group = await ensureGroup(names.group, run);
  const agentsDir = input.agentsDir ?? defaultAgentsDir(account.uid);
  if (homeRootOf(agentsDir, homes))
    throw new ConfigurationError(
      `--agents-dir ${agentsDir} is under a home directory, which agents cannot reach.`
    );
  const config = separateUsersConfigSchema.parse({
    v: 1,
    user: account.name,
    uid: account.uid,
    gid: group,
    dataDir,
    agentsDir: resolve(agentsDir),
    agentUsers: input.agentUsers,
    node: input.node,
    bundle: input.bundle,
  } satisfies SeparateUsersConfig);
  for (let slot = 1; slot <= config.agentUsers; slot++)
    await ensureAgentUser(names.agentUser(slot), names.group, run);

  await mkdir(dirname(config.agentsDir), { recursive: true, mode: 0o755 });
  await mkdir(config.agentsDir, { recursive: true, mode: 0o700 });
  await chown(config.agentsDir, account.uid, account.gid);
  await chmod(config.agentsDir, 0o700);

  const tools = {
    sh: await which('sh', SYSTEM_PATH),
    find: await which('find', SYSTEM_PATH),
    chown: await which('chown', SYSTEM_PATH),
    path: agentPath(input.path, homes),
  };
  await mkdir(SEPARATE_USERS_CONFIG_DIR, { recursive: true, mode: 0o755 });
  await writeFile(names.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  await writeFile(join(SYSTEMD_SYSTEM_DIR, names.agentTemplate), agentUnitTemplate(config, tools), {
    mode: 0o644,
  });
  await writeFile(names.polkitRule, polkitRule(config), { mode: 0o644 });
  await writeFile(
    join(SYSTEMD_SYSTEM_DIR, names.controllerUnit),
    controllerSystemUnit(config, { cli: input.cli, envFile: input.envFile, path: input.path }),
    { mode: 0o644 }
  );
  await run('systemctl', ['daemon-reload'], null);
  await run('systemctl', ['enable', names.controllerUnit], null);
  await run(
    'systemctl',
    input.noBlock
      ? ['restart', '--no-block', names.controllerUnit]
      : ['restart', names.controllerUnit],
    null
  );
  return {
    notes: [
      `${config.agentUsers} agent users (${names.agentUser(1)}…), in the group ${names.group}.`,
      `Agents' directories: ${config.agentsDir}`,
      `Each agent runs as ${names.agentUnitPattern}; its log: journalctl -u ${names.agentUnit(1)}`,
      `The controller runs as ${names.controllerUnit}; its log: journalctl -u ${names.controllerUnit} -f`,
      'Agents see only their own directory: a definition naming a directory elsewhere is refused.',
      "Agents do not see this user's provider logins: give each provider an API key or token in --env-file.",
    ],
  };
}

/**
 * Stops the controller and every agent unit, and removes the units, the rule,
 * the setup, the agent users and their group. The agents' directories are
 * kept, and said so.
 */
export async function uninstallSeparateUsers(
  user: string,
  run: CommandRunner
): Promise<SetupReport> {
  assertRoot();
  run = onSystemPath(run);
  const account = parsePasswd((await run('getent', ['passwd', user], null)).stdout);
  const names = separateUserNames(account.uid);
  let agentsDir: string | null = null;
  let agentUsers = MAX_AGENT_USERS;
  try {
    const config = separateUsersConfigSchema.parse(
      JSON.parse(await readFile(names.config, 'utf8'))
    );
    agentsDir = config.agentsDir;
    agentUsers = config.agentUsers;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await run('systemctl', ['disable', '--now', names.controllerUnit], null).catch(ignoreFailure);
  await run('systemctl', ['stop', names.agentUnitPattern], null).catch(ignoreFailure);
  await run('systemctl', ['reset-failed', names.agentUnitPattern], null).catch(ignoreFailure);
  await rm(join(SYSTEMD_SYSTEM_DIR, names.controllerUnit), { force: true });
  await rm(join(SYSTEMD_SYSTEM_DIR, names.agentTemplate), { force: true });
  await rm(names.polkitRule, { force: true });
  await rm(names.config, { force: true });
  await run('systemctl', ['daemon-reload'], null);
  for (let slot = 1; slot <= agentUsers; slot++)
    await run('userdel', [names.agentUser(slot)], null).catch(ignoreFailure);
  await run('groupdel', [names.group], null).catch(ignoreFailure);
  return {
    notes: agentsDir
      ? [
          `The agents' directories are kept in ${agentsDir}; remove them when nothing in them is needed.`,
        ]
      : [],
  };
}

function ignoreFailure(error: unknown): void {
  if (!(error instanceof CommandFailure)) throw error;
}

function assertRoot(): void {
  if (process.getuid?.() !== 0)
    throw new ConfigurationError(
      'Setting agents up as users of their own needs root, once: run this with sudo.'
    );
}

async function assertSetupHost(): Promise<void> {
  if (process.platform !== 'linux')
    throw new ConfigurationError(
      'Agents run as users of their own only on Linux with systemd. On this machine, run the controller as a service of your user: switch-agent-controller install-service'
    );
  assertRoot();
  try {
    await access('/run/systemd/system');
  } catch {
    throw new ConfigurationError(
      'systemd is not this machine’s init system, and agents run as users of their own through it.'
    );
  }
  try {
    await access(POLKIT_RULES_DIR);
  } catch {
    throw new ConfigurationError(
      `${POLKIT_RULES_DIR} does not exist: install polkit (polkitd), which lets the controller start its agents without root, and run the setup again.`
    );
  }
  for (const command of ['useradd', 'groupadd', 'getent', 'id', 'systemctl'])
    await which(command, SYSTEM_PATH);
}

async function assertEnrolled(dataDir: string, account: PasswdEntry): Promise<void> {
  const database = join(dataDir, 'controller.db');
  let owner: number;
  try {
    owner = (await stat(database)).uid;
  } catch {
    throw new ConfigurationError(
      `${dataDir} holds no enrolled controller. Enroll it first, as ${account.name}: switch-agent-controller enroll --server <url> --code <code> --data-dir ${dataDir}`
    );
  }
  if (owner !== account.uid)
    throw new ConfigurationError(
      `${database} belongs to uid ${owner}, not to ${account.name}, who would run the controller.`
    );
}

/** A user service on the same data directory would run a second controller with the same identity. */
async function assertNoUserService(dataDir: string, account: PasswdEntry): Promise<void> {
  const directory = join(account.home, '.config', 'systemd', 'user');
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!/^switch-agent-controller.*\.service$/.test(entry)) continue;
    const file = join(directory, entry);
    if ((await readFile(file, 'utf8')).includes(`"${dataDir}"`))
      throw new ConfigurationError(
        `${account.name} already runs this controller as a user service (${file}). Remove it first, as ${account.name}: switch-agent-controller uninstall-service --data-dir ${dataDir}`
      );
  }
}

async function ensureGroup(group: string, run: CommandRunner): Promise<number> {
  const existing = await run('getent', ['group', group], null).catch((error: unknown) => {
    ignoreFailure(error);
    return null;
  });
  if (!existing) await run('groupadd', ['--system', group], null);
  const line = existing ?? (await run('getent', ['group', group], null));
  const gid = Number(line.stdout.trim().split(':')[2]);
  if (!Number.isInteger(gid) || gid <= 0)
    throw new Error(`Could not read the gid of the group ${group}.`);
  return gid;
}

async function ensureAgentUser(user: string, group: string, run: CommandRunner): Promise<void> {
  const existing = await run('getent', ['passwd', user], null).catch((error: unknown) => {
    ignoreFailure(error);
    return null;
  });
  if (existing) {
    const groups = (await run('id', ['-gn', user], null)).stdout.trim();
    if (groups !== group)
      throw new ConfigurationError(
        `The user ${user} exists, but its group is ${groups}, not ${group}; it was not made by this setup.`
      );
    return;
  }
  await run(
    'useradd',
    [
      '--system',
      '--gid',
      group,
      '--no-create-home',
      '--home-dir',
      '/nonexistent',
      '--shell',
      '/usr/sbin/nologin',
      '--comment',
      'Switch agent',
      user,
    ],
    null
  );
}

/**
 * Where the setup finds the system's own commands (`useradd`, `systemctl`,
 * `find`…), whatever PATH it runs with: the PATH it is given is the one the
 * controller and its agents run with, which has no business holding `sbin`.
 */
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** `run`, with each command found on `SYSTEM_PATH` and run by its absolute path. */
function onSystemPath(run: CommandRunner): CommandRunner {
  return async (file, args, input) => run(await which(file, SYSTEM_PATH), args, input);
}

async function which(command: string, path: string): Promise<string> {
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate);
      if (isUnitSafe(candidate)) return candidate;
    } catch {
      // not in this directory
    }
  }
  throw new ConfigurationError(
    `${command} is not installed in ${path.split(delimiter).join(', ')}, and the setup needs it.`
  );
}
