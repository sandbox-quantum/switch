import { useCallback, useEffect, useMemo, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { events, rpc } from '@renderer/lib/ipc';
import { agentProviders } from '@shared/core/providers/agent-provider-registry';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import { providerLoginExitChannel, providerLoginLineChannel } from '@shared/events/appEvents';
import { type BuddyProvider, buddyProviders } from './buddy-providers';
import { reportBuddyStep } from './buddy-telemetry';
import { installFailure } from './install-failure';
import { useStartBuddy } from './use-start-buddy';
import type { ThisComputer } from './use-this-computer';

/** How many lines of a sign-in command's output are kept on screen. */
const KEPT_LINES = 40;

export type Login = {
  attemptId: string;
  providerId: string;
  lines: string[];
  /** Null while it runs; then how it ended. */
  ended: { ok: boolean; error: string | null } | null;
};

/** What the card is busy with, which disables the rest. */
export type SetupBusy = 'install' | 'check' | 'create' | null;

/**
 * Getting a provider ready on this computer and starting switch-buddy with
 * it: everything the provider card does, without drawing it.
 *
 * What a provider needs is read from what this computer's agent controller
 * reports to Switch, which is what Switch checks before creating an agent.
 * Installing a CLI or signing it in is followed by asking the controller to
 * check again straight away, so the card moves on as soon as it is true
 * rather than at the controller's next check.
 */
export function useProviderSetup({
  serverId,
  workspaceId,
  entryPoint,
  onCreated,
  computer,
  recheck,
}: {
  serverId: string;
  workspaceId: string;
  entryPoint: UiEntryPoint;
  onCreated: (agent: { agentId: string; name: string }) => void;
  computer: ThisComputer;
  /** Has this computer check its providers again; a line when nothing new was found. */
  recheck: () => Promise<string | null>;
}) {
  const providers = useMemo(
    () => buddyProviders(agentProviders(), computer.kind === 'ready' ? computer.machine : null),
    [computer]
  );
  const [picked, setPicked] = useState<string | null>(null);
  const selected =
    providers.find((p) => p.id === picked) ??
    providers.find((p) => p.state === 'ready') ??
    providers.find((p) => p.state === 'sign-in') ??
    null;

  const [working, setWorking] = useState<'install' | 'check' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const started = useStartBuddy({ serverId, workspaceId, computer, entryPoint, onCreated });
  const busy = working ?? (started.starting !== null ? 'create' : null);
  // One error at a time, as each action clears what the last one said.
  const error = actionError ?? started.error;
  const { clearError } = started;
  const setError = useCallback(
    (message: string | null) => {
      setActionError(message);
      clearError();
    },
    [clearError]
  );

  const [login, setLogin] = useState<Login | null>(null);
  /** What the last Check again found, when it found nothing new: said, not left blank. */
  const [checked, setChecked] = useState<string | null>(null);

  const checkAgain = useCallback(async () => {
    reportBuddyStep('check_again', null);
    setWorking('check');
    setError(null);
    setChecked(null);
    try {
      setChecked(await recheck());
    } catch (cause) {
      setError(failureText(cause, 'Could not check this computer again.'));
    } finally {
      setWorking(null);
    }
  }, [recheck, setError]);

  useEffect(() => {
    const offLine = events.on(providerLoginLineChannel, ({ attemptId, line }) =>
      setLogin((current) =>
        current?.attemptId === attemptId
          ? { ...current, lines: [...current.lines, line].slice(-KEPT_LINES) }
          : current
      )
    );
    const offExit = events.on(providerLoginExitChannel, ({ attemptId, exitCode, error: why }) => {
      let ours = false;
      setLogin((current) => {
        if (current?.attemptId !== attemptId) return current;
        ours = true;
        return { ...current, ended: { ok: exitCode === 0 && why === null, error: why } };
      });
      if (ours) void checkAgain();
    });
    return () => {
      offLine();
      offExit();
    };
  }, [checkAgain]);

  useEffect(() => () => void rpc.providers.cancelLogin(), []);

  const signIn = async (provider: BuddyProvider) => {
    reportBuddyStep('sign_in', provider.id);
    setError(null);
    try {
      const { attemptId } = await rpc.providers.startLogin(provider.id);
      setLogin({ attemptId, providerId: provider.id, lines: [], ended: null });
    } catch (cause) {
      setError(failureText(cause, `Could not start signing in to ${provider.name}.`));
    }
  };

  const install = async (provider: BuddyProvider) => {
    reportBuddyStep('install', provider.id);
    setWorking('install');
    setError(null);
    try {
      const result = await rpc.providers.install(provider.id);
      if (!result.success) setError(installFailure(provider.name, result.error));
      await recheck();
    } catch (cause) {
      setError(failureText(cause, `Could not install ${provider.name}.`));
    } finally {
      setWorking(null);
    }
  };

  const start = (provider: BuddyProvider) => {
    if (computer.kind !== 'ready') return;
    setActionError(null);
    started.start(provider.id);
  };

  const cancelSignIn = () => {
    void rpc.providers.cancelLogin();
    setLogin(null);
    setChecked(null);
  };

  return {
    providers,
    selected,
    pick: setPicked,
    busy: busy as SetupBusy,
    error,
    login,
    checked,
    checkAgain,
    signIn,
    cancelSignIn,
    install,
    start,
  };
}
