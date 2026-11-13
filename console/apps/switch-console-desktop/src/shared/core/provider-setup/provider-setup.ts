import type {
  Installation,
  InstallationState,
  ManualStep,
  RunContext,
  StepFailure,
} from '@switch-console/core/agents/provider-setup';
import type { Activity, RichText } from '@switch-console/shared';

/**
 * Agent provider setup on this computer, as the renderer sees it: what the
 * provider's setup found, the steps each action would take, and what was run.
 */

/** One thing Switch Console does with a provider's setup: a check, or one of its actions. */
export type ProviderSetupOperation =
  | { kind: 'check' }
  | { kind: 'install'; option: string }
  | { kind: 'checkForUpdates'; installation: string }
  | { kind: 'verify' | 'update' | 'uninstall' | 'signIn'; installation: string };

/** The ids of the steps an action may run, as a person was shown them; none to list its steps. */
export type ProviderSetupAuthorization = RunContext['authorized'];

/** One way to install the provider here, and the steps installing so takes. */
export type ProviderSetupInstallOption = {
  id: string;
  title: string;
  description: RichText;
  steps: ManualStep[];
};

/** One installation, as its check and the actions since found it, and the steps of its actions. */
export type ProviderSetupInstallation = Installation &
  InstallationState & {
    /** Which of its optional actions it has, and whether it can be checked for updates. */
    can: { checkForUpdates: boolean; update: boolean; uninstall: boolean };
    /** The steps of the actions that change it; null where it has no such action. */
    steps: { update: ManualStep[] | null; uninstall: ManualStep[] | null; signIn: ManualStep[] };
  };

/** One check or action run, as it goes: what it did, what its commands printed, how it ended. */
export type ProviderSetupRun = {
  id: string;
  operation: ProviderSetupOperation;
  activities: Activity[];
  /** The lines its commands printed, the latest last: where a sign-in page is found. */
  output: string[];
  /** The steps it left to a person. */
  manual: ManualStep[];
  failure: StepFailure | null;
  /** The run in a few words once it is over ("Installed"); null until then. */
  summary: string | null;
  startedAt: number;
  finishedAt: number | null;
};

/** A provider's setup on this computer, as last checked, and its recent runs. */
export type ProviderSetupSnapshot = {
  provider: string;
  /** What the last check found; null until the first is done. */
  checked: {
    installations: ProviderSetupInstallation[];
    /** The installation that runs where none is chosen: the first on PATH. */
    defaultInstallation: string | null;
    /** The installation sessions here use: the one chosen, else the default; null where none. */
    used: string | null;
    /** Whether an installation is chosen, rather than the default used. */
    chosen: boolean;
    /**
     * Whether sessions here use an executable this setup does not list: one
     * chosen by its command, or a chosen one no longer there.
     */
    usesOther: boolean;
    installOptions: ProviderSetupInstallOption[];
    /** The install option saved as the way to install it; null where none is. */
    preferredOption: string | null;
    at: number;
  } | null;
  /** What is running now; null where nothing is. */
  running: ProviderSetupOperation | null;
  /** The recent runs, the latest last. */
  runs: ProviderSetupRun[];
  /** Why the last check could not be done; null where it was. */
  error: string | null;
};
