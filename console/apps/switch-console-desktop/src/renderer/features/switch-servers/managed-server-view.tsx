import { useQuery } from '@tanstack/react-query';
import { ArrowUpCircle, Power, ShieldCheck } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { type GuardResult, type ViewDefinition } from '@renderer/app/view-registry';
import { AdminFrame, adminGroupsInScope } from '@renderer/features/admin/admin-frame';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Switch } from '@renderer/lib/ui/switch';
import {
  CHECKOUT_IMAGE_TAG,
  type LocalActivityEntry,
  type StackActivityEntry,
  othersRecentlySeen,
  switchVersionDowngradeMessage,
} from '@shared/core/managed-switch-server/managed-switch-server';
import { explainStartFailure } from '@shared/core/managed-switch-server/start-failure';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { DOCKER_RECHECK_MS, recheckDocker } from './docker-recheck';
import { localServerStore } from './local-server-store';
import { LogTail } from './log-tail';
import {
  managedServerError,
  managedServerLogs,
  managedServerProgress,
  startManagedServer,
  stopManagedServer,
} from './managed-server-actions';
import { WorkingSpinner } from './managed-server-dot';
import {
  type ManagedServerState,
  isFrozenServer,
  managedServerState,
} from './managed-server-state';
import { managedTelemetryNotice } from './managed-telemetry-notice';
import { remoteServerStore } from './remote-server-store';
import { serverIcon } from './server-icon';
import {
  ActivityRow,
  DetailRow,
  GhostButton,
  MessageBox,
  Mono,
  PrimaryButton,
  SectionLabel,
  StatusPill,
} from './server-page-ui';
import { ServerResetSection } from './server-reset-section';
import { ServerSectionTitlebar } from './server-section-titlebar';
import { activityWhen, agoLabel, sinceLabel } from './server-times';
import { useSharedActionConfirm } from './shared-action-confirm';
import { namesOf, selfDesktop, sharedWithSentence } from './shared-consoles';
import { switchServersStore } from './switch-servers-store';
import { TelemetryConsentNotice } from './TelemetryConsentNotice';

const ACTIVITY_SHOWN = 5;

function useServerId(): string {
  return useParams('managedServer').params.serverId;
}

/** Part of the Admin page, whose menu it is drawn beside, so titled as it is. */
const ManagedServerTitlebar = observer(function ManagedServerTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={ShieldCheck} label="Admin" />;
});

/** One line of recent activity, from either kind of record. */
type ActivityItem = { key: string; what: string; who: string | null; at: string };

const LOCAL_WHAT: Record<LocalActivityEntry['action'], (detail: string | null) => string> = {
  started: () => 'Started',
  stopped: () => 'Stopped',
  'start-failed': () => 'Start failed',
  crashed: () => 'Stopped unexpectedly',
  updated: (detail) => (detail ? `Updated to ${detail}` : 'Updated'),
  reset: () => 'Reset',
};

const REMOTE_WHAT: Record<StackActivityEntry['action'], string> = {
  started: 'Started',
  connected: 'Connected',
  stopped: 'Stopped',
  reset: 'Reset',
  disconnected: 'Disconnected',
};

function NamesInBold({ names }: { names: string[] }) {
  return (
    <>
      {names.map((name, i) => (
        <span key={name}>
          {i > 0 && (i === names.length - 1 ? ' and ' : ', ')}
          <strong className="font-semibold text-foreground">{name}</strong>
        </span>
      ))}
    </>
  );
}

const ManagedServerMainPanel = observer(function ManagedServerMainPanel() {
  const serverId = useServerId();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  if (!server || !server.managed) {
    return (
      <div className="relative z-10 flex min-h-0 flex-1 overflow-auto bg-background p-6">
        <p className="text-sm text-foreground-muted">
          {server
            ? 'This server is not run by Switch Console.'
            : 'This server is no longer available.'}
        </p>
      </div>
    );
  }
  return <ManagedServerInAdmin server={server} />;
});

/**
 * The page as the Admin menu's Status entry. While the server can't answer
 * the menu holds only this entry: the rest need the server, and the way to
 * start it is all that stays live.
 */
const ManagedServerInAdmin = observer(function ManagedServerInAdmin({
  server,
}: {
  server: SwitchServer;
}) {
  const serviceConnections = useFeatureFlags(server.id).service_connections;
  const groups = adminGroupsInScope(server.id, serviceConnections && !isFrozenServer(server));
  return (
    <AdminFrame serverId={server.id} groups={groups} active="status">
      <ManagedServerPage server={server} />
    </AdminFrame>
  );
});

const ManagedServerPage = observer(function ManagedServerPage({
  server,
}: {
  server: SwitchServer;
}) {
  const sshHost = server.managementKind === 'remote' ? server.sshHost : null;
  const confirm = useSharedActionConfirm(sshHost);
  const [showLog, setShowLog] = useState(false);
  const { value: telemetry } = useAppSettingsKey('telemetry');
  const now = new Date();

  useEffect(() => {
    void hostReachabilityStore.hydrate();
    if (sshHost) {
      void remoteServerStore.init();
      void remoteServerStore.checkDocker(sshHost);
      void remoteServerStore.loadRegister(sshHost);
      // Someone else may have started or removed a stack shown as stopped.
      void remoteServerStore.refresh(sshHost);
    } else {
      void localServerStore.checkDocker();
    }
  }, [sshHost]);

  // The Mattermost switch waits on Docker, which people often start only after
  // opening this page to find the switch greyed out.
  const localDockerDown = sshHost === null && localServerStore.docker?.available === false;
  useEffect(() => {
    if (!localDockerDown) return;
    return recheckDocker(() => localServerStore.checkDocker(), window, DOCKER_RECHECK_MS);
  }, [localDockerDown]);

  const state = managedServerState(server) ?? null;
  const status = sshHost ? remoteServerStore.statusFor(sshHost) : localServerStore.status;
  const reason = state?.reason ?? 'stopped';
  const answering = state?.answering ?? false;

  const startedAt = useQuery({
    queryKey: ['managed-server-started-at', server.id, reason],
    queryFn: () =>
      sshHost ? rpc.remoteSwitchServer.startedAt(sshHost) : rpc.localSwitchServer.startedAt(),
    enabled: answering,
  });
  const localActivity = useQuery({
    queryKey: ['local-server-activity', reason],
    queryFn: () => rpc.localSwitchServer.activity(),
    enabled: sshHost === null,
  });

  if (!state || !status) return null;

  const register = sshHost ? remoteServerStore.registerFor(sshHost) : null;
  const others = othersRecentlySeen(register, now);
  const self = selfDesktop(register);
  const activity: ActivityItem[] = sshHost
    ? (register?.activity ?? []).map((entry) => ({
        key: `${entry.at}-${entry.consoleId}-${entry.action}`,
        what: REMOTE_WHAT[entry.action],
        who: entry.consoleId === register?.self ? 'You' : entry.name,
        at: entry.at,
      }))
    : (localActivity.data ?? []).map((entry) => ({
        key: `${entry.at}-${entry.action}`,
        what: LOCAL_WHAT[entry.action](entry.detail),
        who: 'You',
        at: entry.at,
      }));
  const lastStopped = sshHost
    ? register?.activity.find((entry) => entry.action === 'stopped')?.at
    : localActivity.data?.find((entry) => entry.action === 'stopped')?.at;
  const lastFailedAt = sshHost
    ? undefined
    : localActivity.data?.find((entry) => entry.action === 'start-failed')?.at;
  // Nothing comes back after a reset: it deleted the agents and the data.
  const justReset = sshHost === null && localActivity.data?.[0]?.action === 'reset';

  const workspaceNames = workspacesStore
    .onServer(server.id)
    .filter((w) => w.tenantId !== null)
    .map((w) => w.name);
  const logs = managedServerLogs(server);
  const Icon = serverIcon(server);
  const placement = sshHost ?? 'This computer';
  const deployed = status.deployedVersion ?? status.version;
  const checkout = sshHost ? null : localServerStore.checkoutBuild;
  const native = sshHost === null && localServerStore.isNative;
  const localDocker = sshHost ? null : localServerStore.docker;
  const runsCheckout = status.deployedVersion === CHECKOUT_IMAGE_TAG;
  const working = state.tone === 'working';

  const restart = () => confirm.request('restart', () => startManagedServer(server));
  const stop = () => confirm.request('stop', () => stopManagedServer(server));
  // A retry restarts a server still up for anyone else on it, so it asks the
  // same way; a stopped one reaches nobody.
  const retry = status.phase === 'running' ? restart : () => startManagedServer(server);
  const telemetryNotice = managedTelemetryNotice({
    running: answering,
    deployed: status.deployedTelemetry,
    consent: telemetry?.enabled ?? true,
    sharedWithOthers: confirm.shared,
  });

  return (
    <div className="min-w-0 pt-10 pb-10">
      <div className="w-full max-w-[720px] space-y-[18px]">
        <header className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--fill)]">
            <Icon className="size-[18px] text-[var(--srv-stopped-text)]" />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-[17px] font-semibold text-foreground">{server.name}</h2>
              <StatusPill state={state} />
            </div>
            <p className="truncate text-[13px] text-[var(--fg-dim)]">
              {placement} · {native ? 'runs without Docker' : 'runs with Docker'}
            </p>
          </div>
        </header>

        <Actions
          server={server}
          state={state}
          hasLogs={logs.length > 0}
          showLog={showLog}
          onToggleLog={() => setShowLog((shown) => !shown)}
          onRestart={restart}
          onRetry={retry}
          onStop={stop}
        />

        {sharedWithSentence(others, self) && (
          <p className="text-[13px] text-[var(--fg-dim)]">{sharedWithSentence(others, self)}</p>
        )}

        <Messages
          server={server}
          state={state}
          workspaceNames={workspaceNames}
          othersNames={namesOf(others, self)}
          lastFailedAt={lastFailedAt ?? null}
          justReset={justReset}
          now={now}
        />

        {showLog && logs.length > 0 && <LogTail lines={logs} placeholder={null} />}

        {telemetryNotice && (
          <TelemetryConsentNotice notice={telemetryNotice} disabled={working} onRestart={restart} />
        )}

        <section>
          <SectionLabel>Details</SectionLabel>
          <div className="mt-1">
            <DetailRow label="switch-core">
              {runsCheckout && checkout ? (
                <span className="font-[Menlo,ui-monospace,monospace] text-[11.5px]">
                  built from {checkout.root}
                </span>
              ) : reason === 'update-ready' && status.upgrade ? (
                <span className="text-[var(--srv-working-text)]">
                  {status.upgrade.from} → {status.upgrade.to}
                </span>
              ) : state.tone === 'running' && !status.upgrade && !status.drift ? (
                `${deployed} · up to date`
              ) : (
                deployed
              )}
            </DetailRow>
            {answering && startedAt.data && (
              <DetailRow label="Running since">{sinceLabel(startedAt.data, now)}</DetailRow>
            )}
            {!answering && !working && lastStopped && (
              <DetailRow label="Last running">{agoLabel(lastStopped, now)}</DetailRow>
            )}
            {workspaceNames.length > 0 && (
              <DetailRow label="Workspaces">
                {workspaceNames.join(', ')}
                {working ? ' · available once running' : !answering ? ' · unavailable' : ''}
              </DetailRow>
            )}
          </div>
        </section>

        {(activity.length > 0 || localActivity.isError) && (
          <section>
            <SectionLabel>Recent activity</SectionLabel>
            <div className="mt-1">
              {localActivity.isError && (
                <p className="py-[7px] text-[13px] text-[var(--fg-dim)]">
                  Couldn't read this server's history.
                </p>
              )}
              {activity.slice(0, ACTIVITY_SHOWN).map((item) => (
                <ActivityRow
                  key={item.key}
                  what={item.what}
                  when={`${item.who ? `${item.who} · ` : ''}${activityWhen(item.at, now)}`}
                />
              ))}
            </div>
          </section>
        )}

        {native && (
          <div className="flex items-start justify-between gap-3 rounded-[10px] border-[0.5px] border-[var(--hair-strong)] px-[14px] py-3">
            <div className="min-w-0">
              <p className="text-[13px] text-foreground">Mattermost</p>
              <p className="mt-0.5 text-xs text-[var(--fg-dim)]">
                {answering && localServerStore.mattermostState === 'starting'
                  ? 'Setting up beside the server… the server is already usable.'
                  : answering && localServerStore.mattermostState === 'running'
                    ? 'Running. Team chat for your rooms, in Docker beside the server.'
                    : localDocker === null
                      ? 'Checking for Docker…'
                      : localDocker.available
                        ? 'Team chat for your rooms, run in Docker beside the server.'
                        : `Team chat for your rooms needs Docker. ${localDocker.detail} The server works without it.`}
              </p>
            </div>
            <Switch
              checked={localServerStore.mattermost}
              disabled={
                working || (!localServerStore.mattermost && !(localDocker?.available ?? false))
              }
              onCheckedChange={(enabled) => void localServerStore.setMattermost(enabled)}
              aria-label="Run Mattermost"
            />
          </div>
        )}

        {/* Dev builds launched from a Switch checkout only. */}
        {checkout && (
          <div className="flex items-start justify-between gap-3 rounded-[10px] border-[0.5px] border-dashed border-[var(--hair-strong)] px-[14px] py-3">
            <div className="min-w-0">
              <p className="text-[13px] text-foreground">Build switch-core from this checkout</p>
              <p className="mt-0.5 text-xs text-[var(--fg-dim)]">
                Dev builds only. {native ? 'Installs switch-core from' : 'Builds the images from'}{' '}
                <span className="font-mono break-all">{checkout.root}</span> on every start instead
                of {native ? 'the' : 'pulling'} switch-core {status.version}
                {native ? ' release' : ''}.
                {checkout.forcedBy !== null &&
                  ` ${checkout.enabled ? 'On' : 'Off'} for this run: ${checkout.forcedBy} is set.`}
                {answering && checkout.enabled !== runsCheckout && ' Restart the server to apply.'}
              </p>
            </div>
            <Switch
              checked={checkout.enabled}
              disabled={working || checkout.forcedBy !== null}
              onCheckedChange={(enabled) => void localServerStore.setCheckoutBuild(enabled)}
              aria-label="Build switch-core from this checkout"
            />
          </div>
        )}

        <ServerResetSection
          dialogTitle={sshHost ? `Reset server on ${sshHost}` : 'Reset server on this computer'}
          shared={sshHost !== null}
          affected={confirm.who}
          disabled={working}
          onConfirm={() => {
            if (sshHost) {
              void remoteServerStore.reset(sshHost);
              return;
            }
            void localServerStore.reset();
          }}
        />
        {confirm.dialog}
      </div>
    </div>
  );
});

/** The buttons under the name. At most one is primary. */
const Actions = observer(function Actions({
  server,
  state,
  hasLogs,
  showLog,
  onToggleLog,
  onRestart,
  onRetry,
  onStop,
}: {
  server: SwitchServer;
  state: ManagedServerState;
  hasLogs: boolean;
  showLog: boolean;
  onToggleLog: () => void;
  onRestart: () => void;
  onRetry: () => void;
  onStop: () => void;
}) {
  const sshHost = server.managementKind === 'remote' ? server.sshHost : null;
  const logButton = hasLogs && (
    <GhostButton onClick={onToggleLog}>{showLog ? 'Hide log' : 'Show log'}</GhostButton>
  );

  switch (state.reason) {
    case 'running':
    case 'version-mismatch':
    case 'version-unknown':
      return (
        <div className="flex flex-wrap gap-2">
          <GhostButton onClick={onRestart}>Restart</GhostButton>
          <GhostButton onClick={onStop}>Stop</GhostButton>
        </div>
      );
    case 'update-ready':
      return (
        <div className="flex flex-wrap gap-2">
          {/* The message under it names who the update reaches. */}
          <PrimaryButton onClick={() => startManagedServer(server)}>
            <ArrowUpCircle />
            Update now
          </PrimaryButton>
          <GhostButton onClick={onStop}>Stop</GhostButton>
        </div>
      );
    case 'stopped':
      return (
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => startManagedServer(server)}>
            <Power />
            Start
          </PrimaryButton>
        </div>
      );
    case 'waiting':
      return (
        <div className="flex flex-wrap gap-2">
          {sshHost && (
            <GhostButton onClick={() => void remoteServerStore.cancelWait(sshHost)}>
              Stop waiting
            </GhostButton>
          )}
          {logButton}
        </div>
      );
    case 'starting':
    case 'stopping':
    case 'updating':
    case 'busy':
      return (
        <div className="flex flex-wrap gap-2">
          <GhostButton onClick={onStop} disabled>
            Stop
          </GhostButton>
          {logButton}
        </div>
      );
    case 'host-unreachable':
      return (
        <div className="flex flex-wrap gap-2">
          {sshHost && (
            <PrimaryButton
              disabled={hostReachabilityStore.isRetrying(sshHost)}
              onClick={() => void hostReachabilityStore.retry(sshHost)}
            >
              Try again
            </PrimaryButton>
          )}
        </div>
      );
    case 'downgrade':
      // Nothing safe to press: its database has already moved past this app.
      return logButton ? <div className="flex flex-wrap gap-2">{logButton}</div> : null;
    case 'stopped-unexpectedly':
      return (
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => startManagedServer(server)}>
            <Power />
            Restart
          </PrimaryButton>
          {logButton}
        </div>
      );
    case 'stop-failed':
      return (
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={onStop}>Stop again</PrimaryButton>
          {logButton}
        </div>
      );
    case 'reset-failed':
      // Running it again is the Reset section's job, behind its confirmation.
      return logButton ? <div className="flex flex-wrap gap-2">{logButton}</div> : null;
    case 'start-failed':
    case 'docker-unavailable':
    case 'update-failed':
      return (
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={onRetry}>Try again</PrimaryButton>
          {logButton}
        </div>
      );
  }
});

/** The message box, when there is something to act on or wait for. */
const Messages = observer(function Messages({
  server,
  state,
  workspaceNames,
  othersNames,
  lastFailedAt,
  justReset,
  now,
}: {
  server: SwitchServer;
  state: ManagedServerState;
  workspaceNames: string[];
  /** Who else has used it lately, as one phrase; empty when nobody has. */
  othersNames: string;
  lastFailedAt: string | null;
  /** The last thing done to this computer's server was a reset. */
  justReset: boolean;
  now: Date;
}) {
  const sshHost = server.managementKind === 'remote' ? server.sshHost : null;
  const status = sshHost ? remoteServerStore.statusFor(sshHost) : localServerStore.status;
  const docker = sshHost ? remoteServerStore.dockerFor(sshHost) : localServerStore.docker;
  const storeError = sshHost ? remoteServerStore.error : localServerStore.error;
  const progress = managedServerProgress(server);
  const upgrade = status?.upgrade ?? null;
  const drift = status?.drift ?? null;

  const box = (() => {
    switch (state.reason) {
      case 'starting':
      case 'stopping':
      case 'busy':
      case 'waiting':
        return (
          <MessageBox
            tone="working"
            icon={<WorkingSpinner />}
            title={progress ?? `${state.label}…`}
          >
            {progress && /pull/i.test(progress) && (
              <p>This can take a few minutes the first time.</p>
            )}
          </MessageBox>
        );
      case 'updating':
        return (
          <MessageBox
            tone="working"
            icon={<WorkingSpinner />}
            title={upgrade ? `Updating switch-core ${upgrade.from} → ${upgrade.to}…` : 'Updating…'}
          >
            <p>
              Agents pause until it's done. Rooms and messages are kept, and the database is backed
              up first.
            </p>
            {progress && <p className="text-[var(--fg-dim)]">{progress}</p>}
          </MessageBox>
        );
      case 'update-ready':
        return (
          <MessageBox tone="attention" title={`switch-core ${upgrade?.to ?? ''} is ready`}>
            <p>
              {othersNames
                ? `Updating restarts the server for everyone on it. ${othersNames} used it recently; their agents pause for about a minute.`
                : 'Updating restarts the server; agents pause for about a minute.'}
            </p>
          </MessageBox>
        );
      case 'version-mismatch':
        return drift && drift.direction === 'unknown' ? (
          <MessageBox tone="attention" title="Version mismatch">
            <p>
              Runs switch-core {drift.deployed}; this app expects {drift.expected}. Can't tell which
              is newer, so restart only if {drift.expected} isn't older.
            </p>
          </MessageBox>
        ) : null;
      case 'version-unknown':
        return drift && drift.direction === 'unreadable' ? (
          <MessageBox tone="attention" title="Can't tell which switch-core this runs">
            <p>This app expects {drift.expected}, but the running version couldn't be read.</p>
            <Mono>{drift.reason}</Mono>
          </MessageBox>
        ) : null;
      case 'stopped':
        return (
          <MessageBox tone="stopped">
            {justReset ? (
              <p>This server was reset. Start it to set it up again, empty.</p>
            ) : workspaceNames.length > 0 ? (
              <p>
                Agents and rooms in <NamesInBold names={workspaceNames} /> live here. They come back
                once it's running.
                {upgrade &&
                  ` Starting it updates switch-core ${upgrade.from} → ${upgrade.to} first.`}
              </p>
            ) : (
              <p>
                Agents and rooms on this server come back once it's running.
                {upgrade &&
                  ` Starting it updates switch-core ${upgrade.from} → ${upgrade.to} first.`}
              </p>
            )}
          </MessageBox>
        );
      case 'host-unreachable': {
        const reachability = sshHost ? hostReachabilityStore.get(sshHost) : null;
        return (
          <MessageBox tone="failed" title={`Can't reach ${sshHost ?? server.name}`}>
            {reachability?.lastError && <Mono>{reachability.lastError}</Mono>}
            <p>Switch Console keeps trying, and picks the server up again once the host answers.</p>
          </MessageBox>
        );
      }
      case 'downgrade':
        return drift && drift.direction === 'downgrade' ? (
          <MessageBox tone="failed" title="This server is newer than Switch Console">
            <p>{switchVersionDowngradeMessage(drift.deployed, drift.expected)}</p>
          </MessageBox>
        ) : null;
      case 'docker-unavailable':
        return (
          <MessageBox
            tone="failed"
            title={
              docker && !docker.available && docker.reason === 'not-installed'
                ? `Docker isn't installed${sshHost ? ` on ${sshHost}` : ''}`
                : `Docker isn't running${sshHost ? ` on ${sshHost}` : ''}`
            }
          >
            {docker && !docker.available && <Mono>{docker.detail}</Mono>}
            <p>Start Docker, then try again.</p>
          </MessageBox>
        );
      case 'update-failed':
        return (
          <MessageBox
            tone="failed"
            title={upgrade ? `Couldn't update to switch-core ${upgrade.to}` : "Couldn't update"}
          >
            {upgrade?.state === 'failed' && <Mono>{upgrade.error}</Mono>}
            <p>Agents stay paused until the update succeeds. The server's data is kept.</p>
          </MessageBox>
        );
      case 'start-failed':
        return (
          <StartFailedBox
            error={managedServerError(server) ?? storeError ?? 'The server stopped during start.'}
            failedAt={lastFailedAt}
            local={sshHost === null}
            now={now}
          />
        );
      case 'stopped-unexpectedly':
        return (
          <MessageBox tone="failed" title="The server stopped unexpectedly">
            {managedServerError(server) && <Mono>{managedServerError(server)}</Mono>}
            <p>Restart it to bring agents and rooms back. The server's data is kept.</p>
          </MessageBox>
        );
      case 'stop-failed':
        return (
          <MessageBox tone="failed" title="Couldn't stop">
            <Mono>{explainStartFailure(managedServerError(server) ?? '').line}</Mono>
            <p>It may still be running. Stop it again to finish.</p>
          </MessageBox>
        );
      case 'reset-failed':
        return (
          <MessageBox tone="failed" title="The reset didn't finish">
            <Mono>{explainStartFailure(managedServerError(server) ?? '').line}</Mono>
            <p>Some of its data may already be gone. Reset it again below to finish.</p>
          </MessageBox>
        );
      case 'running':
        return null;
    }
  })();

  // Said by other Consoles, or about this one's record on the host. Shown on
  // their own: they are about the server, not about its state.
  const remote = sshHost ? remoteServerStore.statusFor(sshHost) : null;
  const working = state.tone === 'working';
  const localNotice = sshHost ? null : (localServerStore.status?.notice ?? null);
  return (
    <>
      {box}
      {localNotice && !working && (
        <MessageBox tone="attention">
          <p>{localNotice}</p>
        </MessageBox>
      )}
      {remote?.notice && !working && (
        <MessageBox tone="stopped">
          <p>{remote.notice}</p>
        </MessageBox>
      )}
      {remote?.recordWarning && !working && (
        <MessageBox tone="attention">
          <p>{remote.recordWarning}</p>
        </MessageBox>
      )}
      {storeError && state.reason !== 'start-failed' && (
        <MessageBox tone="failed" title={storeError}>
          {(sshHost ? remoteServerStore.errorDetail : localServerStore.errorDetail) && (
            <Mono>{sshHost ? remoteServerStore.errorDetail : localServerStore.errorDetail}</Mono>
          )}
        </MessageBox>
      )}
    </>
  );
});

/** Why the last start failed: the line that says so, what to do, and the way
 * out when it is one this app can take. */
function StartFailedBox({
  error,
  failedAt,
  local,
  now,
}: {
  error: string;
  failedAt: string | null;
  local: boolean;
  now: Date;
}) {
  const failure = explainStartFailure(error);
  const [moving, setMoving] = useState(false);
  return (
    <MessageBox
      tone="failed"
      title={failedAt ? `Couldn't start · ${activityWhen(failedAt, now)}` : "Couldn't start"}
    >
      <Mono>{failure.line}</Mono>
      {failure.hint && <p>{failure.hint}</p>}
      {/* Only here: a remote host's ports are chosen with its forwards, and
          moving one is not this button's to do. */}
      {local && failure.port !== null && (
        <GhostButton
          disabled={moving}
          className="h-[26px] text-[12.5px]"
          onClick={() => {
            const port = failure.port;
            if (port === null) return;
            setMoving(true);
            void localServerStore.useAnotherPort(port).finally(() => setMoving(false));
          }}
        >
          Use another port
        </GhostButton>
      )}
    </MessageBox>
  );
}

export const managedServerView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string }) => <>{children}</>,
  TitlebarSlot: ManagedServerTitlebar,
  MainPanel: ManagedServerMainPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return { ok: false, redirect: 'home' };
    if (switchServersStore.loaded && !switchServersStore.servers.some((s) => s.id === serverId)) {
      return { ok: false, redirect: 'home', discardParams: true };
    }
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string }>;
