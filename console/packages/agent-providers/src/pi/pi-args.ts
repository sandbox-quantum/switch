/**
 * The one place Switch builds the arguments of a Pi it starts (`ready_errata.md`
 * ER-01): a session, a discovery of models, the sign-in check and the version
 * check alike. Nothing here reads the environment or offers a way to add
 * arguments: what Pi is told is decided by `PiArgsInput` alone (#777 plan
 * E12-03: no test mode in production code).
 *
 * What every Pi that loads extensions is told (Pi at `PI_VERSION`, `dist/cli/args.js`):
 * - `--mode rpc` (`:41`): driven over JSON lines by the adapter;
 * - `--offline` (`:235`): no install telemetry, version check or download of
 *   `fd`/`rg` into the profile (P-11, `09_human_decisions_probes.md`);
 * - `-ne` (`:160`) and then `-e <bridge> -e builtin:mcp` (`:156`): no extension
 *   but these two, the bridge first (decisions D-4 A and D-7 A, which replace
 *   the order of ER-04; `bridge.ts` `bridgeSource`);
 * - `--no-approve` (`:232`): the project is never trusted, so neither its
 *   `.pi/settings.json` (and a `shellCommandPrefix` in it) nor its `.pi/mcp.json`,
 *   extensions or packages are read, whatever `trust.json` in the profile says
 *   (`dist/main.js:596-600`, `extensions/mcp/config.js:109`).
 *
 * Never `--raw` and never `--no-skills`: the person's `~/.agents/skills` are
 * loaded, as Claude's are (PD-3 A).
 */

/** Pi's MCP extension, as `-e` names it (the `sourceInfo.path` of its tools, `pi-policy.ts`). */
export const PI_MCP_EXTENSION = 'builtin:mcp';

/** Arguments Switch never gives Pi, whatever it starts it for. */
export const PI_NEVER_ARGS: readonly string[] = [
  '--raw',
  '--no-skills',
  '-ns',
  '--approve',
  '-a',
  '--extension',
  '--api-key',
  '--continue',
  '-c',
  '--resume',
  '-r',
  '--fork',
];

/** A Pi session: a new one with `id`, or the transcript in `file` resumed (ER-07, stage 5). */
export type PiSessionTarget = { id: string } | { file: string };

export type PiArgsInput =
  /** `pi --version`, asked by `assertPiVersion`. */
  | { kind: 'version' }
  /** One provider's `pi auth check` (ER-11, P-05): loads no extension and runs no migration. */
  | { kind: 'readiness'; provider: string }
  /** A Pi that lists models and keeps no conversation (ER-08). */
  | { kind: 'discovery'; bridgePath: string }
  /** A Pi that runs an agent's conversation. */
  | {
      kind: 'session';
      bridgePath: string;
      sessionDir: string;
      session: PiSessionTarget;
      model: string;
    };

/** Thrown for a value Switch will not put in Pi's arguments. */
export class PiArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiArgsError';
  }
}

/** One argument's value: never empty, never one Pi could read as a flag, never more than a line. */
function value(name: string, given: string): string {
  if (typeof given !== 'string' || !given || given.startsWith('-') || /[\0\r\n]/.test(given))
    throw new PiArgsError(`Switch will not pass Pi ${name} ${JSON.stringify(given)}.`);
  return given;
}

/** A path Pi is given: absolute, so it never depends on the directory Pi runs in. */
function path(name: string, given: string): string {
  if (!value(name, given).startsWith('/'))
    throw new PiArgsError(
      `Switch passes Pi ${name} as an absolute path, not ${JSON.stringify(given)}.`
    );
  return given;
}

/** Pi's own rule for a session id (`dist/core/session-manager.js:15-19`). */
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** A provider id as Pi names one (`pi-ai/dist/env-api-keys.js`). */
const PROVIDER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** What a Pi that loads extensions is always told: see the module comment. */
function extensionArgs(bridgePath: string): string[] {
  return [
    '--mode',
    'rpc',
    '--offline',
    '-ne',
    '-e',
    path('the bridge', bridgePath),
    '-e',
    PI_MCP_EXTENSION,
    '--no-approve',
  ];
}

/** The arguments of a Pi Switch starts. */
export function piArgs(input: PiArgsInput): string[] {
  switch (input.kind) {
    case 'version':
      return ['--version', '--offline'];
    case 'readiness': {
      const provider = value('the provider', input.provider);
      if (!PROVIDER.test(provider))
        throw new PiArgsError(`Switch will not ask Pi about provider ${JSON.stringify(provider)}.`);
      // `auth check` parses only these (`dist/cli/auth-command.js:45-70`).
      return ['auth', 'check', '--provider', provider, '--json', '--no-refresh', '--offline'];
    }
    case 'discovery':
      return [...extensionArgs(input.bridgePath), '--no-session'];
    case 'session': {
      const target =
        'id' in input.session
          ? ['--session-id', value('the session id', input.session.id)]
          : ['--session', path('the session file', input.session.file)];
      if ('id' in input.session && !SESSION_ID.test(input.session.id))
        throw new PiArgsError(
          `Pi does not take ${JSON.stringify(input.session.id)} as a session id.`
        );
      return [
        ...extensionArgs(input.bridgePath),
        '--session-dir',
        path('the session directory', input.sessionDir),
        ...target,
        '--model',
        value('the model', input.model),
      ];
    }
  }
}
