import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import type {
  AgentOnboardingError,
  ModeData as AgentOnboardingModeData,
} from '@renderer/features/locations/stores/agent-onboarding-types';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import type { ServerVerifyState } from '@renderer/features/switch-servers/agent-server-picker';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import {
  useModalContext,
  useShowModal,
  type BaseModalProps,
} from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { log } from '@renderer/utils/logger';
import type { ProvisionAgentResult } from '@shared/core/switch-servers/switch-servers';
import { basenameFromAnyPath } from '@shared/path-name';
import { AgentTypePicker } from './agent-type-picker';
import { ConfigureAgentPanel } from './configure-agent-panel';
import { PickExistingPanel } from './content';
import { useConfigureAgentForm, usePickMode } from './modes';
import { SubagentOnboardingSection, type SubagentSelection } from './subagent-onboarding-section';

// switchdash adds a Switch *agent* by pointing at a local directory that the
// switch-connector `configure` skill has set up (its `.claude/settings.local.json`
// carries the SWITCH_* env block). The richer switchdash flows — SSH, clone, create
// new GitHub repo — are out of scope for v0, so this modal is local + pick only.
export type AddProjectModalProps = BaseModalProps<void>;

/** Sentinel `runHost` value meaning "run on this machine" (no remote host). */
const LOCAL_RUN_LOCATION = 'local';

export const AddAgentModal = observer(function AddAgentModal({
  onClose,
}: AddProjectModalProps) {
  const [submitState, setSubmitState] = useState<'idle' | 'creating'>('idle');
  const [verifyState, setVerifyState] = useState<ServerVerifyState>('idle');
  const { navigate } = useNavigate();
  const { setCloseGuard } = useModalContext();
  const showAddServerModal = useShowModal('addServerModal');

  const pickState = usePickMode();
  const configureForm = useConfigureAgentForm(pickState.path);

  // Run location: 'local' (default) or an onboarded remote host's SSH alias. A
  // remote agent runs its sessions on the host and needs a remote working dir.
  const [runHost, setRunHost] = useState<string>(LOCAL_RUN_LOCATION);
  const [remoteRepoDir, setRemoteRepoDir] = useState('');
  // Configure form for onboarding a brand-new agent in the remote dir. Defaults
  // (name/description) are derived from the remote dir just like a local agent.
  const remoteConfigureForm = useConfigureAgentForm(remoteRepoDir.trim());
  const { data: remoteHosts } = useQuery({
    queryKey: ['remote-hosts'],
    queryFn: () => rpc.remoteHosts.listHosts(),
  });
  const onboardedHosts = remoteHosts ?? [];
  const isRemoteRun = runHost !== LOCAL_RUN_LOCATION;
  const remoteRunValid = !isRemoteRun || remoteRepoDir.trim().length > 0;

  // An agent always binds to the active (scoped) server — the user does not pick
  // one here. Ensure the server list + active id are loaded when the modal opens
  // standalone, otherwise nothing seeds the pick state.
  useEffect(() => {
    void switchServersStore.init();
  }, []);

  // Seed the pick state from the active server so detection/verification and
  // provisioning target the server whose view they are adding the agent into.
  // When no server is active yet but exactly one exists (e.g. right after the
  // first server was added, before it was ever activated), preselect it so the
  // common single-server case needs no extra click.
  const activeServerId = switchServersStore.activeServerId;
  const soleServerId =
    switchServersStore.servers.length === 1 ? switchServersStore.servers[0].id : null;
  const targetServerId = activeServerId ?? soleServerId;
  const { serverId: pickedServerId, setServerId } = pickState;
  useEffect(() => {
    if (targetServerId && pickedServerId !== targetServerId) {
      setServerId(targetServerId);
    }
  }, [targetServerId, pickedServerId, setServerId]);

  // The subagents the user chose to onboard alongside the parent. Held in a ref
  // (not state) so the section can report changes without re-rendering the modal.
  const subagentSelectionRef = useRef<SubagentSelection>([]);
  const onSubagentSelectionChange = useCallback((selection: SubagentSelection) => {
    subagentSelectionRef.current = selection;
  }, []);

  const shouldCheckPathStatus = !isRemoteRun && pickState.path.trim().length > 0;
  const pathStatusQuery = useQuery({
    queryKey: ['projectPathStatus', 'local', pickState.path],
    queryFn: () => rpc.locations.inspectLocationPath({ path: pickState.path }),
    enabled: shouldCheckPathStatus,
  });

  // Remote agents have no local directory — detect + verify the Switch agent in
  // the remote working dir over SSH instead of inspecting a local path.
  const trimmedRemoteDir = remoteRepoDir.trim();
  const shouldDetectRemote = isRemoteRun && trimmedRemoteDir.length > 0;
  const remoteAgentQuery = useQuery({
    queryKey: ['remoteAgentDetect', runHost, trimmedRemoteDir],
    queryFn: () =>
      rpc.remoteHosts.detectRemoteAgent({ sshHost: runHost, remoteRepoDir: trimmedRemoteDir }),
    enabled: shouldDetectRemote,
  });

  const inspection = pathStatusQuery.data;
  const isChecking = isRemoteRun
    ? shouldDetectRemote && remoteAgentQuery.isPending
    : shouldCheckPathStatus && pathStatusQuery.isPending;
  const switchAgent = isRemoteRun
    ? (remoteAgentQuery.data ?? null)
    : (inspection?.switchAgent ?? null);
  // A local directory with no Switch agent config offers the configure flow.
  const isMissingSwitchAgent = !isRemoteRun && !isChecking && shouldCheckPathStatus && !switchAgent;
  // A remote dir with no Switch agent offers the remote configure flow: register
  // the agent on the server and write its creds into the remote dir over SSH.
  const isMissingRemoteAgent = isRemoteRun && !isChecking && shouldDetectRemote && !switchAgent;

  // An agent always binds to the active Switch server, so there is no server
  // picker. Silently verify the detected agent exists on that server to gate
  // submission (this replaces the former inline "Switch server" picker).
  const verifyQuery = useQuery({
    queryKey: ['verifyAgent', pickState.serverId, switchAgent?.agentId],
    queryFn: async (): Promise<ServerVerifyState> => {
      const serverId = pickState.serverId;
      if (!serverId || !switchAgent) return 'idle';
      return rpc.switchServers.verifyAgent({ serverId, agentId: switchAgent.agentId });
    },
    enabled: !!pickState.serverId && !!switchAgent,
  });
  useEffect(() => {
    setVerifyState(verifyQuery.data ?? 'idle');
  }, [verifyQuery.data]);

  // Detected flow: the agent already exists; we can add it once the chosen
  // server confirms it owns the agent. Configure flow: no agent yet — gate on a
  // valid form + a chosen server, then register before adding.
  // Remote submit gate: a provider, a remote dir, a detected agent, and a
  // verified server. Name defaults from the remote dir basename (see below), so
  // it is not separately gated. Local submit keeps the existing pick validity.
  const canSubmitDetected = isRemoteRun
    ? !!pickState.providerId &&
      trimmedRemoteDir.length > 0 &&
      !isChecking &&
      !!switchAgent &&
      verifyState === 'found' &&
      submitState === 'idle'
    : pickState.isValid &&
      !isChecking &&
      !!switchAgent &&
      verifyState === 'found' &&
      submitState === 'idle';
  const canSubmitConfigure =
    isMissingSwitchAgent &&
    !isChecking &&
    configureForm.isValid &&
    !!pickState.serverId &&
    !!pickState.providerId &&
    remoteRunValid &&
    submitState === 'idle';

  // Remote configure gate: no agent in the remote dir yet — a valid remote
  // configure form + a chosen server + a provider. The server is not verified
  // here (the agent does not exist yet); it is verified after registration by
  // the create path (createRemoteProject).
  const canSubmitConfigureRemote =
    isMissingRemoteAgent &&
    !isChecking &&
    remoteConfigureForm.isValid &&
    !!pickState.serverId &&
    !!pickState.providerId &&
    trimmedRemoteDir.length > 0 &&
    submitState === 'idle';

  const reportCreationError = (error: AgentOnboardingError) => {
    if (error.type === 'switch-server-unauthenticated') {
      toast({
        title: `Sign in to ${error.serverName}`,
        description: 'This agent belongs to a server you are not signed in to yet.',
        variant: 'destructive',
      });
      navigate('server', { serverId: error.serverId });
      return;
    }
    if (error.type === 'switch-agent-not-on-server') {
      toast({
        title: `Agent not on ${error.serverName}`,
        description: 'This agent isn’t registered on the selected server. Pick another server.',
        variant: 'destructive',
      });
      return;
    }
    log.error(error);
  };

  const finishWith = (locationId: string) => {
    setCloseGuard(false);
    setSubmitState('idle');
    onClose();
    navigate('location', { locationId });
  };

  /** Run the shared create-project path with the current pick state. Returns the
   * new/existing project id, or null when there is no chosen server. */
  const startCreate = async (): Promise<string | null> => {
    if (!pickState.serverId || !pickState.providerId) return null;
    const id = crypto.randomUUID();
    const data: AgentOnboardingModeData = isRemoteRun
      ? {
          mode: 'pick',
          name: remoteConfigureForm.agentName.trim() || basenameFromAnyPath(trimmedRemoteDir),
          path: undefined,
          serverId: pickState.serverId,
          providerId: pickState.providerId,
          remote: { sshHost: runHost, dir: trimmedRemoteDir },
        }
      : {
          mode: 'pick',
          name: pickState.name,
          path: pickState.path,
          serverId: pickState.serverId,
          providerId: pickState.providerId,
          remote: undefined,
        };
    // The new project mounts (leaving the always-shown "unregistered" state)
    // before agentsStore re-fetches its agent, which would drop it out of the
    // server-scoped sidebar. Seed the project→server mapping now so it stays
    // visible, and refresh the agent list once creation succeeds.
    agentsStore.noteProjectServer(id, pickState.serverId);
    const result = await getLocationManagerStore().startAgentOnboarding(data, { id });
    if (result.kind === 'existing') return result.locationId;
    void result.completion
      .then((completion) => {
        if (completion.success) void agentsStore.load();
        else reportCreationError(completion.error);
      })
      .catch((error) => {
        log.error(error);
      });
    return result.locationId;
  };

  /** Onboard the subagents the user selected, after the parent is added. A
   * failure here is surfaced but does not block adding the parent (which already
   * succeeded). */
  const registerSelectedSubagents = async () => {
    const selection = subagentSelectionRef.current;
    if (selection.length === 0 || !pickState.serverId || !pickState.providerId) return;
    try {
      const { registered } = isRemoteRun
        ? await rpc.subagents.registerRemote({
            providerId: pickState.providerId,
            serverId: pickState.serverId,
            sshHost: runHost,
            remoteRepoDir: trimmedRemoteDir,
            subagents: selection,
          })
        : await rpc.subagents.register({
            providerId: pickState.providerId,
            serverId: pickState.serverId,
            dir: pickState.path,
            subagents: selection,
          });
      if (registered.length > 0) {
        toast({ title: `Onboarded ${registered.length} subagent(s)` });
      }
    } catch (error) {
      toast({
        title: 'Failed to onboard subagents',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  const handleSubmit = async () => {
    if (!canSubmitDetected) return;
    setSubmitState('creating');
    setCloseGuard(true);
    try {
      const locationId = await startCreate();
      if (locationId) {
        await registerSelectedSubagents();
        finishWith(locationId);
      } else {
        setCloseGuard(false);
        setSubmitState('idle');
      }
    } catch (error) {
      log.error(error);
      setCloseGuard(false);
      setSubmitState('idle');
      toast({
        title: 'Failed to add agent',
        description: String(error),
        variant: 'destructive',
      });
    }
  };

  const reportProvisionError = (result: ProvisionAgentResult) => {
    if (result.kind === 'unauthenticated' && pickState.serverId) {
      toast({
        title: 'Sign in to register the agent',
        description: 'You are not signed in to the selected server yet.',
        variant: 'destructive',
      });
      navigate('server', { serverId: pickState.serverId });
      return;
    }
    if (result.kind === 'name-conflict') {
      toast({
        title: 'Agent name already taken',
        description: 'An agent with this name already exists on the server. Pick another name.',
        variant: 'destructive',
      });
      return;
    }
    if (result.kind === 'invalid-name') {
      toast({ title: 'Invalid agent name', description: result.message, variant: 'destructive' });
      return;
    }
    if (result.kind === 'error') {
      toast({
        title: 'Failed to register agent',
        description: result.message,
        variant: 'destructive',
      });
    }
  };

  const handleConfigure = async () => {
    if (!canSubmitConfigure || !pickState.serverId || !configureForm.providerKind) return;
    setSubmitState('creating');
    setCloseGuard(true);
    try {
      const result = await rpc.switchServers.provisionAgent({
        serverId: pickState.serverId,
        dir: pickState.path,
        name: configureForm.agentName,
        description: configureForm.description.trim(),
        providerKind: configureForm.providerKind,
        notifyUser: configureForm.notifyUser.trim() || undefined,
        autoSession: configureForm.autoSession,
      });
      if (result.kind !== 'created') {
        reportProvisionError(result);
        setCloseGuard(false);
        setSubmitState('idle');
        return;
      }
      // Credentials are now written to .claude/settings.local.json, so the
      // create path re-detects the agent and verifies it on the server, and the
      // selected subagents can be registered under the just-created parent.
      const locationId = await startCreate();
      if (locationId) {
        await registerSelectedSubagents();
        finishWith(locationId);
      } else {
        setCloseGuard(false);
        setSubmitState('idle');
      }
    } catch (error) {
      log.error(error);
      setCloseGuard(false);
      setSubmitState('idle');
      toast({
        title: 'Failed to register agent',
        description: String(error),
        variant: 'destructive',
      });
    }
  };

  const handleConfigureRemote = async () => {
    if (!canSubmitConfigureRemote || !pickState.serverId || !remoteConfigureForm.providerKind) {
      return;
    }
    setSubmitState('creating');
    setCloseGuard(true);
    try {
      const result = await rpc.switchServers.provisionRemoteAgent({
        serverId: pickState.serverId,
        sshHost: runHost,
        remoteRepoDir: trimmedRemoteDir,
        name: remoteConfigureForm.agentName,
        description: remoteConfigureForm.description.trim(),
        providerKind: remoteConfigureForm.providerKind,
        notifyUser: remoteConfigureForm.notifyUser.trim() || undefined,
        autoSession: remoteConfigureForm.autoSession,
      });
      if (result.kind !== 'created') {
        reportProvisionError(result);
        setCloseGuard(false);
        setSubmitState('idle');
        return;
      }
      // Credentials are now written to the remote dir's .claude/settings.local.json,
      // so the create path (createRemoteProject) re-detects the agent over SSH and
      // verifies it on the server, and the selected subagents can be registered
      // under the just-created remote parent.
      const locationId = await startCreate();
      if (locationId) {
        await registerSelectedSubagents();
        finishWith(locationId);
      } else {
        setCloseGuard(false);
        setSubmitState('idle');
      }
    } catch (error) {
      log.error(error);
      setCloseGuard(false);
      setSubmitState('idle');
      toast({
        title: 'Failed to register agent',
        description: String(error),
        variant: 'destructive',
      });
    }
  };

  const submitLabel = submitState === 'creating' ? 'Adding...' : 'Add Agent';

  return (
    <ModalLayout
      header={
        <DialogHeader showCloseButton={submitState === 'idle'}>
          <DialogTitle>Add Switch Agent</DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter>
          {isMissingRemoteAgent ? (
            <ConfirmButton
              type="button"
              onClick={() => void handleConfigureRemote()}
              disabled={!canSubmitConfigureRemote}
            >
              {submitState === 'creating' ? 'Registering...' : 'Configure & Add Agent'}
            </ConfirmButton>
          ) : isMissingSwitchAgent ? (
            <ConfirmButton
              type="button"
              onClick={() => void handleConfigure()}
              disabled={!canSubmitConfigure}
            >
              {submitState === 'creating' ? 'Registering...' : 'Configure & Add Agent'}
            </ConfirmButton>
          ) : (
            <ConfirmButton
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmitDetected}
            >
              {submitLabel}
            </ConfirmButton>
          )}
        </DialogFooter>
      }
    >
      <DialogContentArea data-autofocus tabIndex={-1} className="max-h-[calc(100dvh-13rem)] gap-4">
        <AgentTypePicker
          value={pickState.providerId}
          onChange={pickState.setProviderId}
          sshHost={isRemoteRun ? runHost : undefined}
        />
        <Field>
          <FieldLabel>Run location</FieldLabel>
          <Select value={runHost} onValueChange={(v) => setRunHost(v ?? LOCAL_RUN_LOCATION)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={LOCAL_RUN_LOCATION}>Local (this machine)</SelectItem>
              {onboardedHosts.map((host) => (
                <SelectItem key={host.sshHost} value={host.sshHost}>
                  {host.name} ({host.sshHost})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isRemoteRun && (
            <Input
              value={remoteRepoDir}
              placeholder="Remote working directory, e.g. /home/agent/repo"
              onChange={(e) => setRemoteRepoDir(e.target.value)}
            />
          )}
        </Field>
        {!isRemoteRun && <PickExistingPanel state={pickState} showName={!isMissingSwitchAgent} />}
        {isMissingRemoteAgent && (
          <>
            <ConfigureAgentPanel
              form={remoteConfigureForm}
              serverId={pickState.serverId}
              onAddServer={() => showAddServerModal({})}
            />
            <SubagentOnboardingSection
              source={{ kind: 'remote', sshHost: runHost, remoteRepoDir: trimmedRemoteDir }}
              providerId={pickState.providerId}
              onSelectionChange={onSubagentSelectionChange}
            />
          </>
        )}
        {switchAgent && (
          <>
            <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-green-500" />
              <span>
                Switch agent detected
                <span className="ml-1 font-mono text-foreground-tertiary-passive">
                  {switchAgent.agentId.slice(0, 8)}
                </span>
              </span>
            </div>
            {switchServersStore.servers.length === 0 && (
              <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span>
                    No Switch servers are registered yet. Add the server this agent belongs to.
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() => showAddServerModal({})}
                  >
                    Add a server
                  </Button>
                </div>
              </div>
            )}
            <SubagentOnboardingSection
              source={
                isRemoteRun
                  ? { kind: 'remote', sshHost: runHost, remoteRepoDir: trimmedRemoteDir }
                  : { kind: 'local', dir: pickState.path }
              }
              providerId={pickState.providerId}
              onSelectionChange={onSubagentSelectionChange}
            />
          </>
        )}
        {isMissingSwitchAgent && (
          <>
            <ConfigureAgentPanel
              form={configureForm}
              serverId={pickState.serverId}
              onAddServer={() => showAddServerModal({})}
            />
            <SubagentOnboardingSection
              source={{ kind: 'local', dir: pickState.path }}
              providerId={pickState.providerId}
              onSelectionChange={onSubagentSelectionChange}
            />
          </>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
});
