import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION } from '@shared/app-identity';
import { findCoreCheckout } from './checkout-build';

/** The variable that chooses the switch-core a dev build's managed servers run. */
export const SERVER_VERSION_ENV = 'SWITCH_CONSOLE_SERVER_VERSION';

/** The value of {@link SERVER_VERSION_ENV} that runs switch-core from this checkout. */
export const SERVER_VERSION_CHECKOUT = 'checkout';

/**
 * What switch-core the managed servers run.
 *
 * - `pin` — this build's {@link COMPATIBLE_SWITCH_VERSION}, and the persisted
 *   "Build switch-core from this checkout" toggle decides about the local one.
 * - `release` — the released version {@link SERVER_VERSION_ENV} named, for
 *   every managed server; the toggle is held off.
 * - `checkout` — the local server always runs switch-core from `root`, Docker
 *   or native, whatever the toggle says. `version` stays the pin: it is what a
 *   remote host runs, since a remote host builds nothing from this machine.
 */
export type ServerVersionChoice =
  | { kind: 'pin'; version: string }
  | { kind: 'release'; version: string }
  | { kind: 'checkout'; version: string; root: string };

/** A release as switch-core tags its images and GitHub releases: `0.30.0`,
 * `0.31.0-rc.7`. No leading `v` and no build metadata, neither of which an
 * image tag carries. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Read a {@link SERVER_VERSION_ENV} value. Unset or empty keeps `pin`; anything
 * that is neither a release version nor `checkout`, and a `checkout` with no
 * checkout to run, throws naming the variable rather than fall back to the pin.
 */
export function parseServerVersionChoice(
  raw: string | undefined,
  pin: string,
  findCheckout: () => string | null
): ServerVersionChoice {
  if (!raw) return { kind: 'pin', version: pin };
  if (raw === SERVER_VERSION_CHECKOUT) {
    const root = findCheckout();
    if (root === null) {
      throw new Error(
        `${SERVER_VERSION_ENV}=${SERVER_VERSION_CHECKOUT} runs switch-core from the Switch ` +
          `checkout this app was started from, but no checkout was found in or above ` +
          `${process.cwd()} (one has core/pyproject.toml and the Dockerfiles under ` +
          `deploy/shared_resources/images/). Start the app from inside a checkout, or unset it.`
      );
    }
    return { kind: 'checkout', version: pin, root };
  }
  if (!RELEASE_VERSION.test(raw)) {
    throw new Error(
      `${SERVER_VERSION_ENV} must be a switch-core release version such as 0.30.0 or ` +
        `0.31.0-rc.7, or "${SERVER_VERSION_CHECKOUT}": got ${JSON.stringify(raw)}.`
    );
  }
  return { kind: 'release', version: raw };
}

/** The `NAME=value` that made this choice, for the UI to say what forces it;
 * null when nothing did. */
export function serverVersionSetting(choice: ServerVersionChoice): string | null {
  if (choice.kind === 'pin') return null;
  const value = choice.kind === 'checkout' ? SERVER_VERSION_CHECKOUT : choice.version;
  return `${SERVER_VERSION_ENV}=${value}`;
}

let resolved: ServerVersionChoice | null = null;

/**
 * This run's choice, read from {@link SERVER_VERSION_ENV} once. Only a dev
 * build reads it: a stable or canary build always runs its pin, and says so
 * when the variable is set anyway. Throws on a value it cannot honour — the
 * main process resolves it at launch, so that is where it fails.
 */
export function serverVersionChoice(): ServerVersionChoice {
  resolved ??= resolveServerVersionChoice();
  return resolved;
}

function resolveServerVersionChoice(): ServerVersionChoice {
  const raw = process.env[SERVER_VERSION_ENV];
  if (!import.meta.env.DEV) {
    if (raw) {
      log.warn(
        `${SERVER_VERSION_ENV} is read by dev builds only; managed servers run this build's ` +
          `switch-core ${COMPATIBLE_SWITCH_VERSION}.`
      );
    }
    return { kind: 'pin', version: COMPATIBLE_SWITCH_VERSION };
  }
  const choice = parseServerVersionChoice(raw, COMPATIBLE_SWITCH_VERSION, () => findCoreCheckout());
  if (choice.kind === 'release') {
    log.warn(
      `${SERVER_VERSION_ENV}: managed servers run switch-core ${choice.version} instead of the ` +
        `pinned ${COMPATIBLE_SWITCH_VERSION}.`
    );
  } else if (choice.kind === 'checkout') {
    log.warn(
      `${SERVER_VERSION_ENV}: the local server runs switch-core from ${choice.root} on every ` +
        `start; remote managed servers keep the pinned ${choice.version}.`
    );
  }
  return choice;
}

/** The released switch-core managed servers run: the version
 * {@link SERVER_VERSION_ENV} names in a dev build, else this build's pin. */
export function managedSwitchVersion(): string {
  return serverVersionChoice().version;
}
