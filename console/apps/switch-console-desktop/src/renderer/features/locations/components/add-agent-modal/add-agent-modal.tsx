import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
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
import { HostReachabilityNotice } from '@renderer/features/remote-hosts/host-reachability-notice';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import {
  HostReadinessNotice,
  useRemoteHostReadiness,
} from '@renderer/features/remote-hosts/host-readiness-notice';
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
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import { getProvider } from '@shared/core/providers/agent-provider-registry';
import {
  sameApiEndpoint,
  type ProvisionAgentResult,
} from '@shared/core/switch-servers/switch-servers';
import { basenameFromAnyPath } from '@shared/path-name';
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

// Switch Console adds a Switch *agent* by pointing at a local directory that the
// switch-connector `configure` skill has set up (its `.claude/settings.local.json`
// carries the SWITCH_* env block). The richer Switch Console flows — SSH, clone, create
// new GitHub repo — are out of scope for v0, so this modal is local + pick only.
export type AddLocationModalProps = BaseModalProps<void>;

/** Sentinel `runHost` value meaning "run on this machine" (no remote host). */
const LOCAL_RUN_LOCATION = 'local';

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
  const [verifyState, setVerifyState] = useState<ServerVerifyState>('idle');
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
      pickState.serverId,
    ],
    queryFn: () =>
      rpc.agents.discoverLocationAgents({
        sshHost: discoverSshHost,
        dir: discoverDir,
        providerId: pickState.providerId!,
        serverId: pickState.serverId!,
      }),
    enabled: !!pickState.providerId && !!pickState.serverId && discoverDir.trim().length > 0,
  });
  // Agents already configured in the directory, found by their provider-neutral
  // Switch credentials rather than by any provider's definition format. This is
  // what an agent someone else set up on a shared host looks like, and the only
  // way a provider with no definition concept (Codex) is visible at all
  // (CHOO-1937). The scan itself is provider-agnostic; it still waits on the type
  // picker because nothing below the directory is shown until a type is chosen, so
  // scanning earlier would be work (an SSH round trip, for a remote dir) whose
  // result cannot be displayed.
  const configuredQuery = useQuery({
    queryKey: [
      'discoverConfiguredAgents',
      discoverSshHost ?? 'local',
      discoverDir,
      pickState.serverId,
    ],
    queryFn: () =>
      rpc.agents.discoverConfiguredAgents({
        sshHost: discoverSshHost,
        dir: discoverDir,
        serverId: pickState.serverId!,
      }),
    enabled: !!pickState.providerId && !!pickState.serverId && discoverDir.trim().length > 0,
  });

  // Definitions that can join Switch and Switch Console hasn't already onboarded — the
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
  // An identity belongs to the server that issued it, so importing one into a
  // different server is not a thing that can happen: the onboard path would find
  // the id absent here, mint a replacement, and write it over the credentials the
  // other server's agent runs on. Say who it belongs to and leave it alone — the
  // way in is to create a new agent (CHOO-2044).
  const foreignCredentialReason = (endpoint: string | null): string | null => {
    if (endpoint === null || !targetServer) return null;
    if (sameApiEndpoint(endpoint, targetServer.apiUrl)) return null;
    // Name the server when this switchdash has it registered. The raw endpoint is
    // an implementation detail to the person reading the row, and for a server
    // they have registered it is one they already know by name.
    const owner = switchServersStore.servers.find((s) => sameApiEndpoint(s.apiUrl, endpoint));
    return `Already registered with ${owner ? owner.name : 'another Switch server'}, so it cannot be imported into ${targetServer.name}. Create a new agent instead.`;
  };

  const onboardableAgents: OnboardableAgent[] = [
    ...definitionAgents.map((a) => ({
      name: a.name,
      description: a.description,
      kind: (a.registered ? 'import' : 'adopt') as AdoptKind,
      providerLabel: null,
      blockedReason: foreignCredentialReason(a.credentialEndpoint),
    })),
    ...attachableAgents.map((a) => {
      const providerId = a.providerId ?? pickState.providerId ?? null;
      const providerLabel = providerId ? (getProvider(providerId)?.name ?? providerId) : null;
      return {
        name: a.name,
        description: null,
        kind: 'attach' as AdoptKind,
        providerLabel,
        blockedReason:
          providerLabel === null
            ? 'Pick an agent type above to attach this one — the directory does not say which runs it.'
            : null,
      };
    }),
  ];
  // Onboarding needs both halves of the question answered: which directory, and
  // which agent type the agents brought in will run under. With no type picked
  // there is nothing to offer — every row would be unactionable — so the list and
  // its button stay away and the modal asks for the type instead. Derived in one
  // place so the footer button and the list it submits cannot disagree.
  const hasOnboardable = !!pickState.providerId && onboardableAgents.length > 0;
  /** Rows that cannot be brought in — listed with their reason, never selectable. */
  const blockedNames = new Set(
    onboardableAgents.filter((a) => a.blockedReason !== null).map((a) => a.name)
  );
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
  // Default-select only what can actually be submitted: a blocked row (unknown
  // provider, or an identity belonging to another server) is disabled, and
  // pre-checking it would just block the button with no visible cause. Resolving
  // the block changes this key and folds the row into the selection.
  const onboardableKey = onboardableAgents
    .filter((a) => a.blockedReason === null)
    .map((a) => a.name)
    .join('|');
  useEffect(() => {
    setSelectedNames(new Set(onboardableKey ? onboardableKey.split('|') : []));
    setCreateMode(false);
  }, [onboardableKey]);
  const showCreate = !hasOnboardable || createMode;
  const toggleSelected = useCallback((name: string, checked: boolean) => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);

  const inspection = pathStatusQuery.data;
  // Discovery (`.claude/agents` scan) is a separate query from agent-detection;
  // fold its pending state into `isChecking` so the modal decides "onboard
  // existing vs create new" only once BOTH have settled — otherwise the create
  // form flashes up first and then flips to the onboard list when discovery lands
  // (CHOO-1440).
  const scanTargetChosen = !!pickState.serverId && discoverDir.trim().length > 0;
  const isDiscovering =
    (!!pickState.providerId && scanTargetChosen && discoverQuery.isPending) ||
    (scanTargetChosen && configuredQuery.isPending);
  const isChecking =
    (isRemoteRun
      ? shouldDetectRemote && remoteAgentQuery.isPending
      : shouldCheckPathStatus && pathStatusQuery.isPending) || isDiscovering;
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
  // Never create an agent on a host we know we cannot reach — it would be born
  // into the failing state this ticket exists to surface (CHOO-1676).
  const runHostReachable = !isRemoteRun || !hostReachabilityStore.isBlocked(runHost);

  // A reachable host that is missing git (or node, or the connector) will
  // produce an agent that cannot start. Refuse, rather than letting the failure
  // surface later as a mystery (CHOO-1809). An unchecked host is probed first
  // and only then judged — `checking` withholds the verdict, it is not one.
  const hostReadiness = useRemoteHostReadiness(
    isRemoteRun ? runHost : null,
    pickState.providerId ?? null
  );
  const runHostReady = !isRemoteRun || (!hostReadiness.blocked && !hostReadiness.checking);

  // Where the block stops the flow. A host missing its own prerequisites cannot
  // run anything, so nothing below the location picker is worth filling in —
  // the same rule reachability already follows. A host that is fine but lacks
  // one agent CLI blocks only the parts that commit to that type, so the type
  // picker stays live and you can pick one the host already has.
  const hostLevelBlocked = isRemoteRun && hostReadiness.blocked && hostReadiness.scope === 'host';
  const canChooseAgentType = runHostReachable && !hostLevelBlocked;
  const canConfigureAgent = canChooseAgentType && runHostReady;
  // The agent type is the next gate after the host, and it gates everything below
  // the directory: which agents in the directory can be brought in, and how a new
  // one is created, both depend on it. Filling in a name, a description and a
  // config for an agent that has no type yet is answering questions out of order —
  // the form cannot be submitted from there anyway (CHOO-2044).
  const canDetailAgent = canConfigureAgent && !!pickState.providerId;

  const canSubmitDetected = isRemoteRun
    ? !!pickState.providerId &&
      trimmedRemoteDir.length > 0 &&
      !isChecking &&
      !!switchAgent &&
      verifyState === 'found' &&
      runHostReachable &&
      runHostReady &&
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
    runHostReachable &&
    runHostReady &&
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
    runHostReachable &&
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
    // Blocked rows are disabled in the list, so a selected one means the list went
    // stale under the user. Dropping them here keeps a stale tick from reaching a
    // path that would refuse it — or worse, act on it.
    const submittable = [...selectedNames].filter((name) => !blockedNames.has(name));
    const attachSelected = submittable.flatMap((name) => {
      const providerId = attachByName.get(name);
      return providerId ? [{ name, providerId }] : [];
    });
    const onboardSelected = submittable.filter((name) => !attachByName.has(name));
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

  const submittableNames = [...selectedNames].filter((name) => !blockedNames.has(name));
  // A definition still needs the picked agent type to run under; an attach row
  // carries its own (inferred from disk, or the picked one as a fallback).
  const selectionNeedsProviderPick = submittableNames.some((name) => !attachByName.has(name));
  // Adopting agents that already exist in the directory still puts them on this
  // host, so it answers to the same gates as creating one. Omitting them here
  // let you onboard onto a host that was unreachable or missing prerequisites.
  const canOnboard =
    hasOnboardable &&
    submittableNames.length > 0 &&
    !!pickState.serverId &&
    (!selectionNeedsProviderPick || !!pickState.providerId) &&
    runHostReachable &&
    runHostReady &&
    submitState === 'idle';
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
          {/* The onboard list comes first, and deliberately outranks a detected
              legacy agent. The body renders the list whenever there is something
              to onboard, so a footer that branched on detection first put the
              wrong button under it: a directory carrying another server's
              `.claude/settings.local.json` showed the detected-agent button, which
              then verified that foreign agent against this server, failed, and
              stayed disabled forever — with the onboardable list visible above it
              and no way to submit it (CHOO-2044). */}
          {hasOnboardable && !createMode ? (
            <ConfirmButton
              type="button"
              onClick={() => void handleOnboard()}
              disabled={!canOnboard}
            >
              {submitState === 'creating' ? 'Adding...' : `Add ${submittableNames.length} selected`}
            </ConfirmButton>
          ) : switchAgent ? (
            <ConfirmButton
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmitDetected}
            >
              {submitLabel}
            </ConfirmButton>
          ) : isMissingRemoteAgent ? (
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
              fill in a form we may be about to refuse. */}
          {isRemoteRun && canChooseAgentType && !hostReadiness.checking && (
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
          <PickExistingPanel state={pickState} showName={canDetailAgent && !isMissingSwitchAgent} />
        )}
        {canDetailAgent && isChecking && (
          <p className="text-sm text-foreground-muted">Scanning directory for agents…</p>
        )}
        {/* A directory chosen with no agent type is a half-answered question, and
            nothing below can be acted on from there: the agents that could be
            brought in need a type to run under, and so does a new one. Ask for the
            type rather than showing a form and a list that cannot be submitted
            (CHOO-2044). */}
        {canConfigureAgent && !pickState.providerId && discoverDir.trim().length > 0 && (
          <p className="text-sm text-foreground-muted">Pick an agent type above to continue.</p>
        )}
        {canDetailAgent && hasOnboardable && !createMode && (
          <>
            <OnboardExistingPanel
              agents={onboardableAgents}
              selected={selectedNames}
              onToggle={toggleSelected}
            />
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => setCreateMode(true)}
            >
              Create a new agent instead
            </Button>
          </>
        )}
        {hasOnboardable && createMode && (
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
        {canDetailAgent && isMissingRemoteAgent && showCreate && (
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
        {canDetailAgent && switchAgent && (
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
            {/* The detected agent belongs to whichever server its on-disk config
                was written for, which need not be the one being added to. Saying
                so is the difference between an explained dead end and a button
                that is simply disabled for no stated reason (CHOO-2044). */}
            {verifyState === 'not-found' && (
              <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <span>
                  The agent configured in this directory is not registered on
                  {targetServer ? ` ${targetServer.name}` : ' the active server'} — it belongs to a
                  different Switch server. Onboard one of this directory&apos;s agents instead, or
                  switch to the server it belongs to.
                </span>
              </div>
            )}
            {verifyState === 'unauthenticated' && (
              <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <span>
                  You are not signed in to
                  {targetServer ? ` ${targetServer.name}` : ' the active server'}, so this agent
                  cannot be verified.
                </span>
              </div>
            )}
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
        {canDetailAgent && isMissingSwitchAgent && showCreate && (
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
