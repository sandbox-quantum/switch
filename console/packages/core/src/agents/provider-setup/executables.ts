import { code, lines, rich, runActivity, type RichText } from '@switch-console/shared';
import { createInstallMethodDetector } from '../../host-dependencies/runtime/method-detection';
import {
  resolveAllCommandPaths,
  resolveRealpath,
  runVersionProbe,
} from '../../host-dependencies/runtime/probe';
import type { Provenance } from '../../host-dependencies/runtime/types';
import type { Executable, Installation, InstallationCheck, SetupContext } from './types';

/** What reading the machine needs: the host, and where to report what it does. */
type Reader = Pick<SetupContext, 'host' | 'activity' | 'pinnedExecutables'>;

/** The name a path runs by, for an activity's title: `agy` for `C:\\…\\agy.exe`. */
function nameOf(path: string): string {
  return (path.split(/[\\/]/).at(-1) ?? path).replace(/\.(exe|cmd|bat)$/i, '');
}

/**
 * The executable at `path`: where it really is, its version, and how it was
 * installed.
 */
async function executableAt(s: Reader, path: string, realpath: string): Promise<Executable> {
  const { exec, platform } = s.host;
  const version = await runActivity(
    s.activity,
    `Running ${nameOf(path)} --version`,
    rich`${code(`${path} --version`)}`,
    async (update) => {
      const probe = await runVersionProbe(path, path, ['--version'], exec);
      const found = /\d+\.\d+[\d.]*/.exec(probe.stdout || probe.stderr)?.[0] ?? null;
      update({ outcome: found ? rich`version ${code(found)}` : rich`printed no version` });
      return found;
    }
  );
  return {
    path,
    realpath,
    version,
    provenance: await createInstallMethodDetector(exec, platform).detect(realpath),
  };
}

/** Every executable named `name` on PATH, in PATH order, each once. */
async function executablesOnPath(s: Reader, name: string): Promise<Executable[]> {
  const { exec, platform } = s.host;
  const paths = await runActivity(
    s.activity,
    `Looking for ${name} on PATH`,
    null,
    async (update) => {
      const found = await resolveAllCommandPaths(name, exec, platform);
      update(
        found.length > 0
          ? {
              outcome: found.length === 1 ? rich`found` : rich`found ${found.length}`,
              description: lines(...found.map((path) => rich`At ${code(path)}`)),
            }
          : { outcome: rich`not found` }
      );
      return found;
    }
  );
  const executables: Executable[] = [];
  for (const path of paths) {
    const realpath = await resolveRealpath(path, exec, platform);
    if (executables.some((other) => other.realpath === realpath)) continue;
    executables.push(await executableAt(s, path, realpath));
  }
  return executables;
}

/** Those of `s`'s pinned executables that are there, each once, but those in `found`. */
async function pinnedExecutables(s: Reader, found: Executable[]): Promise<Executable[]> {
  const { exec, platform } = s.host;
  const executables: Executable[] = [];
  for (const pinned of s.pinnedExecutables) {
    const there = await runActivity(
      s.activity,
      'Looking for the executable chosen',
      rich`${code(pinned)}`,
      async (update) => {
        const paths = await resolveAllCommandPaths(pinned, exec, platform);
        update({ outcome: paths.length > 0 ? rich`found` : rich`not found` });
        return paths.length > 0;
      }
    );
    if (!there) continue;
    const realpath = await resolveRealpath(pinned, exec, platform);
    if ([...found, ...executables].some((other) => other.realpath === realpath)) continue;
    executables.push(await executableAt(s, pinned, realpath));
  }
  return executables;
}

/**
 * Every executable named `name` on PATH, in PATH order, then those a person
 * chose that are not on it, and the one that runs where none is chosen: the
 * first on PATH.
 */
export async function findExecutables(
  s: Reader,
  name: string
): Promise<{ executables: Executable[]; defaultExecutable: Executable | null }> {
  const onPath = await executablesOnPath(s, name);
  return {
    executables: [...onPath, ...(await pinnedExecutables(s, onPath))],
    defaultExecutable: onPath[0] ?? null,
  };
}

/** How a person is told of `executable`: where it is, its version, and how it was installed. */
function describeExecutable(executable: Executable): RichText {
  const { version, provenance } = executable;
  const how =
    provenance.kind === 'unknown' || provenance.kind === 'manual'
      ? ''
      : provenance.kind === 'version-manager'
        ? rich`, installed with a version manager`
        : rich`, installed with ${provenance.kind}`;
  return rich`${code(executable.path)}${version ? rich`, version ${code(version)}` : ''}${how}`;
}

/**
 * The id of the install method `executable` was installed with: the one
 * `methods` names for how the machine tells it was installed; null where it
 * names none.
 */
export function installedVia(
  executable: Executable,
  methods: Partial<Record<Provenance['kind'], string>>
): string | null {
  return methods[executable.provenance.kind] ?? null;
}

const LEGACY_PREFIX = 'executable-path:';

/** The id of the installation `executable` is: `executable-path:` and its realpath. */
export function installationId(executable: Executable): string {
  return LEGACY_PREFIX + executable.realpath;
}

/** {@link SetupContext.addInstallation}, for `s`. */
export function addInstallation(
  s: Pick<SetupContext, 'state' | 'installationChecks'>,
  executable: Executable,
  details: { installedVia: string | null },
  check: InstallationCheck
): void {
  const id = installationId(executable);
  if (s.installationChecks[id]) throw new Error(`The check lists ${executable.path} already.`);
  s.state.installations.push({
    id,
    description: describeExecutable(executable),
    version: executable.version,
    installedVia: details.installedVia,
  });
  s.installationChecks[id] = { executable, check };
}

/**
 * Legacy: the realpath of the executable an installation listed by
 * {@link addInstallation} is, read from its id. For a setup's
 * `installationToRealpath`.
 */
export function installationToRealpath(installation: Installation): string {
  if (!installation.id.startsWith(LEGACY_PREFIX))
    throw new Error(`${installation.id} is not an installation of an executable.`);
  return installation.id.slice(LEGACY_PREFIX.length);
}

/**
 * Legacy: the installation listed by {@link addInstallation} whose executable
 * is at `realpath`; null where none is. For a setup's `realpathToInstallation`.
 */
export function realpathToInstallation(
  installations: Installation[],
  realpath: string
): Installation | null {
  return installations.find((installation) => installation.id === LEGACY_PREFIX + realpath) ?? null;
}
