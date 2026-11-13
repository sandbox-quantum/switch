import type { ActivityLog, Result, RichText } from '@switch-console/shared';
import type { IExecutionContext } from '../../exec/execution-context';
import type { Platform } from '../../host-dependencies/capability';
import type {
  InstallCommandError,
  InstallCommandSpec,
  Provenance,
} from '../../host-dependencies/runtime/types';

/**
 * An agent provider's setup: checks the provider's CLI on a machine,
 * changing nothing, and writes into `s` what it found and the
 * {@link ProviderActions} a person can take from there, listing each
 * installation for its own check. It keeps nothing between checks: what an
 * action finds out is the caller's to keep.
 */
export type ProviderSetup = {
  check: (s: SetupContext) => Promise<void>;
  /**
   * Legacy: the realpath of `installation`'s executable, which is how Console
   * saves the installation chosen and names it to the session host today. To
   * go once installations are saved in full.
   */
  installationToRealpath: (installation: Installation) => string;
  /**
   * Legacy: the installation among `installations` whose executable is at
   * `realpath`, as Console saved it; null where none is. To go with
   * {@link installationToRealpath}.
   */
  realpathToInstallation: (installations: Installation[], realpath: string) => Installation | null;
};

/** What a person can do for the provider as a whole, from the state the check found. */
export type ProviderActions = {
  /** The ways to install it here, the best first; empty where it does not install here. */
  install: InstallOffer[];
};

/** What a person can do with one installation, from the state its check found. */
export type InstallationActions = {
  /**
   * Checks it in depth, which may cost something, like a test prompt the
   * provider bills; the only action that may. It changes nothing on the
   * machine, so its checks run whatever is authorized. What it finds is in
   * its run's findings, the caller's to keep and to verify again when it
   * likes. Where nothing here can verify it, it leaves a person the steps to
   * do it themselves.
   */
  // TODO: give an installation a verify key (its realpath and version, and
  // its sign-in, say) that changes when what verifying found may no longer
  // hold, so the caller knows when to verify again.
  verify: Action;
  /** Updates it; null where Switch Console does not know how. */
  update: Action | null;
  /** Uninstalls it; null where Switch Console does not know how. */
  uninstall: Action | null;
  /** Signs it in, signed in already or not. */
  signIn: Action;
};

/** Takes the steps of one thing a person can do, as far as `run` lets it, recording them in `run`. */
export type Action = (run: RunContext) => Promise<void>;

/** What an action may run, and what came of it, which the action fills in as it goes. */
export type RunContext = {
  /** Where the action reports what it is doing. */
  activity: ActivityLog;
  /**
   * The ids of the steps that may run, as a person was shown them; none to
   * only list the steps.
   */
  authorized: readonly string[];
  /** The steps that ran, in order. */
  done: { id: string }[];
  /** The steps left to a person, from the first that did not run. */
  manual: ManualStep[];
  /** How a step failed, where one did; from then on nothing more runs. */
  failure: StepFailure | null;
  /**
   * What the action found out about the installation it is on, which the
   * caller keeps, over the state the check found, for as long as it likes:
   * a verify's sign-in.
   */
  findings: Partial<InstallationState>;
};

/** How a step failed: a command it ran, or the step itself. */
export type StepFailure = InstallCommandError | { type: 'step-failed'; message: string };

/** One block of a step's description: a paragraph, or a command line, which the UI shows each its way. */
export type StepBlock = { kind: 'paragraph'; text: RichText } | { kind: 'cli'; command: string };

/** One step of an action: a change to the machine, which Console takes or leaves to a person. */
export type Step = {
  /** Tells it apart from the action's other steps, to authorize it alone: `install`. */
  id: string;
  /** What it does, in a few plain words: "Installing Codex with npm". */
  title: string;
  /** What a person is to know to take it, in order. */
  description: StepBlock[];
};

/** A step an action did not take, for a person to take or authorize by its id. */
export type ManualStep = Step;

/** One of the ways to install a provider's CLI here, and the action that installs it so. */
export type InstallOffer = {
  /** Tells it apart, the same from one check to the next: `npm`. */
  id: string;
  /** Its name, in a few plain words: "Homebrew". */
  title: string;
  /** What installing this way does, for a person choosing. */
  description: RichText;
  action: Action;
};

/** Whether an installation is signed in, by the provider's own check. */
export type SignInStatus = {
  status: 'signed-in' | 'signed-out' | 'unknown';
  /** What the check said: who it is signed in as, or why it is not, or why it could not tell. */
  detail: string | null;
};

/** One installation of a provider's CLI, as a person is shown it. */
export type Installation = {
  /** Tells it apart: `executable-path:` and where it really is, symlinks followed. */
  id: string;
  /** Where it is, its version and how it was installed, for a person to read. */
  description: RichText;
  /** The version it printed; null where it printed none. */
  version: string | null;
  /**
   * The id of the setup's install method it was installed with, which the
   * machine tells; null where it does not.
   */
  installedVia: string | null;
};

/**
 * The state of one installation: its sign-in, as its check found it, and
 * its latest version, which only checking for updates finds.
 */
export type InstallationState = {
  /** Whether it is signed in; null where it has no sign-in to check. */
  signIn: SignInStatus | null;
  /** Whether signing it in is what it needs: not signed in, and signing in would help. */
  needsSignIn: boolean;
  /**
   * The latest version it could update to; null until its update check ran,
   * or where that could not tell.
   */
  // TODO: give an installation a version key (its realpath and version, say)
  // that changes when it does, so the caller knows when what checking for
  // updates found no longer holds.
  latestVersion: string | null;
  /** Whether it is older than {@link latestVersion}; null where either is unknown. */
  updateAvailable: boolean | null;
};

/** One executable of a provider's CLI, as a setup finds it on the machine. */
export type Executable = {
  /** Where it was found: what runs. */
  path: string;
  /** Where it really is, symlinks followed: two paths to one file are one executable. */
  realpath: string;
  /** The version it printed; null where it printed none. */
  version: string | null;
  /** How it was installed, as the machine tells it. */
  provenance: Provenance;
};

/** The state of a provider's CLI on a machine, as its setup found it. */
export type ProviderState = {
  /** Every installation found, the one PATH runs first; each is checked on its own. */
  installations: Installation[];
  /** The id of the installation that runs where none is chosen: the first on PATH; null where there is none. */
  defaultInstallation: string | null;
};

/** The machine a setup runs on, and how it reads and changes it. */
export type SetupHost = {
  platform: Platform;
  /** Runs the commands that only read the machine: `which`, version probes, package-manager queries. */
  exec: IExecutionContext;
  /** Runs a command that changes the machine, in the person's shell. */
  runCommand: (command: InstallCommandSpec) => Promise<Result<void, InstallCommandError>>;
  /**
   * Runs one of the provider runtime's setup checks on the machine; null where
   * the runtime here runs none (a controller or session host from before
   * them), whose sign-in a setup reads with {@link runLegacyCheck} instead.
   */
  runSetupCheck: RunSetupCheck | null;
  /**
   * Legacy: the sign-in check a runtime from before setup checks answers, the
   * session host's probe: free, it changes nothing and costs nothing.
   */
  runLegacyCheck: (
    provider: string,
    installationConfig: LegacyInstallationConfig
  ) => Promise<{ ok: true; output: LegacyReadiness } | { ok: false; reason: string }>;
  /**
   * Legacy: a controller's recheck of the provider's sign-in, which may send
   * a test prompt the provider bills, so for verifying only. It rechecks the
   * executable the controller finds on PATH, not one named to it, so it says
   * something only of the installation that runs by default.
   */
  runLegacyRecheck: (
    provider: string
  ) => Promise<{ ok: true; output: LegacyReadiness } | { ok: false; reason: string }>;
  /** The command that signs the provider's executable at `installationConfig` in, for a person to finish. */
  loginCommand: (provider: string, installationConfig: LegacyInstallationConfig) => string;
};

/**
 * Runs one of the provider runtime's setup checks on the executable named by
 * `installationConfig`, as its sessions would run it. Never throws: a check the runtime
 * does not have, or that fails, comes back with why.
 */
export type RunSetupCheck = (request: {
  provider: string;
  check: string;
  installationConfig: LegacyInstallationConfig;
  input: unknown;
}) => Promise<{ ok: true; output: unknown } | { ok: false; reason: string }>;

/** Legacy: what a runtime from before setup checks says of an executable's sign-in. */
export type LegacyReadiness = {
  status: 'authenticated' | 'unauthenticated' | 'unconfigured' | 'unknown';
  message: string;
};

/**
 * Legacy: the installation a session's configuration names for the
 * provider's runtime today, by its executable, as `execution.binaryPath`. To
 * go once installations are named in full.
 */
export type LegacyInstallationConfig = { binaryPath: string };

/**
 * What the check works with: the machine it runs on, and what it fills in,
 * the state found and the actions from there.
 */
export type SetupContext = {
  host: SetupHost;
  /** Where the check reports what it is doing. */
  activity: ActivityLog;
  /**
   * The paths of executables a person chose, which a check looks at besides
   * PATH, wherever they are.
   */
  pinnedExecutables: readonly string[];
  /** Plain data, to show or send anywhere. */
  state: ProviderState;
  /** Functions, run where the check ran. */
  actions: ProviderActions;
  /** Offers installing with `offer`, after the ways offered before it. */
  addInstallMethod: (offer: InstallOffer) => void;
  /**
   * Lists `executable` in the state as an installation, installed with the
   * install method `installedVia` names, which `check` checks on its own.
   */
  addInstallation: (
    executable: Executable,
    details: { installedVia: string | null },
    check: InstallationCheck
  ) => void;
  /** Records `executable` as the installation that runs where none is chosen; null where there is none. */
  setDefaultInstallation: (executable: Executable | null) => void;
  /** Each installation's check, by its id, with the executable it is. */
  installationChecks: Record<string, { executable: Executable; check: InstallationCheck }>;
};

/**
 * Looks up the latest version an installation could update to, reporting to
 * `activity`; null where it could not find out. It changes nothing and needs
 * no one's leave, so it is no action: its caller runs it when it likes.
 */
export type UpdateCheck = (activity: ActivityLog) => Promise<string | null>;

/**
 * Checks one installation, changing nothing and costing nothing, and writes
 * into `i` what it found and the {@link InstallationActions} from there.
 */
export type InstallationCheck = (i: InstallationSetupContext) => Promise<void>;

/**
 * What an installation's check works with: the machine, the installation, and
 * what it fills in, the installation's state and actions.
 */
export type InstallationSetupContext = {
  host: SetupHost;
  /** Where the check reports what it is doing. */
  activity: ActivityLog;
  installation: Installation;
  /** Plain data, to show or send anywhere. */
  state: InstallationState;
  /** Records the actions on it; the check calls it once. */
  setActions: (actions: InstallationActions) => void;
  /** Records how to check it for updates, where anything tells its latest version. */
  setUpdateCheck: (check: UpdateCheck) => void;
};
