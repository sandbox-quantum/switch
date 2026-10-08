import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Monitor, Server } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { HostReachabilityNotice } from '@renderer/features/remote-hosts/host-reachability-notice';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import {
  HostReadinessNotice,
  useRemoteHostReadiness,
} from '@renderer/features/remote-hosts/host-readiness-notice';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { policyHasDeadRule } from '@renderer/features/switch-servers/addressing-policy-editor';
import { ManagedGitHubStep } from '@renderer/features/switch-servers/managed-github-step';
import { ManagedProviderConnectionStep } from '@renderer/features/switch-servers/managed-provider-connection-step';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { isSwitchCloudServer } from '@renderer/features/switch-servers/use-cloud-launches';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { ProviderConnectionStatus } from '@renderer/lib/components/provider-connection-status';
import { describeFailure, failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useModalContext, useShowModal } from '@renderer/lib/modal/modal-provider';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { log } from '@renderer/utils/logger';
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import {
  describeRemoteDirRefusal,
  isAbsoluteRemoteDir,
} from '@shared/core/remote-hosts/remote-dir';
import type { CloudRepositorySelection } from '@shared/core/switch-servers/cloud-launch';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import { AgentAdvancedConfig } from './agent-advanced-config';
import { AgentTypePicker } from './agent-type-picker';
import { CloudAgentRepository } from './cloud-agent-repository';
import { AgentIdentityFields, AgentSettingsSection } from './configure-agent-panel';
import { LaunchProfileConfig } from './launch-profile-config';
import { LocalDirectorySelector } from './local-directory-selector';
import { MachineProviderPicker } from './machine-provider-picker';
import { ManagedDirectoryField, useSuggestedManagedDirectory } from './managed-directory-field';
import { machineDisabledReason } from './managed-run-location';
import {
  CanManageAgentsField,
  ManagedAdvancedConfig,
  type ManagedDefinitionSettings,
  ManagedRunLocationNotice,
} from './managed-run-location-notice';
import { useConfigureAgentForm, usePickMode } from './modes';
import {
  machineFor,
  machineIdOf,
  machineLabel,
  machineRunLocation,
  machineRunLocations,
  sshHostIsMachine,
  thisComputerIsMachine,
} from './server-run-locations';

export type NewAgentFormProps = {
  onClose: () => void;
  onBack: (() => void) | null;
  entryPoint: UiEntryPoint;
  serverId: string | null;
  initialRunLocation: 'local' | 'cloud';
};

/** Sentinel `runHost` value meaning "run on this machine" (no remote host). */
const LOCAL_RUN_LOCATION = 'local';
const NO_ATTRIBUTES: RepoAgentAttributes = {};

/** Canonical working-directory path: trimmed, with trailing slashes removed
 * (except a bare root), so `/repo` and `/repo/` behave identically through
 * detection, discovery, and location keying — the flow must not care (CHOO-1440). */
function canonicalDir(dir: string): string {
  const trimmed = dir.trim();
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped || (trimmed.startsWith('/') ? '/' : '');
}

export const NewAgentForm = observer(function NewAgentForm({
  onClose,
  onBack,
  entryPoint,
  serverId,
  initialRunLocation,
}: NewAgentFormProps) {
  const queryClient = useQueryClient();
  const [connectingGitHub, setConnectingGitHub] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState(false);
  const [submitState, setSubmitState] = useState<'idle' | 'creating'>('idle');
  const [cloudRepository, setCloudRepository] = useState<CloudRepositorySelection | null>(null);
  const cloudRequestId = useRef(crypto.randomUUID());
  const { navigate } = useNavigate();
  const { setCloseGuard } = useModalContext();
  const showAddServerModal = useShowModal('addServerModal');

  const pickState = usePickMode();
  const form = useConfigureAgentForm();

  // Run location: 'local' (default) or an onboarded remote host's SSH alias. A
  // remote agent runs its sessions on the host and needs a remote working dir.
  const [runHost, setRunHost] = useState<string>(initialRunLocation);
  // Typed directly, with no commit step: it used to need one because committing
  // fired the directory scans, and there are none left to fire.
  const [remoteRepoDir, setRemoteRepoDir] = useState('');
  // A machine run's directory as the user edited it; null while it follows the name.
  const [editedMachineDir, setEditedMachineDir] = useState<string | null>(null);
  const { data: remoteHosts } = useQuery({
    queryKey: ['remote-hosts'],
    queryFn: () => rpc.remoteHosts.listHosts(),
  });
  const onboardedHosts = useMemo(() => remoteHosts ?? [], [remoteHosts]);
  const selectedServerId =
    serverId ??
    switchServersStore.activeServerId ??
    (switchServersStore.servers.length === 1 ? switchServersStore.servers[0].id : null);
  const selectedServer = switchServersStore.servers.find(
    (server) => server.id === selectedServerId
  );
  // Switch Cloud offers everything any server does, and running in the cloud besides.
  const cloudAvailable = !!selectedServer && isSwitchCloudServer(selectedServer);
  const isCloudRun = runHost === 'cloud';

  // On a server with agent management the server lists where agents can run:
  // every machine the user owns there. Null when it does not run management.
  const askForMachines =
    !!selectedServerId && !!workspacesStore.idOnServerInScope(selectedServerId);
  const machinesQuery = useQuery({
    queryKey: [MANAGED_AGENTS_KEY, selectedServerId, 'machines'],
    queryFn: () => rpc.managedAgents.machines(selectedServerId!),
    enabled: askForMachines,
    refetchInterval: (query) => (query.state.data ? 5000 : false),
  });
  const serverMachines = askForMachines ? (machinesQuery.data ?? null) : null;
  const management = serverMachines !== null;
  const machineId = isCloudRun ? null : machineIdOf(runHost);
  const isMachineRun = machineId !== null;
  const serverMachine = machineId
    ? (serverMachines?.find((candidate) => candidate.id === machineId) ?? null)
    : null;
  const isRemoteRun = runHost !== LOCAL_RUN_LOCATION && !isCloudRun && !isMachineRun;
  // The trigger has to say the host's name, not the value behind it: the value
  // for this machine is the sentinel "local", which is not what it is called.
  const runLocationLabel = isCloudRun
    ? 'Switch cloud'
    : isMachineRun
      ? serverMachine
        ? machineLabel(serverMachine)
        : 'Machine'
      : isRemoteRun
        ? (onboardedHosts.find((h) => h.sshHost === runHost)?.name ?? runHost)
        : 'This computer';

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
  const targetServerId = selectedServerId;
  const { serverId: pickedServerId, setServerId } = pickState;
  useEffect(() => {
    if (targetServerId && pickedServerId !== targetServerId) {
      setServerId(targetServerId);
    }
  }, [targetServerId, pickedServerId, setServerId]);

  // Names already taken on the server, so a clash is refused before anything
  // is created rather than reported by the server afterwards.
  const remoteAgents = useWorkspaceAgents(workspacesStore.idOnServerInScope(pickState.serverId));
  const takenNames = useMemo(
    () => new Set((remoteAgents.data ?? []).map((a) => a.name)),
    [remoteAgents.data]
  );
  const nameTaken = form.nameIsValid && takenNames.has(form.agentName);

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
    if (
      runHost !== LOCAL_RUN_LOCATION &&
      runHost !== 'cloud' &&
      machineIdOf(runHost) === null &&
      !allowedHosts.some((h) => h.sshHost === runHost)
    ) {
      setRunHost(LOCAL_RUN_LOCATION);
    }
  }, [allowedHosts, runHost]);

  // This computer or an SSH host that is a machine on the server is picked as
  // that machine; a machine the server no longer lists falls back to this computer.
  useEffect(() => {
    if (runHost === 'cloud') return;
    const id = machineIdOf(runHost);
    if (!serverMachines) {
      if (id !== null) setRunHost(LOCAL_RUN_LOCATION);
      return;
    }
    if (id !== null) {
      if (!serverMachines.some((candidate) => candidate.id === id)) setRunHost(LOCAL_RUN_LOCATION);
      return;
    }
    const enrolled = machineFor(runHost, serverMachines);
    if (enrolled) setRunHost(machineRunLocation(enrolled.id));
  }, [serverMachines, runHost]);

  // Everything chosen below the run location belongs to the machine it was
  // chosen on, so changing machines clears it.
  //
  // The working directory is the obvious case — a path from one host means
  // nothing on another. The agent type is the one that bit: availability is
  // per-machine, so picking Codex locally and then switching to a host without
  // Codex left Codex selected, and the form went on looking valid for a choice
  // the new machine cannot honour. Clearing it sends the picker back through
  // its own availability check for the host now selected.
  //
  // The name and description are not among them: they describe the agent, not
  // the machine, and clearing them threw away typed text on the way to a
  // second thought about where to run it.
  const { setProviderId } = pickState;
  useEffect(() => {
    setRemoteRepoDir('');
    setEditedMachineDir(null);
    setProviderId(isCloudRun ? 'claude' : null);
  }, [runHost, isCloudRun, setProviderId]);

  const { suggestAutoApprove } = form;
  const runsElsewhere =
    isRemoteRun || isCloudRun || (isMachineRun && serverMachine?.local?.kind !== 'this-computer');
  useEffect(() => {
    suggestAutoApprove(runsElsewhere);
  }, [runsElsewhere, suggestAutoApprove]);

  // Advanced definition attributes (model, effort, tools, system prompt, …) the
  // user set in the collapsed Advanced section. Held in a ref (not state) so the
  // section can report changes without re-rendering the modal.
  const advancedAttributesRef = useRef<RepoAgentAttributes>({});
  const onAdvancedChange = useCallback((attributes: RepoAgentAttributes) => {
    advancedAttributesRef.current = attributes;
  }, []);

  // Per-agent launch-profile config (model, and whatever else the provider
  // exposes), held in a ref for the same reason. Null when the user left the
  // section untouched, or when the provider has no launch profile at all.
  const launchProfileConfigRef = useRef<AgentProviderConfig | null>(null);
  const onLaunchProfileConfigChange = useCallback((config: AgentProviderConfig | null) => {
    launchProfileConfigRef.current = config;
  }, []);

  // On a server with agent management, every agent created on this computer or
  // an SSH host is a managed agent there: Switch places it on the machine's
  // controller. Without it, Console runs the agent, and the form says so.
  const workspaceId = workspacesStore.idOnServerInScope(pickState.serverId);
  const machineQuery = useQuery({
    queryKey: ['new-agent-machine', pickState.serverId, workspaceId, runHost],
    queryFn: () =>
      rpc.agentMigration.newAgentMachine({
        serverId: pickState.serverId!,
        workspaceId: workspaceId!,
        sshHost: isRemoteRun ? runHost : null,
      }),
    enabled: !isCloudRun && !isMachineRun && !!pickState.serverId && !!workspaceId,
    // While the machine cannot take one yet, so turning it on elsewhere shows here.
    refetchInterval: (query) =>
      query.state.data?.management && query.state.data.blocker ? 3000 : false,
  });
  const machine = isCloudRun || isMachineRun ? undefined : machineQuery.data;
  const managedRun = isMachineRun || machine?.management === true;
  const machineReason = isCloudRun
    ? null
    : askForMachines && machinesQuery.isPending
      ? 'Checking whether this server runs managed agents…'
      : askForMachines && machinesQuery.error
        ? failureText(machinesQuery.error, 'Your machines on this server could not be listed.')
        : isMachineRun
          ? serverMachine === null
            ? 'Choose a machine.'
            : serverMachine.state !== 'online'
              ? `${serverMachine.name} is offline. Start its controller, or choose another machine.`
              : null
          : (machineDisabledReason({
              checking: !!workspaceId && machineQuery.isPending,
              error: machineQuery.error,
              machine,
            }) ?? (managedRun ? `${runLocationLabel} is not a machine on this server yet.` : null));
  const { value: defaultAgent } = useAppSettingsKey('defaultAgent');
  const machineProviderReady =
    !isMachineRun ||
    (!!pickState.providerId &&
      !!serverMachine?.providers.some(
        (entry) => entry.provider === pickState.providerId && entry.ready
      ));
  const [canManageAgents, setCanManageAgents] = useState(false);
  // The managed agent's model and advanced configuration, held in a ref for the
  // same reason as the Console agent's attributes above.
  const managedSettingsRef = useRef<ManagedDefinitionSettings>({ model: null, advancedConfig: {} });
  const onManagedSettingsChange = useCallback((settings: ManagedDefinitionSettings) => {
    managedSettingsRef.current = settings;
  }, []);

  // An edit cleared back to empty runs the agent in the suggested place again.
  const suggestedMachineDir = useSuggestedManagedDirectory(
    pickState.serverId,
    serverMachine,
    form.agentName
  );
  const machineDir = editedMachineDir?.trim() ? editedMachineDir : (suggestedMachineDir.path ?? '');
  const trimmedRemoteDir = canonicalDir(isMachineRun ? machineDir : remoteRepoDir);
  const dir = isCloudRun ? '' : isRemoteRun || isMachineRun ? trimmedRemoteDir : pickState.path;

  // Never create an agent on a host we know we cannot reach — it would be born
  // into the failing state this ticket exists to surface (CHOO-1676).
  const runHostReachable = !isRemoteRun || !hostReachabilityStore.isBlocked(runHost);

  // A reachable host that is missing git (or node, or the agent CLI) will
  // produce an agent that cannot start. Refuse, rather than letting the failure
  // surface later as a mystery (CHOO-1809). An unchecked host is probed first
  // and only then judged — `checking` withholds the verdict, it is not one.
  const hostReadiness = useRemoteHostReadiness(
    isRemoteRun ? runHost : null,
    pickState.providerId ?? null
  );
  const runHostReady = !isRemoteRun || (!hostReadiness.blocked && !hostReadiness.checking);

  // Where the block stops the flow. A host missing its own prerequisites cannot
  // run anything, so nothing below the location picker is worth filling in.
  const hostLevelBlocked = isRemoteRun && hostReadiness.blocked && hostReadiness.scope === 'host';
  const canChooseAgentType = runHostReachable && !hostLevelBlocked;
  const canConfigureAgent = canChooseAgentType && runHostReady;

  // A relative remote dir would resolve against whatever directory the SSH
  // session starts in. Caught here so it greys the button out with a reason.
  // On a server machine the directory may be unknown: the machine makes a fresh workspace.
  const remoteDirIsAbsolute = isMachineRun
    ? trimmedRemoteDir === '' || isAbsoluteRemoteDir(trimmedRemoteDir)
    : !isRemoteRun || isAbsoluteRemoteDir(trimmedRemoteDir);

  const canSubmit =
    form.isValid &&
    !nameTaken &&
    !policyHasDeadRule(form.addressingPolicy) &&
    !!pickState.serverId &&
    !!pickState.providerId &&
    (isCloudRun ? cloudRepository !== null : isMachineRun || dir.trim().length > 0) &&
    remoteDirIsAbsolute &&
    machineProviderReady &&
    runHostReachable &&
    runHostReady &&
    machineReason === null &&
    submitState === 'idle' &&
    !connectingProvider &&
    !connectingGitHub;

  // Why "Add agent" is greyed out, in one line, shown on hover over the button.
  const disabledReason: string | null =
    submitState !== 'idle'
      ? null
      : isCloudRun && !cloudRepository
        ? 'Connect the provider and choose a GitHub repository.'
        : !pickState.serverId
          ? 'Add a Switch server to register this agent on.'
          : form.agentName.trim().length === 0
            ? 'Enter a name for the agent.'
            : !form.nameIsValid
              ? 'Fix the agent name: lowercase letters, digits, . - _, starting with a letter or digit.'
              : nameTaken
                ? `An agent called ${form.agentName} already exists on this server. Pick another name.`
                : form.description.trim().length === 0
                  ? 'Add a description so people and agents know what this agent is for.'
                  : !runHostReachable
                    ? `${runLocationLabel} can’t be reached right now — pick a run location that can.`
                    : hostReadiness.checking
                      ? `Checking what ${runLocationLabel} has installed…`
                      : hostReadiness.blocked
                        ? `${runLocationLabel} is missing setup this agent needs — the notice below has the details.`
                        : machineReason !== null
                          ? machineReason
                          : !pickState.providerId
                            ? 'Choose an agent type.'
                            : !machineProviderReady
                              ? `That provider is not installed and logged in on ${runLocationLabel}.`
                              : !isCloudRun && !isMachineRun && dir.trim().length === 0
                                ? isRemoteRun
                                  ? 'Enter the agent’s working directory on the host.'
                                  : 'Choose the agent’s working directory.'
                                : !remoteDirIsAbsolute
                                  ? `Give the full path on ${runLocationLabel}, starting with “/”.`
                                  : policyHasDeadRule(form.addressingPolicy)
                                    ? 'One addressing rule can never match — fix it under Settings.'
                                    : null;

  /** `agentName` is what picks the agent out of the location — a location can
   * hold several, so navigating on `locationId` alone opens the directory
   * rather than the agent that was just created. */
  const finishWith = (agent: { locationId: string; name: string }) => {
    setCloseGuard(false);
    setSubmitState('idle');
    onClose();
    navigate('location', { locationId: agent.locationId, agentName: agent.name });
  };

  /** Typed off the RPC, not `ProvisionAgentResult`: an `addAgent` result is the
   * only thing passed here, and the two unions do not have to agree. */
  const reportProvisionError = (result: Awaited<ReturnType<typeof rpc.agents.addAgent>>) => {
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
        description:
          'An agent with this name already exists in this directory or on the server. Pick another name.',
        variant: 'destructive',
      });
      return;
    }
    if (result.kind === 'credentials-conflict') {
      toast({
        title: 'That name belongs to another Switch server here',
        description: `This directory already holds credentials for an agent of that name on ${result.endpoint}. Overwriting them would destroy that agent's API token, so nothing was created — pick another name, or a different directory.`,
        variant: 'destructive',
      });
      return;
    }
    if (result.kind === 'directory-unusable') {
      toast({
        title: 'That working directory cannot be used. Nothing was created.',
        description: describeRemoteDirRefusal(result.inspection, runLocationLabel),
        variant: 'destructive',
      });
      return;
    }
    if (result.kind === 'already-configured') {
      toast({
        title: 'An agent with this name is already configured here',
        description:
          'This directory already holds credentials for an agent of that name. Load the existing agent instead of creating a new one.',
        variant: 'destructive',
      });
      return;
    }
    if (result.kind === 'invalid-name') {
      toast({
        title: 'Switch rejected these agent details',
        description: result.message,
        variant: 'destructive',
      });
      return;
    }
    if (result.kind === 'error') {
      toast({
        title: 'The agent could not be registered on the server. Nothing was created.',
        description: result.message,
        variant: 'destructive',
      });
    }
  };

  /** Create a brand-new flat agent in the chosen directory (local or remote):
   * mint its identity, write its config file + its per-agent credentials, and
   * create the row — all via `addAgent`. */
  const createNewAgent = async () => {
    if (!canSubmit || !pickState.serverId || !pickState.providerId) return;
    setSubmitState('creating');
    setCloseGuard(true);
    let registered = false;
    try {
      if (isCloudRun && cloudRepository) {
        await rpc.switchServers.createCloudLaunch(pickState.serverId, {
          provider: pickState.providerId ?? 'claude',
          request_id: cloudRequestId.current,
          name: form.agentName,
          description: form.description.trim(),
          display_name: form.displayName.trim() || null,
          icon_url: form.iconUrl,
          instructions: form.instructions,
          installation_id: cloudRepository.installationId,
          repository_id: cloudRepository.repositoryId,
          definition_attributes:
            pickState.providerId === 'claude' ? advancedAttributesRef.current : {},
          // Every agent starts a session when addressed; there is no setting for it.
          auto_session: true,
          auto_approve: form.autoApprove,
          addressing_policy: form.addressingPolicy,
        });
        void queryClient.invalidateQueries({ queryKey: ['cloud-agents'] });
        setCloseGuard(false);
        setSubmitState('idle');
        onClose();
        navigate('serverAgents', { serverId: pickState.serverId });
        toast({
          title: 'Cloud agent is starting',
          description: 'Its progress appears in Your Agents.',
        });
        return;
      }
      const identity = {
        name: form.agentName,
        providerId: pickState.providerId,
        serverId: pickState.serverId,
        description: form.description.trim(),
        displayName: form.displayName.trim() || null,
        instructions: form.instructions,
        iconUrl: form.iconUrl,
        autoApprove: form.autoApprove,
        entryPoint,
      };
      if (managedRun) {
        if (!serverMachine) throw new Error('No machine is chosen for the managed agent.');
        const created = await rpc.agentMigration.addManagedAgent({
          ...identity,
          machineId: serverMachine.id,
          dir: trimmedRemoteDir || null,
          model: managedSettingsRef.current.model,
          advancedConfig: managedSettingsRef.current.advancedConfig,
        });
        if (created.kind !== 'created') {
          reportProvisionError(created);
          setCloseGuard(false);
          setSubmitState('idle');
          return;
        }
        registered = true;
        if (form.addressingPolicy !== null) {
          await rpc.workspaces.updateAddressingPolicy({
            workspaceId: created.workspaceId,
            agentId: created.switchAgentId,
            policy: form.addressingPolicy,
          });
        }
        if (canManageAgents) {
          await rpc.workspaces.updateCanManageAgents({
            workspaceId: created.workspaceId,
            agentId: created.switchAgentId,
            enabled: true,
          });
        }
        await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
        setCloseGuard(false);
        setSubmitState('idle');
        onClose();
        navigate('managedAgent', {
          serverId: created.serverId,
          agentId: created.switchAgentId,
          name: form.displayName.trim() || form.agentName,
        });
        return;
      }
      const result = await getLocationManagerStore().addAgentAndOpen({
        ...identity,
        sshHost: isRemoteRun ? runHost : null,
        dir: isRemoteRun ? trimmedRemoteDir : pickState.path,
        definitionAttributes: advancedAttributesRef.current,
        providerConfig: launchProfileConfigRef.current,
      });
      if (result.kind !== 'created') {
        reportProvisionError(result);
        setCloseGuard(false);
        setSubmitState('idle');
        return;
      }
      registered = true;
      if (
        form.addressingPolicy !== null &&
        result.agent.switchAgentId &&
        result.agent.workspaceId
      ) {
        await rpc.workspaces.updateAddressingPolicy({
          workspaceId: result.agent.workspaceId,
          agentId: result.agent.switchAgentId,
          policy: form.addressingPolicy,
        });
      }
      await agentsStore.load();
      finishWith(result.agent);
    } catch (error) {
      log.error(error);
      setCloseGuard(false);
      setSubmitState('idle');
      if (isCloudRun) {
        try {
          const agents = await rpc.sdkHost.cloudAgents(pickState.serverId);
          const existing = (agents ?? [])
            .map((agent) => agent.launch)
            .find((launch) => launch.request_id === cloudRequestId.current);
          if (existing) {
            onClose();
            navigate('serverAgents', { serverId: pickState.serverId });
            toast({
              title: 'Cloud agent already created',
              description: `Check ${existing.name} in Your Agents for its current state.`,
            });
            return;
          }
        } catch (lookupError) {
          log.warn('Could not check the cloud creation request', lookupError);
        }
      }
      if (registered) {
        onClose();
        navigate('serverAgents', { serverId: pickState.serverId });
        toast({
          title: 'Agent created, but setup is incomplete',
          description:
            'Open the agent in Your Agents and check its addressing policy, and whether it can manage agents, before using it. Do not create it again.',
          variant: 'destructive',
        });
        return;
      }
      const { headline, detail } = describeFailure(
        error,
        isCloudRun
          ? 'Could not confirm cloud agent creation. Retry with the same details to check the request.'
          : 'Could not add the agent. Nothing was created — check the directory is reachable and writable, then try again.'
      );
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    }
  };

  const handleCreate = () => createNewAgent();

  const finishConnection = () => {
    void queryClient.invalidateQueries({
      queryKey: ['cloud-agent-connections', pickState.serverId],
    });
    void queryClient.invalidateQueries({ queryKey: ['cloud-agent-github', pickState.serverId] });
    setConnectingProvider(false);
    setConnectingGitHub(false);
  };

  return (
    <>
      {connectingProvider && pickState.serverId && (
        <ManagedProviderConnectionStep
          serverId={pickState.serverId}
          provider={pickState.providerId ?? 'claude'}
          continueLabel="Done"
          onBack={finishConnection}
          onDone={finishConnection}
        />
      )}
      {connectingGitHub && pickState.serverId && (
        <ManagedGitHubStep
          serverId={pickState.serverId}
          onBack={finishConnection}
          onSkip={finishConnection}
          onContinue={finishConnection}
        />
      )}
      <div hidden={connectingProvider || connectingGitHub}>
        <ModalLayout
          header={
            <DialogHeader showCloseButton={submitState === 'idle'}>
              <DialogTitle>New agent</DialogTitle>
              {targetServerId && (
                <button
                  type="button"
                  disabled={submitState !== 'idle'}
                  onClick={() => {
                    onClose();
                    navigate('templates', { serverId: targetServerId, kind: 'agent' });
                  }}
                  className="w-fit cursor-pointer text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground disabled:cursor-default disabled:opacity-50"
                >
                  Or start from a template
                </button>
              )}
            </DialogHeader>
          }
          footer={
            <DialogFooter>
              {isRemoteRun && hostReadiness.checking && (
                <span className="mr-auto self-center text-xs text-foreground-muted">
                  Waiting for {runLocationLabel}…
                </span>
              )}
              {onBack && (
                <Button variant="outline" onClick={onBack} disabled={submitState !== 'idle'}>
                  Back
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={submitState !== 'idle'}
              >
                Cancel
              </Button>
              <TooltipProvider delay={150}>
                <Tooltip>
                  {/* Span, not button, carries the tooltip: a disabled button emits no pointer events. */}
                  <TooltipTrigger
                    render={
                      <span className="inline-flex">
                        <ConfirmButton
                          type="button"
                          onClick={() => void handleCreate()}
                          disabled={!canSubmit}
                        >
                          {submitState === 'creating' ? 'Adding…' : 'Add agent'}
                        </ConfirmButton>
                      </span>
                    }
                  />
                  {disabledReason !== null && (
                    <TooltipContent side="top">{disabledReason}</TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            </DialogFooter>
          }
        >
          <DialogContentArea
            data-autofocus
            tabIndex={-1}
            className="max-h-[calc(100dvh-2rem-var(--modal-chrome,8.5rem))] gap-4"
          >
            <AgentIdentityFields form={form} serverId={pickState.serverId} />

            <Field>
              <FieldLabel>Run location</FieldLabel>
              {/* Icons and the right-hand kind, because the list mixes two sorts of
              thing: this machine, and hosts reached over SSH. The names alone
              do not say which is which. */}
              <Select value={runHost} onValueChange={(v) => setRunHost(v ?? LOCAL_RUN_LOCATION)}>
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {isCloudRun ? (
                      <Cloud className="size-4 text-foreground-muted" />
                    ) : isMachineRun ? (
                      serverMachine?.local?.kind === 'this-computer' ? (
                        <Monitor className="size-4 text-foreground-muted" />
                      ) : (
                        <Server className="size-4 text-foreground-muted" />
                      )
                    ) : isRemoteRun ? (
                      <Server className="size-4 text-foreground-muted" />
                    ) : (
                      <Monitor className="size-4 text-foreground-muted" />
                    )}
                    <span className="truncate">{runLocationLabel}</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {serverMachines &&
                    machineRunLocations(serverMachines).map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        disabled={option.disabled}
                      >
                        {option.icon === 'monitor' ? (
                          <Monitor className="size-4 text-foreground-muted" />
                        ) : (
                          <Server className="size-4 text-foreground-muted" />
                        )}
                        <span className="flex-1 truncate">{option.label}</span>
                        <span className="text-xs text-foreground-muted">{option.tag}</span>
                      </SelectItem>
                    ))}
                  {!(serverMachines && thisComputerIsMachine(serverMachines)) && (
                    <SelectItem value={LOCAL_RUN_LOCATION}>
                      <Monitor className="size-4 text-foreground-muted" />
                      <span className="flex-1">This computer</span>
                      <span className="text-xs text-foreground-muted">local</span>
                    </SelectItem>
                  )}
                  {cloudAvailable && (
                    <SelectItem value="cloud">
                      <Cloud className="size-4 text-foreground-muted" />
                      <span className="flex-1">Switch cloud</span>
                      <span className="text-xs text-foreground-muted">preview</span>
                    </SelectItem>
                  )}
                  {allowedHosts
                    .filter(
                      (host) => !(serverMachines && sshHostIsMachine(serverMachines, host.sshHost))
                    )
                    .map((host) => (
                      <SelectItem key={host.sshHost} value={host.sshHost}>
                        <Server className="size-4 text-foreground-muted" />
                        <span className="flex-1 truncate">{host.name}</span>
                        <span className="text-xs text-foreground-muted">ssh</span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {!isCloudRun && !management && runLocationConstrained && (
                <p className="text-xs text-foreground-muted">
                  {targetServer?.managementKind === 'remote'
                    ? `This server runs on ${targetServer.sshHost}, so its agents run on this computer or on ${targetServer.sshHost}.`
                    : 'This server runs on this computer, so its agents run here too.'}
                </p>
              )}
              {machine && pickState.serverId && workspaceId && (
                <ManagedRunLocationNotice
                  machine={machine}
                  label={runLocationLabel}
                  sshHost={isRemoteRun ? runHost : null}
                  serverId={pickState.serverId}
                  workspaceId={workspaceId}
                  onEnabled={() => {
                    void machineQuery.refetch();
                    void machinesQuery.refetch();
                  }}
                />
              )}
              {isMachineRun && serverMachine && (
                <p className="flex items-start gap-1.5 text-xs text-foreground-muted">
                  <Server className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {serverMachine.state === 'online'
                      ? `Runs as a managed agent on ${serverMachine.name}.`
                      : machineReason}
                  </span>
                </p>
              )}
              {!isCloudRun && (machineQuery.error || (askForMachines && machinesQuery.error)) && (
                <p className="text-xs text-destructive">{machineReason}</p>
              )}
              {isRemoteRun && <HostReachabilityNotice sshHost={runHost} />}
              {/* Not while it is still checking: the provider picker below is
              already saying so, and two spinners for one question read as two
              questions. Its verdict — the part only it can report — still
              lands here. */}
              {isRemoteRun && runHostReachable && !hostReadiness.checking && (
                <HostReadinessNotice
                  sshHost={runHost}
                  readiness={hostReadiness}
                  onNavigateAway={onClose}
                />
              )}
            </Field>

            {/* The host still gates what comes below it: with it unreachable, or
            missing its own prerequisites, we cannot know which providers it
            has, so offering the tiles would be guessing. What no longer gates
            anything is the directory — nothing is scanned in it, so it can be
            filled in while the host is still being surveyed. */}
            {canChooseAgentType && !isCloudRun && !isMachineRun && (
              <Field>
                <FieldLabel>Directory</FieldLabel>
                {isRemoteRun ? (
                  // No file picker for a host: the directory is on the other end of
                  // an SSH connection, so it is typed rather than browsed.
                  <Input
                    value={remoteRepoDir}
                    placeholder="/home/agent/repo"
                    onChange={(e) => setRemoteRepoDir(e.target.value)}
                  />
                ) : (
                  <LocalDirectorySelector
                    title="Choose the agent's working directory"
                    message="The agent runs its sessions here."
                    path={pickState.path}
                    onPathChange={pickState.handlePathChange}
                  />
                )}
              </Field>
            )}

            {isMachineRun && serverMachine && (
              <MachineProviderPicker
                machine={serverMachine}
                value={pickState.providerId}
                onChange={pickState.setProviderId}
                defaultAgent={defaultAgent}
              />
            )}

            {canChooseAgentType && !isCloudRun && !isMachineRun && (
              <AgentTypePicker
                value={pickState.providerId}
                onChange={pickState.setProviderId}
                sshHost={isRemoteRun ? runHost : undefined}
                onNavigateAway={onClose}
              />
            )}

            {/* No `dir`: signing in is a property of the machine, not of the folder
                an agent will run in — which is what the provider tiles above
                already assume. */}
            {canChooseAgentType && !isCloudRun && !isMachineRun && pickState.providerId && (
              <ProviderConnectionStatus
                providerId={pickState.providerId}
                sshHost={isRemoteRun ? runHost : null}
                dir=""
              />
            )}

            {isCloudRun && pickState.serverId && (
              <CloudAgentRepository
                serverId={pickState.serverId}
                providerId={pickState.providerId ?? 'claude'}
                onProviderChange={setProviderId}
                onSelection={setCloudRepository}
                onConnectProvider={() => setConnectingProvider(true)}
                onConnectGitHub={() => setConnectingGitHub(true)}
              />
            )}

            {canConfigureAgent && !!pickState.providerId && managedRun && pickState.serverId && (
              <ManagedAdvancedConfig
                serverId={pickState.serverId}
                providerId={pickState.providerId}
                host={
                  isMachineRun && !serverMachine?.local
                    ? {
                        kind: 'unavailable',
                        reason: `${runLocationLabel} is not this computer or one of its SSH hosts, so Console cannot ask it for its models. You can enter a model alias or ID.`,
                      }
                    : {
                        kind: 'host',
                        sshHost: isRemoteRun
                          ? runHost
                          : serverMachine?.local?.kind === 'ssh-host'
                            ? serverMachine.local.sshHost
                            : null,
                        // Not the suggested directory, which changes with every
                        // keystroke of the name and does not exist yet: the
                        // folder it will be made in answers the same.
                        dir:
                          isMachineRun && !editedMachineDir?.trim()
                            ? (serverMachine?.workspacesDir ?? '')
                            : dir,
                      }
                }
                onChange={onManagedSettingsChange}
              />
            )}

            {canConfigureAgent && !!pickState.providerId && !managedRun && (
              <>
                {(!isCloudRun || pickState.providerId === 'claude') && (
                  <AgentAdvancedConfig
                    serverId={pickState.serverId}
                    cloud={isCloudRun}
                    providerId={pickState.providerId}
                    sshHost={isRemoteRun ? runHost : null}
                    dir={dir}
                    initial={NO_ATTRIBUTES}
                    onChange={onAdvancedChange}
                  />
                )}
                {!isCloudRun && (
                  <LaunchProfileConfig
                    serverId={pickState.serverId}
                    providerId={pickState.providerId}
                    sshHost={isRemoteRun ? runHost : null}
                    dir={dir}
                    onChange={onLaunchProfileConfigChange}
                  />
                )}
              </>
            )}

            {/* Last, below Advanced configuration. Everything above it is a choice
            the agent cannot exist without; these have working defaults and are
            changeable afterwards from the agent's own settings. */}
            {canConfigureAgent && (
              <AgentSettingsSection
                form={form}
                workspaceId={workspacesStore.idOnServerInScope(pickState.serverId)}
                onAddServer={() => showAddServerModal({})}
                onOpenMessagingApps={() => {
                  onClose();
                  if (pickState.serverId) navigate('server', { serverId: pickState.serverId });
                }}
              >
                {isMachineRun && serverMachine && (
                  <ManagedDirectoryField
                    machine={serverMachine}
                    machineLabel={runLocationLabel}
                    value={editedMachineDir ?? suggestedMachineDir.path ?? ''}
                    suggested={suggestedMachineDir}
                    onChange={setEditedMachineDir}
                  />
                )}
                {managedRun && (
                  <CanManageAgentsField checked={canManageAgents} onChange={setCanManageAgents} />
                )}
              </AgentSettingsSection>
            )}
          </DialogContentArea>
        </ModalLayout>
      </div>
    </>
  );
});
