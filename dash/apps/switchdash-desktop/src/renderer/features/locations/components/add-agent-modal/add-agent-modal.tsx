import type { SubagentAttributes } from '@switchdash/core/agents/plugins';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentOnboardingError,
  ModeData as AgentOnboardingModeData,
} from '@renderer/features/locations/stores/agent-onboarding-types';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { policyHasDeadRule } from '@renderer/features/switch-servers/addressing-policy-editor';
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
import { AgentAdvancedConfig } from './agent-advanced-config';
import { AgentTypePicker } from './agent-type-picker';
import { ConfigureAgentPanel } from './configure-agent-panel';
import { PickExistingPanel } from './content';
import { useConfigureAgentForm, usePickMode } from './modes';

// switchdash adds a Switch *agent* by pointing at a local directory that the
// switch-connector `configure` skill has set up (its `.claude/settings.local.json`
// carries the SWITCH_* env block). The richer switchdash flows — SSH, clone, create
// new GitHub repo — are out of scope for v0, so this modal is local + pick only.
export type AddLocationModalProps = BaseModalProps<void>;

/** Sentinel `runHost` value meaning "run on this machine" (no remote host). */
const LOCAL_RUN_LOCATION = 'local';

export const AddAgentModal = observer(function AddAgentModal({ onClose }: AddLocationModalProps) {
  const [submitState, setSubmitState] = useState<'idle' | 'creating'>('idle');
  const [verifyState, setVerifyState] = useState<ServerVerifyState>('idle');
  const { navigate } = useNavigate();
  const { setCloseGuard } = useModalContext();
  const showAddServerModal = useShowModal('addServerModal');

  const pickState = usePickMode();
  const configureForm = useConfigureAgentForm(pickState.path, false);

  // Run location: 'local' (default) or an onboarded remote host's SSH alias. A
  // remote agent runs its sessions on the host and needs a remote working dir.
  const [runHost, setRunHost] = useState<string>(LOCAL_RUN_LOCATION);
  // `remoteRepoDir` is the *committed* remote working dir that drives discovery
  // (SSH agent-detect, agent defaults, subagent scan). `remoteRepoDirDraft` is
  // the raw text field. They are split so typing does not refire those queries
  // on every keystroke — discovery runs only when the user commits the dir
  // (the "Set location" button or Enter). See CHOO-1440.
  const [remoteRepoDir, setRemoteRepoDir] = useState('');
  const [remoteRepoDirDraft, setRemoteRepoDirDraft] = useState('');
  // Configure form for onboarding a brand-new agent in the remote dir. Defaults
  // (name/description) are derived from the remote dir just like a local agent.
  const remoteConfigureForm = useConfigureAgentForm(remoteRepoDir.trim(), true);
  const { data: remoteHosts } = useQuery({
    queryKey: ['remote-hosts'],
    queryFn: () => rpc.remoteHosts.listHosts(),
  });
  const onboardedHosts = useMemo(() => remoteHosts ?? [], [remoteHosts]);
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

  // A managed server is only reachable from certain run locations, so constrain
  // the picker to them: a remote-managed server from this computer or its own
  // host (the desktop reaches it through the SSH forward; the host reaches it on
  // loopback — nothing else has a route); a local-managed server from this
  // computer only. External servers are unconstrained — the user owns their
  // reachability.
  const targetServer = switchServersStore.servers.find((s) => s.id === targetServerId) ?? null;
  const targetKind = targetServer?.managementKind ?? null;
  const targetHost = targetServer?.sshHost ?? null;
  const allowedHosts = useMemo(
    () =>
      onboardedHosts.filter((host) =>
        targetKind === 'remote' ? host.sshHost === targetHost : targetKind !== 'local'
      ),
    [onboardedHosts, targetKind, targetHost]
  );
  const runLocationConstrained = targetServer?.managed ?? false;
  // If the current choice falls outside what the target server allows (e.g. the
  // server changed), snap back to local.
  useEffect(() => {
    if (runHost !== LOCAL_RUN_LOCATION && !allowedHosts.some((h) => h.sshHost === runHost)) {
      setRunHost(LOCAL_RUN_LOCATION);
    }
  }, [allowedHosts, runHost]);

  // Reset the remote working dir when the run host changes so a committed dir
  // from a previous host does not leak into discovery for the new one.
  useEffect(() => {
    setRemoteRepoDir('');
    setRemoteRepoDirDraft('');
  }, [runHost]);

  // Advanced definition attributes (model, effort, tools, system prompt, …) the
  // user set in the collapsed Advanced section. Held in a ref (not state) so the
  // section can report changes without re-rendering the modal.
  const advancedAttributesRef = useRef<SubagentAttributes>({});
  const onAdvancedChange = useCallback((attributes: SubagentAttributes) => {
    advancedAttributesRef.current = attributes;
  }, []);

  const shouldCheckPathStatus = !isRemoteRun && pickState.path.trim().length > 0;
  const pathStatusQuery = useQuery({
    queryKey: ['locationPathStatus', 'local', pickState.path],
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

  // Provider agents defined in the picked dir (`.claude/agents/*.md`) — both those
  // already set up for Switch and plain provider subagents a user created directly.
  // The modal suggests onboarding them alongside the create flow; a directory is a
  // flat container of agents (CHOO-1440). Works for local and remote dirs.
  const discoverDir = isRemoteRun ? trimmedRemoteDir : pickState.path;
  const discoverSshHost = isRemoteRun ? runHost : null;
  const discoverQuery = useQuery({
    queryKey: [
      'discoverLocationAgents',
      discoverSshHost ?? 'local',
      discoverDir,
      pickState.providerId,
    ],
    queryFn: () =>
      rpc.agents.discoverLocationAgents({
        sshHost: discoverSshHost,
        dir: discoverDir,
        providerId: pickState.providerId!,
      }),
    enabled: !!pickState.providerId && discoverDir.trim().length > 0,
  });
  // Definitions that can join Switch and switchdash hasn't already onboarded — the
  // ones worth offering. Already-onboarded ones are excluded so the modal never
  // offers to re-add an agent that already exists here (CHOO-1440).
  const onboardableAgents = (discoverQuery.data ?? []).filter((a) => a.eligible && !a.alreadyAgent);
  const hasOnboardable = onboardableAgents.length > 0;

  const inspection = pathStatusQuery.data;
  const isChecking = isRemoteRun
    ? shouldDetectRemote && remoteAgentQuery.isPending
    : shouldCheckPathStatus && pathStatusQuery.isPending;
  const switchAgent = isRemoteRun
    ? (remoteAgentQuery.data ?? null)
    : (inspection?.switchAgent ?? null);
  // A local directory with no legacy Switch agent config offers the create flow.
  // This is available even when the directory already contains other agents — a
  // directory is a flat container, so you can always add another (CHOO-1440);
  // onboarding pre-existing definitions is offered alongside it (see below).
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
    !policyHasDeadRule(configureForm.addressingPolicy) &&
    !!pickState.serverId &&
    !!pickState.providerId &&
    remoteRunValid &&
    submitState === 'idle';

  // Remote configure gate: no agent in the remote dir yet — a valid remote
  // configure form + a chosen server + a provider. The server is not verified
  // here (the agent does not exist yet); it is verified after registration by
  // the create path (createRemoteLocation).
  const canSubmitConfigureRemote =
    isMissingRemoteAgent &&
    !isChecking &&
    remoteConfigureForm.isValid &&
    !policyHasDeadRule(remoteConfigureForm.addressingPolicy) &&
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

  /** Run the shared create-location path with the current pick state. Returns the
   * new/existing location id, or null when there is no chosen server. */
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
          autoApprove: remoteConfigureForm.autoApprove,
        }
      : {
          mode: 'pick',
          name: pickState.name,
          path: pickState.path,
          serverId: pickState.serverId,
          providerId: pickState.providerId,
          remote: undefined,
          autoApprove: configureForm.autoApprove,
        };
    // The new location mounts (leaving the always-shown "unregistered" state)
    // before agentsStore re-fetches its agent, which would drop it out of the
    // server-scoped sidebar. Seed the location→server mapping now so it stays
    // visible, and refresh the agent list once creation succeeds.
    agentsStore.noteLocationServer(id, pickState.serverId);
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

  const handleSubmit = async () => {
    if (!canSubmitDetected) return;
    setSubmitState('creating');
    setCloseGuard(true);
    try {
      const locationId = await startCreate();
      if (locationId) {
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

  /** Create a brand-new flat agent in the chosen directory (local or remote):
   * mint its identity, write its `.claude/agents/<name>.md` definition + its
   * per-agent credentials, and create the row — all via `addAgent`. */
  const createNewAgent = async (form: ReturnType<typeof useConfigureAgentForm>) => {
    if (!pickState.serverId || !pickState.providerId) return;
    setSubmitState('creating');
    setCloseGuard(true);
    try {
      const result = await getLocationManagerStore().addAgentAndOpen({
        sshHost: isRemoteRun ? runHost : null,
        dir: isRemoteRun ? trimmedRemoteDir : pickState.path,
        name: form.agentName,
        providerId: pickState.providerId,
        serverId: pickState.serverId,
        description: form.description.trim(),
        autoSession: form.autoSession,
        autoApprove: form.autoApprove,
        definitionAttributes: advancedAttributesRef.current,
      });
      if (result.kind !== 'created') {
        reportProvisionError(result);
        setCloseGuard(false);
        setSubmitState('idle');
        return;
      }
      if (form.addressingPolicy !== null && result.agent.switchAgentId) {
        await rpc.switchServers.updateAddressingPolicy({
          serverId: pickState.serverId,
          agentId: result.agent.switchAgentId,
          policy: form.addressingPolicy,
        });
      }
      void agentsStore.load();
      finishWith(result.agent.locationId);
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

  const handleConfigure = () => createNewAgent(configureForm);
  const handleConfigureRemote = () => createNewAgent(remoteConfigureForm);

  /** Onboard (or adopt) the agents already defined in the picked directory. */
  const handleOnboard = async () => {
    if (!pickState.serverId || !pickState.providerId || !hasOnboardable) return;
    setSubmitState('creating');
    setCloseGuard(true);
    try {
      const result = await rpc.agents.onboardLocationAgents({
        sshHost: discoverSshHost,
        dir: discoverDir,
        providerId: pickState.providerId,
        serverId: pickState.serverId,
      });
      if (!result.success) {
        reportCreationError(result.error);
        setCloseGuard(false);
        setSubmitState('idle');
        return;
      }
      await getLocationManagerStore().load();
      void agentsStore.load();
      finishWith(result.data[0].locationId);
    } catch (error) {
      log.error(error);
      setCloseGuard(false);
      setSubmitState('idle');
      toast({
        title: 'Failed to onboard agents',
        description: String(error),
        variant: 'destructive',
      });
    }
  };

  const canOnboard = hasOnboardable && !!pickState.serverId && submitState === 'idle';
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
          {switchAgent ? (
            <ConfirmButton
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmitDetected}
            >
              {submitLabel}
            </ConfirmButton>
          ) : (
            <>
              {hasOnboardable && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleOnboard()}
                  disabled={!canOnboard}
                >
                  {submitState === 'creating'
                    ? 'Onboarding...'
                    : `Onboard ${onboardableAgents.length} existing`}
                </Button>
              )}
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
              ) : hasOnboardable ? null : (
                <ConfirmButton
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmitDetected}
                >
                  {submitLabel}
                </ConfirmButton>
              )}
            </>
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
              {allowedHosts.map((host) => (
                <SelectItem key={host.sshHost} value={host.sshHost}>
                  {host.name} ({host.sshHost})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {runLocationConstrained && (
            <p className="text-xs text-foreground-muted">
              {targetServer?.managementKind === 'remote'
                ? `This server runs on ${targetServer.sshHost}, so its agents run on this computer or on ${targetServer.sshHost}.`
                : 'This server runs on this computer, so its agents run here too.'}
            </p>
          )}
          {isRemoteRun && (
            <div className="flex items-center gap-2">
              <Input
                value={remoteRepoDirDraft}
                placeholder="Remote working directory, e.g. /home/agent/repo"
                onChange={(e) => setRemoteRepoDirDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    setRemoteRepoDir(remoteRepoDirDraft.trim());
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setRemoteRepoDir(remoteRepoDirDraft.trim())}
                disabled={remoteRepoDirDraft.trim() === remoteRepoDir}
              >
                Set location
              </Button>
            </div>
          )}
        </Field>
        {!isRemoteRun && <PickExistingPanel state={pickState} showName={!isMissingSwitchAgent} />}
        {hasOnboardable && (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-background-1 px-3 py-2.5 text-sm">
            <span className="text-foreground-muted">
              {onboardableAgents.length} agent{onboardableAgents.length === 1 ? '' : 's'} defined in
              this directory {onboardableAgents.length === 1 ? "isn't" : "aren't"} in switchdash yet
              — onboard {onboardableAgents.length === 1 ? 'it' : 'them'}, or add a new one below:
            </span>
            <div className="flex flex-wrap gap-1.5">
              {onboardableAgents.map((a) => (
                <span
                  key={a.name}
                  className="rounded bg-background-2 px-1.5 py-0.5 font-mono text-xs text-foreground"
                >
                  {a.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {isMissingRemoteAgent && (
          <>
            <ConfigureAgentPanel
              form={remoteConfigureForm}
              serverId={pickState.serverId}
              onAddServer={() => showAddServerModal({})}
            />
            <AgentAdvancedConfig providerId={pickState.providerId} onChange={onAdvancedChange} />
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
          </>
        )}
        {isMissingSwitchAgent && (
          <>
            <ConfigureAgentPanel
              form={configureForm}
              serverId={pickState.serverId}
              onAddServer={() => showAddServerModal({})}
            />
            <AgentAdvancedConfig providerId={pickState.providerId} onChange={onAdvancedChange} />
          </>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
});
