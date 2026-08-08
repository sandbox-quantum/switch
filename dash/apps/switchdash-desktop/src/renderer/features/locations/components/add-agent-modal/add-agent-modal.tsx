import type { RepoAgentAttributes } from '@switchdash/core/agents/plugins';
import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentOnboardingError } from '@renderer/features/locations/stores/agent-onboarding-types';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { HostReachabilityNotice } from '@renderer/features/remote-hosts/host-reachability-notice';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import {
  HostReadinessNotice,
  useRemoteHostReadiness,
} from '@renderer/features/remote-hosts/host-readiness-notice';
import { policyHasDeadRule } from '@renderer/features/switch-servers/addressing-policy-editor';
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
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import { getProvider } from '@shared/core/providers/agent-provider-registry';
import { isUsableRemoteDir } from '@shared/core/remote-hosts/remote-dir';
import { AgentAdvancedConfig } from './agent-advanced-config';
import { AgentTypePicker } from './agent-type-picker';
import { CodexAgentConfig } from './codex-agent-config';
import { ConfigureAgentPanel } from './configure-agent-panel';
import { PickExistingPanel } from './content';
import { useConfigureAgentForm, usePickMode } from './modes';
import {
  type AdoptKind,
  OnboardExistingPanel,
  type OnboardableAgent,
} from './onboard-existing-panel';
import { RemoteDirNotice } from './remote-dir-notice';

// switchdash adds a Switch *agent* by pointing at a working directory, local or
// on an SSH host: it mints the identity and writes it to
// `.switch/agents/<name>.json`, or adopts agents already configured there. The
// richer flows — clone, create new GitHub repo — remain out of scope.
export type AddLocationModalProps = BaseModalProps<void>;

/** Sentinel `runHost` value meaning "run on this machine" (no remote host). */
const LOCAL_RUN_LOCATION = 'local';

/** The recoverable outcomes of `addAgent` — everything the modal has to report
 * rather than treat as success. Derived from the RPC so a new variant in the
 * main process surfaces here as a type error rather than a silent no-op. */
type AddAgentFailure = Exclude<
  Awaited<ReturnType<typeof rpc.agents.addAgent>>,
  { kind: 'created' }
>;

/**
 * Whether `key` has been seen in a settled (non-pending) state at least once.
 *
 * Lets a gate distinguish "we know nothing yet" from "we are refreshing what we
 * already know", so a re-query does not retract what is already on screen.
 */
function useSettledOnce(key: string, pending: boolean): boolean {
  const settled = useRef(new Set<string>());
  if (!pending) settled.current.add(key);
  return settled.current.has(key);
}

/** Canonical working-directory path: trimmed, with trailing slashes removed
 * (except a bare root), so `/repo` and `/repo/` behave identically through
 * detection, discovery, and location keying — the flow must not care (CHOO-1440). */
function canonicalDir(dir: string): string {
  const trimmed = dir.trim();
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped || (trimmed.startsWith('/') ? '/' : '');
}

export const AddAgentModal = observer(function AddAgentModal({ onClose }: AddLocationModalProps) {
  const [submitState, setSubmitState] = useState<'idle' | 'creating'>('idle');
  const { navigate } = useNavigate();
  const { setCloseGuard } = useModalContext();
  const showAddServerModal = useShowModal('addServerModal');

  const pickState = usePickMode();
  const configureForm = useConfigureAgentForm(pickState.path, false, pickState.providerId);

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
  const remoteConfigureForm = useConfigureAgentForm(
    remoteRepoDir.trim(),
    true,
    pickState.providerId
  );
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

  // Everything chosen below the run location belongs to the machine it was
  // chosen on, so changing machines clears it.
  //
  // The working directory is the obvious case — a path from one host means
  // nothing on another. The agent type is the one that bit: availability is
  // per-machine, so picking Codex locally and then switching to a host without
  // Codex left Codex selected, and the form went on looking valid for a choice
  // the new machine cannot honour. Clearing it sends the picker back through
  // its own availability check for the host now selected.
  const { setProviderId } = pickState;
  useEffect(() => {
    setRemoteRepoDir('');
    setRemoteRepoDirDraft('');
    setProviderId(null);
  }, [runHost, setProviderId]);

  // Advanced definition attributes (model, effort, tools, system prompt, …) the
  // user set in the collapsed Advanced section. Held in a ref (not state) so the
  // section can report changes without re-rendering the modal.
  const advancedAttributesRef = useRef<RepoAgentAttributes>({});
  const onAdvancedChange = useCallback((attributes: RepoAgentAttributes) => {
    advancedAttributesRef.current = attributes;
  }, []);

  // Per-agent Codex config (model / effort / instructions), held in a ref for
  // the same reason. Null when the user left the Codex section untouched.
  const codexConfigRef = useRef<AgentProviderConfig | null>(null);
  const onCodexConfigChange = useCallback((config: AgentProviderConfig | null) => {
    codexConfigRef.current = config;
  }, []);

  const shouldCheckPathStatus = !isRemoteRun && pickState.path.trim().length > 0;
  const pathStatusQuery = useQuery({
    queryKey: ['locationPathStatus', 'local', pickState.path],
    queryFn: () => rpc.locations.inspectLocationPath({ path: pickState.path }),
    enabled: shouldCheckPathStatus,
  });

  const trimmedRemoteDir = remoteRepoDir.trim();
  const shouldDetectRemote = isRemoteRun && trimmedRemoteDir.length > 0;

  // Whether that directory exists at all. `detectRemoteAgent` cannot answer it:
  // it maps "not found" to "no agent configured here", so a missing directory
  // and an empty one are indistinguishable to it — which is how a typo used to
  // reach the create button and fail there (CHOO-1416).
  const remoteDirQuery = useQuery({
    queryKey: ['remoteDirInspect', runHost, trimmedRemoteDir],
    queryFn: () => rpc.remoteHosts.inspectRemoteDir({ sshHost: runHost, dir: trimmedRemoteDir }),
    enabled: shouldDetectRemote,
    retry: false,
  });
  // Only a verdict blocks. A probe still in flight, or one that failed, is not
  // evidence against the directory — treating it as such hid the whole form
  // while the check ran, and hid it for good if the check errored, including in
  // the case where a Switch agent had just been detected in that very directory
  // and so it demonstrably existed.
  const remoteDirBlocked =
    shouldDetectRemote &&
    remoteDirQuery.data !== undefined &&
    !isUsableRemoteDir(remoteDirQuery.data);

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
  // Agents already configured in the directory, found by their provider-neutral
  // Switch credentials rather than by any provider's definition format. This is
  // what an agent someone else set up on a shared host looks like, and the only
  // way a provider with no definition concept (Codex) is visible at all
  // (CHOO-1937). Provider-agnostic, so it does not wait on the type picker.
  const configuredQuery = useQuery({
    queryKey: ['discoverConfiguredAgents', discoverSshHost ?? 'local', discoverDir],
    queryFn: () =>
      rpc.agents.discoverConfiguredAgents({ sshHost: discoverSshHost, dir: discoverDir }),
    enabled: discoverDir.trim().length > 0,
  });

  // Definitions that can join Switch and switchdash hasn't already onboarded — the
  // ones worth offering. Already-onboarded ones (on THIS client) are excluded so
  // the modal never offers to re-add a row it already has; ones registered on the
  // gateway by another client are still offered (imported, not re-minted). CHOO-1440.
  const definitionAgents = (discoverQuery.data ?? []).filter((a) => a.eligible && !a.alreadyAgent);
  const definitionNames = new Set(definitionAgents.map((a) => a.name));
  // Credentials-only agents: those the definition scan does not already cover.
  // A definition WITH credentials is left to the onboard path, which reuses its
  // identity too — listing it twice would offer one agent as two rows.
  const attachableAgents = (configuredQuery.data ?? []).filter(
    (a) => !a.alreadyAgent && !definitionNames.has(a.name)
  );
  const onboardableAgents: OnboardableAgent[] = [
    ...definitionAgents.map((a) => ({
      name: a.name,
      description: a.description,
      kind: (a.registered ? 'import' : 'adopt') as AdoptKind,
      providerLabel: null,
    })),
    ...attachableAgents.map((a) => {
      const providerId = a.providerId ?? pickState.providerId ?? null;
      return {
        name: a.name,
        description: null,
        kind: 'attach' as AdoptKind,
        providerLabel: providerId ? (getProvider(providerId)?.name ?? providerId) : null,
      };
    }),
  ];
  const hasOnboardable = onboardableAgents.length > 0;
  /** Attachable rows keyed by name, with the provider resolved for submission. */
  const attachByName = new Map(
    attachableAgents.flatMap((a) => {
      const providerId = a.providerId ?? pickState.providerId ?? null;
      return providerId ? [[a.name, providerId] as const] : [];
    })
  );

  // Branch the flow when a directory has onboardable definitions: `createMode`
  // false shows the multi-select adopt list; true reveals the create form. When
  // there is nothing to onboard, the create form always shows. `selectedNames`
  // are the checked definitions to onboard (default: all).
  const [createMode, setCreateMode] = useState(false);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  // Default-select only what can actually be submitted: an attach row whose
  // provider is unknown is disabled until a type is picked, and pre-checking it
  // would just block the button with no visible cause. Picking a type unblocks
  // the row, which changes this key and folds it into the selection.
  const onboardableKey = onboardableAgents
    .filter((a) => !(a.kind === 'attach' && a.providerLabel === null))
    .map((a) => a.name)
    .join('|');
  useEffect(() => {
    setSelectedNames(new Set(onboardableKey ? onboardableKey.split('|') : []));
    setCreateMode(false);
  }, [onboardableKey]);
  const toggleSelected = useCallback((name: string, checked: boolean) => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);

  // Discovery (`.claude/agents` scan) is a separate query; fold its pending
  // state into `isChecking` so the modal decides "onboard existing vs create
  // new" only once both have settled — otherwise the create form flashes up
  // first and then flips to the onboard list when discovery lands (CHOO-1440).
  //
  // Only while a directory is being scanned for the FIRST time, though. The
  // definition scan is keyed on the agent type, so switching type starts a new
  // one, and blocking on that retracted everything below the working directory
  // and put a "Scanning directory…" line under it — which reads as the location
  // being re-checked, when the location has not changed at all.
  const discoveryPending =
    (!!pickState.providerId && discoverDir.trim().length > 0 && discoverQuery.isPending) ||
    (discoverDir.trim().length > 0 && configuredQuery.isPending);
  const scannedOnce = useSettledOnce(
    `${discoverSshHost ?? 'local'}:${discoverDir}`,
    discoveryPending
  );
  const isDiscovering = discoveryPending && !scannedOnce;
  const isChecking =
    (isRemoteRun ? false : shouldCheckPathStatus && pathStatusQuery.isPending) || isDiscovering;
  // Never create an agent on a host we know we cannot reach — it would be born
  // into the failing state that check exists to surface (CHOO-1676).
  const runHostReachable = !isRemoteRun || !hostReachabilityStore.isBlocked(runHost);
  // Anything already in the directory that can be taken on as-is rather than
  // created. The modal leads with adopting it and keeps `createMode` as the way
  // past it, because a directory is a flat container: an agent already there is
  // no reason to refuse another.
  const hasAdoptable = hasOnboardable;
  const showCreate = !hasAdoptable || createMode;
  // Creating an agent is offered for any directory we have finished inspecting.
  // A directory is a flat container, so an agent already living there is no
  // reason to refuse another — an existing one used to suppress the create flow
  // outright, which left a configured directory with nothing on offer but the
  // one agent already in it.
  const canCreateAgentHere =
    !isChecking && (isRemoteRun ? shouldDetectRemote : shouldCheckPathStatus);
  const canCreateLocalAgent = !isRemoteRun && canCreateAgentHere && showCreate;
  // The remote create flow registers the agent on the server and writes its
  // creds into the remote dir over SSH.
  const canCreateRemoteAgent = isRemoteRun && canCreateAgentHere && showCreate;

  // A reachable host that is missing git (or node, or the connector) will
  // produce an agent that cannot start. Refuse, rather than letting the failure
  // surface later as a mystery (CHOO-1809). An unchecked host is probed first
  // and only then judged — `checking` withholds the verdict, it is not one.
  const hostReadiness = useRemoteHostReadiness(
    isRemoteRun ? runHost : null,
    pickState.providerId ?? null
  );
  // Submitting waits for a verdict; showing the form only waits for a bad one.
  // Readiness is probed per agent type, so switching type starts a new probe —
  // and treating "checking" as a reason to hide made the whole form vanish and
  // come back on every type change.
  const runHostReady = !isRemoteRun || (!hostReadiness.blocked && !hostReadiness.checking);
  const runHostNotBlocked = !isRemoteRun || !hostReadiness.blocked;

  // Where the block stops the flow. A host missing its own prerequisites cannot
  // run anything, so nothing below the location picker is worth filling in —
  // the same rule reachability already follows. A host that is fine but lacks
  // one agent CLI blocks only the parts that commit to that type, so the type
  // picker stays live and you can pick one the host already has.
  const hostLevelBlocked = isRemoteRun && hostReadiness.blocked && hostReadiness.scope === 'host';
  const canChooseAgentType = runHostReachable && !hostLevelBlocked;
  // Everything that describes the agent itself — its name, config, the
  // definitions found alongside it — waits for the two things it is an agent
  // *of*: a chosen type, and a working directory that will exist to hold it.
  // Without both, those fields ask the user to describe something that cannot
  // be created, directly under a notice saying so (CHOO-1416).
  const canConfigureAgent =
    canChooseAgentType && runHostNotBlocked && !!pickState.providerId && !remoteDirBlocked;
  // The working directory is not a function of the agent type. Switching type
  // re-probes host readiness for the new type, and withdrawing the field
  // mid-probe made it look as though the location itself were being rechecked.
  // Hold it back only before anything has been committed, which is the case
  // `hostReadiness.checking` was gating in the first place.
  const canChooseLocation =
    canChooseAgentType && (!hostReadiness.checking || trimmedRemoteDir.length > 0);

  const canSubmitConfigure =
    canCreateLocalAgent &&
    !isChecking &&
    configureForm.isValid &&
    !policyHasDeadRule(configureForm.addressingPolicy) &&
    !!pickState.serverId &&
    !!pickState.providerId &&
    remoteRunValid &&
    runHostReachable &&
    !remoteDirBlocked &&
    runHostReady &&
    submitState === 'idle';

  // Remote configure gate: no agent in the remote dir yet — a valid remote
  // configure form + a chosen server + a provider. The server is not verified
  // here (the agent does not exist yet); it is verified after registration by
  // the create path (createRemoteLocation).
  const canSubmitConfigureRemote =
    canCreateRemoteAgent &&
    !isChecking &&
    remoteConfigureForm.isValid &&
    !policyHasDeadRule(remoteConfigureForm.addressingPolicy) &&
    !!pickState.serverId &&
    !!pickState.providerId &&
    trimmedRemoteDir.length > 0 &&
    runHostReachable &&
    !remoteDirBlocked &&
    runHostReady &&
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
  const reportProvisionError = (result: AddAgentFailure) => {
    // The UI gate normally catches this before submit; reaching it here means
    // the directory went away between the probe and the submit. Re-probe so the
    // notice reappears with whatever is true now.
    if (result.kind === 'directory-missing') {
      toast({
        title: 'Working directory not found',
        description: `${result.inspection.dir} does not exist on ${result.sshHost}. Create it on the host and try again.`,
        variant: 'destructive',
      });
      void remoteDirQuery.refetch();
      return;
    }
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
        providerConfig: codexConfigRef.current,
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

  /**
   * Bring in the selected agents. Definitions go through the onboard path
   * (importing a registered identity, minting one for a plain definition);
   * credentials-only agents go through the attach path, which adopts the
   * identity already on disk and writes nothing to the directory (CHOO-1937).
   */
  const handleOnboard = async () => {
    // `canOnboard` already requires a server; repeated so the calls below narrow.
    if (!canOnboard || !pickState.serverId) return;
    const attachSelected = [...selectedNames].flatMap((name) => {
      const providerId = attachByName.get(name);
      return providerId ? [{ name, providerId }] : [];
    });
    const onboardSelected = [...selectedNames].filter((name) => !attachByName.has(name));
    if (onboardSelected.length > 0 && !pickState.providerId) return;
    setSubmitState('creating');
    setCloseGuard(true);
    try {
      const locationIds: string[] = [];
      if (attachSelected.length > 0) {
        const attached = await rpc.agents.attachConfiguredAgents({
          sshHost: discoverSshHost,
          dir: discoverDir,
          serverId: pickState.serverId,
          agents: attachSelected,
        });
        if (!attached.success) {
          reportCreationError(attached.error);
          setCloseGuard(false);
          setSubmitState('idle');
          return;
        }
        locationIds.push(...attached.data.map((a) => a.locationId));
      }
      if (onboardSelected.length === 0) {
        await agentsStore.load();
        await getLocationManagerStore().reload();
        finishWith(locationIds[0]!);
        return;
      }
      const result = await rpc.agents.onboardLocationAgents({
        sshHost: discoverSshHost,
        dir: discoverDir,
        providerId: pickState.providerId!,
        serverId: pickState.serverId,
        names: onboardSelected,
      });
      if (!result.success) {
        reportCreationError(result.error);
        setCloseGuard(false);
        setSubmitState('idle');
        return;
      }
      // reload (not load) — the initial load is memoized, so a plain load() would
      // no-op and the onboarded location wouldn't mount until a restart (CHOO-1440).
      await agentsStore.load();
      await getLocationManagerStore().reload();
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

  // A definition still needs the picked agent type to run under; an attach row
  // carries its own (inferred from disk, or the picked one as a fallback).
  const selectionNeedsProviderPick = [...selectedNames].some((name) => !attachByName.has(name));
  // Adopting agents that already exist in the directory still puts them on this
  // host, so it answers to the same gates as creating one. Omitting them here
  // let you onboard onto a host that was unreachable or missing prerequisites.
  const canOnboard =
    hasOnboardable &&
    selectedNames.size > 0 &&
    !!pickState.serverId &&
    (!selectionNeedsProviderPick || !!pickState.providerId) &&
    runHostReachable &&
    runHostReady &&
    submitState === 'idle';

  return (
    <ModalLayout
      header={
        <DialogHeader showCloseButton={submitState === 'idle'}>
          <DialogTitle>Add Switch Agent</DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter>
          {hasOnboardable && !createMode ? (
            <ConfirmButton
              type="button"
              onClick={() => void handleOnboard()}
              disabled={!canOnboard}
            >
              {submitState === 'creating' ? 'Adding...' : `Add ${selectedNames.size} selected`}
            </ConfirmButton>
          ) : canCreateRemoteAgent ? (
            <ConfirmButton
              type="button"
              onClick={() => void handleConfigureRemote()}
              disabled={!canSubmitConfigureRemote}
            >
              {submitState === 'creating' ? 'Registering...' : 'Configure & Add Agent'}
            </ConfirmButton>
          ) : canCreateLocalAgent ? (
            <ConfirmButton
              type="button"
              onClick={() => void handleConfigure()}
              disabled={!canSubmitConfigure}
            >
              {submitState === 'creating' ? 'Registering...' : 'Configure & Add Agent'}
            </ConfirmButton>
          ) : null}
        </DialogFooter>
      }
    >
      <DialogContentArea data-autofocus tabIndex={-1} className="max-h-[calc(100dvh-13rem)] gap-4">
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
          {isRemoteRun && <HostReachabilityNotice sshHost={runHost} />}
          {isRemoteRun && runHostReachable && (
            <HostReadinessNotice
              sshHost={runHost}
              readiness={hostReadiness}
              onNavigateAway={onClose}
            />
          )}
          {/* Not while we are still finding out what the host has: asking for a
              working directory under a "checking…" spinner invites the user to
              fill in a form we may be about to refuse. Once a directory is set,
              it stays put — a later probe is about the agent type, not the path. */}
          {isRemoteRun && canChooseLocation && (
            <div className="flex items-center gap-2">
              <Input
                value={remoteRepoDirDraft}
                placeholder="Remote working directory, e.g. /home/agent/repo"
                onChange={(e) => setRemoteRepoDirDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    setRemoteRepoDir(canonicalDir(remoteRepoDirDraft));
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setRemoteRepoDir(canonicalDir(remoteRepoDirDraft))}
                disabled={canonicalDir(remoteRepoDirDraft) === remoteRepoDir}
              >
                Set location
              </Button>
            </div>
          )}
          {shouldDetectRemote && runHostReachable && (
            <RemoteDirNotice
              sshHost={runHost}
              inspection={remoteDirQuery.data}
              checking={remoteDirQuery.isFetching}
              error={remoteDirQuery.error}
            />
          )}
        </Field>
        {/* The host is the first gate: with it unreachable, or missing its own
            prerequisites, we cannot know which agent types it has, so offering a
            type picker (or a directory to scan) would be guessing. Everything
            below waits for a usable host — and everything past the picker waits
            for a type that host can actually run, rather than letting you fill
            in a name and a config only to be refused at the last button. */}
        {canChooseAgentType && (
          <AgentTypePicker
            value={pickState.providerId}
            onChange={pickState.setProviderId}
            sshHost={isRemoteRun ? runHost : undefined}
          />
        )}
        {canConfigureAgent && !isRemoteRun && (
          <PickExistingPanel state={pickState} showName={!canCreateLocalAgent} />
        )}
        {isChecking && (
          <p className="text-sm text-foreground-muted">Scanning directory for agents…</p>
        )}
        {canConfigureAgent && hasOnboardable && !createMode && (
          <OnboardExistingPanel
            agents={onboardableAgents}
            selected={selectedNames}
            onToggle={toggleSelected}
          />
        )}
        {/* Offered for a detected agent too, not just a discovered definition:
            either way something is already here, and adding another alongside it
            is allowed. */}
        {canConfigureAgent && hasAdoptable && !createMode && (
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => setCreateMode(true)}
          >
            Create a new agent instead
          </Button>
        )}
        {hasAdoptable && createMode && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setCreateMode(false)}
          >
            ← Back to existing agents
          </Button>
        )}
        {canConfigureAgent && canCreateRemoteAgent && (
          <>
            <ConfigureAgentPanel
              form={remoteConfigureForm}
              serverId={pickState.serverId}
              onAddServer={() => showAddServerModal({})}
            />
            <AgentAdvancedConfig providerId={pickState.providerId} onChange={onAdvancedChange} />
            {pickState.providerId === 'codex' && (
              <CodexAgentConfig onChange={onCodexConfigChange} />
            )}
          </>
        )}
        {canConfigureAgent && canCreateLocalAgent && (
          <>
            <ConfigureAgentPanel
              form={configureForm}
              serverId={pickState.serverId}
              onAddServer={() => showAddServerModal({})}
            />
            <AgentAdvancedConfig providerId={pickState.providerId} onChange={onAdvancedChange} />
            {pickState.providerId === 'codex' && (
              <CodexAgentConfig onChange={onCodexConfigChange} />
            )}
          </>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
});
