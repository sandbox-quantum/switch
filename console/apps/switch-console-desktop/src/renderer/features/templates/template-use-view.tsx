import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FormOptions,
  ParsedAgentEntry,
  TemplateConnection,
  TemplateKind,
  UnsaidRuntime,
} from '@main/core/agent-templates/template-document';
import type { AgentTemplateOrigin } from '@main/core/agents/agent-config-file';
import type { ParamSpec, ParsedTemplate } from '@main/core/room-templates/controller';
import type {
  ProvisionFromTemplateResult,
  TemplateRunResult,
} from '@main/core/switch-servers/gateway-client';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { machineLabel } from '@renderer/features/locations/components/add-agent-modal/server-run-locations';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { HostReachabilityNotice } from '@renderer/features/remote-hosts/host-reachability-notice';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import {
  HostReadinessNotice,
  useRemoteHostReadiness,
} from '@renderer/features/remote-hosts/host-readiness-notice';
import { blockedHandoffs } from '@renderer/features/room-templates/agent-handoff';
import {
  AgentListField,
  type EntityLists,
  UserListField,
} from '@renderer/features/room-templates/entity-fields';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useModalContext } from '@renderer/lib/modal/modal-provider';
import { useAgentTypeAvailability } from '@renderer/lib/stores/use-agent-type-availability';
import {
  useWorkspaceAgents,
  workspaceAgentsQueryKey,
} from '@renderer/lib/stores/use-workspace-agents';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Switch } from '@renderer/lib/ui/switch';
import { cn } from '@renderer/utils/utils';
import { AGENT_NAME_PATTERN, slugifyAgentNamePart } from '@shared/core/agents/agent-slug';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  type AgentProviderId,
  isValidProviderId,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';
import { describeRemoteDirRefusal } from '@shared/core/remote-hosts/remote-dir';
import { ownerAndMyAgentsPolicy, ownerOnlyPolicy } from '@shared/core/switch-servers/owner-policy';
import { NEW } from '@shared/core/switch-servers/room-template-params';
import { RpcError } from '@shared/lib/ipc/rpc-error';
import { CollapsibleInput } from './use/collapsible-input';
import {
  type AgentSlot,
  AgentSlotCard,
  newSlot,
  ResolvedDocument,
  RoomCard,
  type SlotStatus,
} from './use/creates-rail';
import { CreatingScreen } from './use/creating-screen';
import {
  connectionStates,
  connectionsFor,
  directoryUnresolved,
  machineFor,
  machineProblem,
  managedDirectory,
  runAgent,
  runtimeFieldTexts,
  shownDirectory,
} from './use/managed-run';
import { ParamField } from './use/param-field';
import { RoomChoiceField } from './use/room-pick-field';
import { LOCAL_RUN_LOCATION, runLocationLabel, useAllowedHosts } from './use/run-location-select';
import {
  agentCreateSteps,
  bridgeCandidates,
  type CreateStep,
  createStepStatus,
  defaultsFor,
  hasPlaceholder,
  holds,
  interpolate,
  isChain,
  isEmpty,
  missingParams,
  paramLabel,
  placeholdersIn,
  resolveChain,
  roomOnlyParams,
  serverInputs,
  unsaidMessage,
  type Values,
  valueProblem,
} from './use/use-template-model';

type Params = {
  serverId: string;
  /** A workspace template id or bundled template id to load. */
  templateId?: string;
  /** A document to use instead of a stored template: pasted, dropped, or a recent. */
  yamlText?: string;
  sourceName?: string;
  /** Add the created agent to this room instead of creating the template's room. */
  intoRoomId?: string;
};

function useViewParams(): Params {
  return useParams('templateUse').params as Params;
}

/** A template loaded for the Use page: its document, its origin, and everything parsed from it. */
type UsePageTemplate = {
  name: string;
  yamlText: string;
  instructions: string | null;
  origin: AgentTemplateOrigin | null;
  kind: TemplateKind;
  agents: ParsedAgentEntry[];
  /** True for the singular `agent:` form, whose room refers to the agent as `{agent}`. */
  singular: boolean;
  /** Every declared param, the Console types included. */
  params: ParamSpec[];
  /** The names of the params the server document keeps. */
  serverParamNames: Set<string>;
  form: FormOptions;
  parsed: ParsedTemplate | null;
  coreYaml: string | null;
  warnings: string[];
  /** The provider, location and directory the document never gives an agent. */
  unsaid: UnsaidRuntime[];
  /** 2 for a document of resources with a key and a type, whose run the server works out. */
  version: 1 | 2;
};

async function loadUsePageTemplate(workspaceId: string, params: Params): Promise<UsePageTemplate> {
  let name: string;
  let yamlText: string;
  // A document from the server has its instructions written in.
  const instructions: string | null = null;
  let origin: AgentTemplateOrigin | null = null;
  if (params.templateId) {
    const detail = await rpc.workspaces.getTemplateDetail({
      workspaceId,
      templateId: params.templateId,
    });
    name = detail.name;
    yamlText = detail.definition;
    const serverId = workspacesStore.serverIdFor(workspaceId);
    origin = {
      id: detail.id,
      name: detail.name,
      source: 'server',
      workspaceId,
      ...(serverId ? { serverId } : {}),
    };
  } else if (params.yamlText) {
    name = params.sourceName?.replace(/(\.template)?\.ya?ml$/i, '') ?? 'Pasted template';
    yamlText = params.yamlText;
  } else {
    throw new Error('Nothing to use: no template was given.');
  }
  const kind = await rpc.agentTemplates.kind({ yamlText });
  const { agents, singular, warnings, unsaid } = await rpc.agentTemplates.parseAgents({
    yamlText,
    instructions,
  });
  const v2 = await rpc.agentTemplates.version2Rooms({ yamlText });
  if (v2) {
    // The server works out a version 2 run from the document itself; the page
    // only reads what it shows: the params, the agents and the rooms.
    const v2Params = await rpc.roomTemplates.params({ yamlText });
    const first = v2.rooms[0] ?? null;
    return {
      name,
      yamlText,
      instructions,
      origin,
      kind,
      agents,
      singular: false,
      params: v2Params,
      serverParamNames: new Set(v2Params.map((p) => p.name)),
      form: await rpc.agentTemplates.form({ yamlText }),
      parsed: {
        params: v2Params,
        rooms: v2.rooms,
        groupName: v2.groupName,
        roomName: first?.name ?? null,
        roomDescription: first?.description ?? null,
        agents: [...new Set(v2.rooms.flatMap((r) => r.agents))],
        hardcodedAgents: [],
        hardcodedUsers: [],
        users: [...new Set(v2.rooms.flatMap((r) => r.users))],
        bridge: first?.bridge && !first.bridge.includes('{') ? first.bridge : null,
        kickoff: first?.kickoff ?? null,
        usesCreator: v2.usesCreator,
        warnings: [],
      },
      coreYaml: null,
      warnings,
      unsaid,
      version: 2,
    };
  }
  // Two versions of the room document: one that keeps every param, for
  // building the form, and one with only what the server understands.
  const forForm = await rpc.agentTemplates.serverDocument({ yamlText, keepConsoleParams: true });
  const coreYaml = await rpc.agentTemplates.serverDocument({ yamlText });
  // Without the schema the form is built from the Console's own parse and
  // the server validates on create, so an older server without the schema
  // endpoint still gets a working page.
  const schema = await rpc.workspaces.fetchTemplateSchema(workspaceId).catch(() => null);
  const parsed = forForm
    ? await rpc.roomTemplates.parse({ yamlText: forForm, schema: schema ?? undefined })
    : null;
  // A document without rooms can still declare params, used in agent names.
  const declaredParams = parsed?.params ?? (await rpc.roomTemplates.params({ yamlText }));
  const serverParams = coreYaml ? await rpc.roomTemplates.params({ yamlText: coreYaml }) : [];
  const form = await rpc.agentTemplates.form({ yamlText });
  return {
    name,
    yamlText,
    instructions,
    origin,
    kind,
    agents,
    singular,
    params: declaredParams,
    serverParamNames: new Set(serverParams.map((p) => p.name)),
    form,
    parsed,
    coreYaml,
    warnings: [...warnings, ...(parsed?.warnings ?? [])],
    unsaid,
    version: 1,
  };
}

const TemplateUseTitlebar = observer(function TemplateUseTitlebar() {
  const { serverId } = useViewParams();
  const { navigate } = useNavigate();
  return (
    <ServerSectionTitlebar
      serverId={serverId}
      icon={FileText}
      label="Templates"
      item={{ label: 'Use template' }}
      onSectionClick={() => navigate('templates', { serverId })}
    />
  );
});

/** A value the template fixed: shown so nothing is hidden, not editable. */
function FixedRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-dashed border-border px-3 py-2.5">
      <span className="w-[104px] shrink-0 truncate text-[12.5px] font-medium">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground-muted">
        {value}
      </span>
      <span className="shrink-0 text-[11px] text-foreground-passive">Set by the template</span>
    </div>
  );
}

/** Everything the page has worked out about one agent entry from the inputs. */
type SlotSetup = {
  /** The identifier the agent is created under. */
  name: string;
  /** Set when the deployer fills the entry with an existing agent, which the
   * template allows with `allow_existing`: its name, empty while none is picked. */
  existing: string | null;
  displayName: string | null;
  provider: AgentProviderId | null;
  /** `local`, or an SSH host. Null when nothing in the template says. */
  location: string | null;
  directory: string;
  /**
   * On a server with agent management, every new agent is a managed agent on
   * one of the deployer's machines: the one its `machine` names, or the one
   * behind its `location`. Null when it names none of them, or for an
   * existing agent, or without agent management.
   */
  machine: OwnedMachine | null;
  /** The `machine` the template gives it, filled in; null when it gives none. */
  machineText: string | null;
  /** The directory sent for a managed agent, `{$agents_dir}` kept for the server. */
  managedDirectory: string;
  /** The deployer's connections it is granted, its `repo` folded in. */
  connections: TemplateConnection[];
  /** Rooms the agent joins once it exists, by name. */
  joins: string[];
  /** Whether the run creates the template's room for it. */
  makesRoom: boolean;
  /** False for a version 2 agent whose `if:` does not hold: the run does not create it. */
  on: boolean;
};

const TemplateUsePanel = observer(function TemplateUsePanel() {
  const params = useViewParams();
  const { serverId, intoRoomId = null } = params;
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const { navigate } = useNavigate();
  const { showModal } = useModalContext();
  const queryClient = useQueryClient();
  const [loaded, setLoaded] = useState<UsePageTemplate | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [slots, setSlots] = useState<AgentSlot[]>([]);
  const [editedAgents, setEditedAgents] = useState<string[]>([]);
  const [editedUsers, setEditedUsers] = useState<string[]>([]);
  const [phase, setPhase] = useState<'form' | 'creating' | 'done' | 'failed'>('form');
  const [doneDetail, setDoneDetail] = useState<string | null>(null);
  // What the server returned for the room, kept so that a step failing after
  // it does not make Retry create the room a second time.
  const createdRoom = useRef<Awaited<
    ReturnType<typeof rpc.workspaces.createRoomFromTemplate>
  > | null>(null);
  const [roomStatus, setRoomStatus] = useState<SlotStatus>('idle');
  const [createError, setCreateError] = useState<string | null>(null);
  // Advanced inputs the deployer opened, by param name or row key.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  // For a template whose agent joins a `room` param: whether the deployer
  // wants a room at all, and whether they are choosing one right now.
  const [roomOn, setRoomOn] = useState(false);
  const [pickingRoom, setPickingRoom] = useState(false);
  const open = (key: string) => setOpened((prev) => new Set(prev).add(key));
  // Chains decided once their candidates are known, so a value the deployer
  // clears is not filled in again.
  const chainDecided = useRef(new Set<string>());
  // The directory agents are kept under, per location, for `{$agents_dir}`.
  const [agentsDirs, setAgentsDirs] = useState<Record<string, string>>({});

  // Reload only when a different document is requested. Reloading on every
  // render would reset the form.
  const { templateId, yamlText: givenYaml, sourceName } = params;
  useEffect(() => {
    // No workspace is an answer, not a wait. Returning with neither a template
    // nor an error leaves the page spinning forever, and Deploy reading
    // "Loading…" for something nobody is fetching.
    if (workspaceId === null) {
      setLoaded(null);
      setLoadError('This server has no workspace yet, so this template cannot be read.');
      return;
    }
    let cancelled = false;
    setLoaded(null);
    setLoadError(null);
    loadUsePageTemplate(workspaceId, { serverId, templateId, yamlText: givenYaml, sourceName })
      .then((result) => {
        if (cancelled) return;
        setLoaded(result);
        const formParams = result.params.filter((p) => !(result.singular && p.name === 'agent'));
        setValues(defaultsFor(formParams));
        chainDecided.current = new Set();
        createdRoom.current = null;
        setOpened(new Set());
        setRoomOn(false);
        setPickingRoom(false);
        nameStepped.current = false;
        setSlots(result.agents.map(newSlot));
        // The editable member list holds the room's fixed agents that the template
        // does not create. Agents it creates have their own cards.
        const slotNames = new Set(result.agents.map((a) => a.name ?? ''));
        setEditedAgents((result.parsed?.hardcodedAgents ?? []).filter((a) => !slotNames.has(a)));
        setEditedUsers(result.parsed?.hardcodedUsers ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(failureText(e, 'Could not load this template.'));
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, workspaceId, templateId, givenYaml, sourceName]);

  const parsed = loaded?.parsed ?? null;
  // In the singular `agent:` form the room refers to the agent as `{agent}`.
  // The page fills that in with the agent's name, so it is not an input.
  const isV2 = loaded?.version === 2;
  // A version 2 room is made only while its `if:` holds.
  const roomsOn = useMemo(
    () => (isV2 ? (parsed?.rooms ?? []).filter((r) => holds(r.condition, values)) : []),
    [isV2, parsed, values]
  );
  const templateParams = useMemo(() => {
    const base = (loaded?.params ?? []).filter((p) => !(loaded?.singular && p.name === 'agent'));
    if (!isV2 || !loaded) return base;
    // A version 2 param is asked while its `if:` holds, and while something
    // that is made reads it: one only an unmade room reads asks nothing.
    return base.filter((p) => {
      if (!holds(p.condition, values)) return false;
      const rooms = (parsed?.rooms ?? []).filter((r) => r.placeholders?.includes(p.name));
      const agents = loaded.agents.filter((a) => a.placeholders.includes(p.name));
      if (rooms.length + agents.length === 0) return true;
      return (
        rooms.some((r) => holds(r.condition, values)) ||
        agents.some((a) => holds(a.condition, values))
      );
    });
  }, [loaded, isV2, parsed, values]);
  const createsAgents = (loaded?.agents.length ?? 0) > 0;
  const hasRoomPart = isV2
    ? roomsOn.length > 0 && !intoRoomId
    : loaded?.coreYaml !== null && parsed !== null && !intoRoomId;
  const isGroupDoc = isV2
    ? roomsOn.length > 1 || (parsed?.groupName ?? null) !== null
    : (parsed?.rooms.length ?? 0) > 1 || (parsed?.groupName ?? null) !== null;
  const templateRoom = isV2 ? (roomsOn[0] ?? null) : (parsed?.rooms[0] ?? null);

  // The params only the room reads. They do nothing, and are not shown, when the room is not made.
  const roomText = loaded?.coreYaml ?? '';
  const roomOnly = useMemo(
    () => roomOnlyParams(templateParams, loaded?.agents ?? [], roomText),
    [templateParams, loaded, roomText]
  );
  // The agent entry a param is read by, for a control that depends on where
  // that agent runs. A Console-type param no entry reads applies to every
  // agent, and the first one stands for them.
  const agentIndexOf = useCallback(
    (param: ParamSpec) =>
      Math.max(
        0,
        (loaded?.agents ?? []).findIndex((a) => a.placeholders.includes(param.name))
      ),
    [loaded]
  );
  // The `room` param an agent joins, when the template leaves the room to the deployer.
  const joinParam =
    (!isV2 &&
      templateParams.find(
        (p) =>
          p.type === 'room' && (loaded?.agents ?? []).some((a) => a.join.includes(`{${p.name}}`))
      )) ||
    null;
  const joinValue = joinParam ? String(values[joinParam.name] ?? '') : '';
  // A chain that resolved to a room switches the room on.
  useEffect(() => {
    if (joinValue !== '' && !roomOn) setRoomOn(true);
  }, [joinValue, roomOn]);
  // A Console-type param no agent entry's field reads applies to every agent.
  const fieldTexts = (loaded?.agents ?? []).flatMap((a) => runtimeFieldTexts(a));
  const unboundOfType = (type: ParamSpec['type']) =>
    templateParams.find(
      (p) => p.type === type && !fieldTexts.some((t) => t.includes(`{${p.name}}`))
    ) ?? null;
  const providerParam = unboundOfType('provider');
  const locationParam = unboundOfType('location');
  const machineParam = unboundOfType('machine');
  const directoryParam = unboundOfType('directory');

  // ── Server lists (pickers, identities, bridges) ─────────────────────────
  const agents = useWorkspaceAgents(workspaceId);
  const roomsQuery = useQuery({
    queryKey: ['remote-rooms', workspaceId],
    queryFn: () => rpc.workspaces.listRooms(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const knownUsersQuery = useQuery({
    queryKey: ['remote-external-users', workspaceId],
    queryFn: () => rpc.workspaces.listExternalUsers(workspaceId as string),
    enabled: workspaceId !== null,
  });
  // The deployer's machines; null when the server does not run agent
  // management, which leaves agents to be created the way Console runs them.
  const machinesQuery = useQuery({
    queryKey: ['template-use-machines', serverId, workspaceId],
    queryFn: () => rpc.managedAgents.machines(serverId),
    enabled: workspaceId !== null && (loaded?.agents.length ?? 0) > 0,
    refetchInterval: (query) => (query.state.data ? 5000 : false),
  });
  const machines = machinesQuery.data ?? null;
  const management = machines !== null;
  const wantsConnections = (loaded?.agents ?? []).some(
    (a) => a.connections.length > 0 || a.repoUrl !== null
  );
  const connectionsQuery = useQuery({
    queryKey: ['template-use-connections', workspaceId],
    queryFn: () => rpc.workspaces.getServiceConnections(workspaceId as string),
    enabled: workspaceId !== null && management && wantsConnections,
  });
  const { identities, refresh: refreshIdentities } = useMyIdentities(workspaceId);
  const bridges = useMemo(() => bridgesQuery.data ?? [], [bridgesQuery.data]);
  const allowedHosts = useAllowedHosts(serverId);
  const hostLabel = useCallback(
    (sshHost: string) => allowedHosts.find((h) => h.sshHost === sshHost)?.name ?? sshHost,
    [allowedHosts]
  );

  // The messaging app the room is created on: the bridge param's value if
  // there is one, else the bridge named in the template, else the server's default.
  const templateBridge = useMemo(() => {
    const bridgeParam = templateParams.find((p) => p.type === 'bridge');
    const picked = bridgeParam ? String(values[bridgeParam.name] ?? '') : '';
    const named = picked !== '' ? picked : (parsed?.bridge ?? null);
    if (named) return bridges.find((b) => b.displayName === named) ?? null;
    return bridges.find((b) => b.isDefault) ?? null;
  }, [bridges, parsed, templateParams, values]);
  const creatorIdentity = useMemo(() => {
    if (identities === null) return null;
    if (templateBridge) {
      return identities.find((i) => i.bridgeId === templateBridge.id)?.externalUsername ?? null;
    }
    return identities[0]?.externalUsername ?? null;
  }, [identities, templateBridge]);
  // A linked account is needed only when the room is on a messaging app. On
  // a server without one, the server uses the deployer's gateway name.
  const creatorBlocked =
    parsed?.usesCreator === true &&
    templateBridge !== null &&
    identities !== null &&
    creatorIdentity === null;
  const linkAccount =
    templateBridge && workspaceId !== null
      ? () =>
          showModal('claimIdentityModal', {
            workspaceId,
            bridgeId: templateBridge.id,
            onSuccess: () => refreshIdentities(),
          })
      : null;
  const noMessagingApp = parsed !== null && bridgesQuery.data !== undefined && bridges.length === 0;

  const lists = useMemo(
    (): EntityLists => ({
      workspaceId,
      agents: agents.data ?? [],
      agentsLoading: agents.isLoading,
      rooms: roomsQuery.data ?? [],
      roomsLoading: roomsQuery.isLoading,
      bridges,
      identities,
      knownUsers: knownUsersQuery.data ?? [],
      bridgeId: templateBridge?.id ?? null,
    }),
    [
      workspaceId,
      agents.data,
      agents.isLoading,
      roomsQuery.data,
      roomsQuery.isLoading,
      bridges,
      identities,
      knownUsersQuery.data,
      templateBridge,
    ]
  );

  // ── The agents: what each is made of, from the inputs ───────────────────
  // A version 2 template names each agent by its key: `{expert.name}` is the
  // name the `expert` resource is created under.
  const namedValues = useMemo((): Values => {
    if (!isV2) return values;
    const named: Values = { ...values };
    for (const slot of slots) {
      const entry = slot.entry;
      if (!entry.key) continue;
      const existing = entry.allowExisting && slot.mode === 'existing' ? slot.existingName : null;
      named[`${entry.key}.name`] =
        existing ||
        (entry.name
          ? interpolate(entry.name, values)
          : slugifyAgentNamePart(interpolate(entry.displayName ?? '', values)));
    }
    return named;
  }, [isV2, values, slots]);
  const setups: SlotSetup[] = useMemo(() => {
    const vals = namedValues;
    const roomJoinParam = (entry: ParsedAgentEntry) =>
      templateParams.find((p) => p.type === 'room' && entry.join.includes(`{${p.name}}`)) ?? null;
    return slots.map((slot) => {
      const entry = slot.entry;
      const existing = entry.allowExisting && slot.mode === 'existing' ? slot.existingName : null;
      const name =
        existing ??
        (entry.name
          ? interpolate(entry.name, vals)
          : slugifyAgentNamePart(interpolate(entry.displayName ?? '', vals)));
      const displayName = entry.displayName ? interpolate(entry.displayName, vals) : null;
      // What runs it, where, and in which folder come from the template alone:
      // its own field, else a param of that type that applies to every agent.
      const providerText = entry.provider
        ? interpolate(entry.provider, vals)
        : providerParam
          ? String(vals[providerParam.name] ?? '')
          : '';
      const provider: AgentProviderId | null = isValidProviderId(providerText)
        ? providerText
        : null;
      const locationText = entry.location
        ? interpolate(entry.location, vals)
        : locationParam
          ? String(vals[locationParam.name] ?? '')
          : '';
      const location = locationText === '' || hasPlaceholder(locationText) ? null : locationText;
      const agentsDir = location !== null ? (agentsDirs[location] ?? '') : '';
      const dirValues: Values = { ...vals, agent: name, $agents_dir: agentsDir };
      // A directory read from a param is interpolated twice: once to reach
      // the param's value, once for the `{$agents_dir}` and `{agent}` inside it.
      const directoryText = entry.directory
        ? interpolate(interpolate(entry.directory, dirValues), dirValues)
        : directoryParam
          ? interpolate(String(vals[directoryParam.name] ?? ''), dirValues)
          : '';
      const directory = hasPlaceholder(directoryText) ? '' : directoryText;
      const joinParam = roomJoinParam(entry);
      const joins = entry.join
        .map((j) => interpolate(j, vals))
        .filter((j) => j !== '' && j !== NEW && !hasPlaceholder(j));
      const makesRoom = isV2
        ? hasRoomPart
        : hasRoomPart && (joinParam === null ? true : String(vals[joinParam.name] ?? '') === NEW);
      const machineRaw = entry.machine
        ? interpolate(entry.machine, vals)
        : machineParam
          ? String(vals[machineParam.name] ?? '')
          : '';
      const machineText = machineRaw === '' || hasPlaceholder(machineRaw) ? null : machineRaw;
      // On a server with agent management, where an agent runs is one of the
      // deployer's machines there. A `location` (this computer, an SSH host)
      // is this Console's idea, so it names a machine only when it is one;
      // otherwise the first online machine that can run the agent stands in.
      const machine =
        existing === null && machines !== null
          ? machineText !== null
            ? machineFor(machines, machineText, provider, false)
            : machineFor(machines, location, provider, location !== null)
          : null;
      const directorySource = entry.directory
        ? entry.directory
        : directoryParam
          ? String(vals[directoryParam.name] ?? '')
          : '';
      return {
        name,
        existing,
        displayName,
        provider,
        location,
        directory,
        machine,
        machineText,
        managedDirectory: managedDirectory(directorySource, vals, name),
        connections: connectionsFor(entry, vals),
        joins,
        makesRoom,
        on: !isV2 || holds(entry.condition, vals),
      };
    });
  }, [
    slots,
    namedValues,
    isV2,
    templateParams,
    providerParam,
    locationParam,
    machineParam,
    directoryParam,
    agentsDirs,
    hasRoomPart,
    machines,
  ]);
  // A room template with no agents still makes its room.
  const makesRoom = hasRoomPart && (setups.length === 0 || setups.some((s) => s.makesRoom));
  // The machines new agents run on.
  const locations = useMemo(
    () => [
      ...new Set(
        setups
          .filter((s) => s.existing === null && !management)
          .map((s) => s.location)
          .filter((l): l is string => l !== null)
      ),
    ],
    [setups, management]
  );
  const firstRemote = locations.find((l) => l !== LOCAL_RUN_LOCATION) ?? null;
  const hostReachable = locations.every(
    (l) => l === LOCAL_RUN_LOCATION || !hostReachabilityStore.isBlocked(l)
  );
  const hostReadiness = useRemoteHostReadiness(
    firstRemote,
    setups.find((s) => s.location === firstRemote)?.provider ?? null
  );
  const hostReady = firstRemote === null || (!hostReadiness.blocked && !hostReadiness.checking);

  // `{$agents_dir}` for every location in play, fetched once each.
  useEffect(() => {
    for (const location of locations) {
      if (management || agentsDirs[location] !== undefined) continue;
      const sshHost = location === LOCAL_RUN_LOCATION ? null : location;
      if (sshHost && hostReachabilityStore.isBlocked(sshHost)) continue;
      void rpc.agentTemplates
        .agentsDirectory({ sshHost })
        .then((dir) => setAgentsDirs((prev) => ({ ...prev, [location]: dir })))
        .catch(() => {});
    }
  }, [locations, agentsDirs, management]);

  // ── Chains: each decided once its candidates are known ──────────────────
  const availability = useAgentTypeAvailability(firstRemote ?? undefined);
  const localAvailability = useAgentTypeAvailability(undefined);
  useEffect(() => {
    if (!loaded) return;
    for (const param of templateParams) {
      if (!isChain(param) || chainDecided.current.has(param.name)) continue;
      let candidates: string[] | undefined;
      if (param.type === 'bridge') {
        candidates = bridgesQuery.data && bridgeCandidates(bridgesQuery.data);
      } else if (param.type === 'agent') {
        candidates = agents.data?.map((a) => a.name).sort();
      } else if (param.type === 'room') {
        candidates = roomsQuery.data?.map((r) => r.name).sort();
      } else if (param.type === 'location' && !management) {
        candidates = [LOCAL_RUN_LOCATION, ...allowedHosts.map((h) => h.sshHost)];
      } else if (param.type === 'machine' || param.type === 'location') {
        // Online machines first: `$first` is the first that can take an agent now.
        candidates = machinesQuery.data
          ? [...machinesQuery.data]
              .sort(
                (a, b) =>
                  Number(b.state === 'online') - Number(a.state === 'online') ||
                  a.name.localeCompare(b.name)
              )
              .map((m) => m.id)
          : machinesQuery.data === null
            ? []
            : undefined;
      } else if (param.type === 'provider') {
        // The providers installed where the agent reading this param runs.
        const at = setups[agentIndexOf(param)];
        const list =
          at && at.location !== null && at.location !== LOCAL_RUN_LOCATION
            ? availability.data
            : localAvailability.data;
        candidates = list
          ?.filter((a) => a.available && isValidProviderId(a.agentId))
          .map((a) => a.agentId);
      }
      if (candidates === undefined) continue; // the list is still loading
      chainDecided.current.add(param.name);
      const choice = resolveChain(param, candidates, hasRoomPart);
      if (choice === null) continue;
      setValues((prev) => (isEmpty(prev[param.name]) ? { ...prev, [param.name]: choice } : prev));
    }
  }, [
    loaded,
    templateParams,
    agentIndexOf,
    setups,
    hasRoomPart,
    bridgesQuery.data,
    agents.data,
    roomsQuery.data,
    allowedHosts,
    availability.data,
    localAvailability.data,
    machinesQuery.data,
    management,
  ]);

  // ── Names: taken, invalid, or still unresolved ──────────────────────────
  const takenNames = useMemo(() => new Set((agents.data ?? []).map((a) => a.name)), [agents.data]);
  // The param an agent entry takes its name from, when it takes it from one.
  const nameParamOf = useCallback(
    (entry: ParsedAgentEntry): ParamSpec | null => {
      const source = entry.name ?? entry.displayName ?? '';
      const key = placeholdersIn(source)[0];
      return key ? (templateParams.find((p) => p.name === key) ?? null) : null;
    },
    [templateParams]
  );
  // The template's default name steps to the first free one, "Switch expert
  // 2", before the deployer sees it, so a second agent from the same
  // template does not start out clashing. Decided once per load, and only
  // while the field still holds the template's default.
  const nameStepped = useRef(false);
  useEffect(() => {
    if (!loaded || !agents.data || nameStepped.current) return;
    nameStepped.current = true;
    const used = new Set(takenNames);
    const next: Values = {};
    for (const entry of loaded.agents) {
      const param = nameParamOf(entry);
      if (!param || typeof param.default !== 'string') continue;
      const current = String(values[param.name] ?? '');
      if (current !== param.default) continue;
      const identifierFor = (text: string) =>
        entry.name
          ? interpolate(entry.name, { ...values, [param.name]: text })
          : slugifyAgentNamePart(text);
      let candidate = param.default;
      for (let n = 2; used.has(identifierFor(candidate)); n++) candidate = `${param.default} ${n}`;
      used.add(identifierFor(candidate));
      if (candidate !== current) next[param.name] = candidate;
    }
    if (Object.keys(next).length > 0) setValues((prev) => ({ ...prev, ...next }));
  }, [loaded, agents.data, takenNames, nameParamOf, values]);

  // ── Why Create is disabled ──────────────────────────────────────────────
  // A room's own params matter only when the room is made.
  const liveParams = templateParams.filter((p) => makesRoom || !roomOnly.has(p.name));
  const missing = missingParams(liveParams, values);
  const invalid = liveParams
    .map((p) => ({ p, problem: valueProblem(p, values[p.name] ?? '') }))
    .filter((x) => x.problem !== null);
  const slotProblems: string[] = [];
  // A clash on a name the deployer can edit is shown in red under its field.
  const clashErrors: Record<string, string> = {};
  const seenNames = new Set<string>();
  slots.forEach((slot, i) => {
    const setup = setups[i];
    if (!setup.on) return;
    if (setup.existing !== null) {
      if (setup.existing === '')
        slotProblems.push(
          `Pick the existing agent for ${slot.entry.name ? interpolate(slot.entry.name, values) : `agent ${i + 1}`}.`
        );
      return;
    }
    const name = slot.createdName ?? setup.name;
    if (name === '') {
      slotProblems.push('Give the agent a name.');
      return;
    }
    if (hasPlaceholder(name)) {
      slotProblems.push(`Fill in ${placeholdersIn(name).join(', ')} to name the agent.`);
      return;
    }
    if (!AGENT_NAME_PATTERN.test(name)) {
      slotProblems.push(
        `${name} is not a valid agent name: lowercase letters, digits, . - _, starting with a letter or digit.`
      );
    } else if (slot.createdName === null && (takenNames.has(name) || seenNames.has(name))) {
      const message = `An agent called ${name} already exists on this server. Change the name.`;
      slotProblems.push(message);
      const param = nameParamOf(slot.entry);
      if (param) clashErrors[param.name] = message;
    }
    seenNames.add(name);
    // A setting the template never gives is the template's to fix, not the
    // deployer's: the form adds no input of its own for it.
    const unsaid = loaded?.unsaid.filter((u) => u.index === i) ?? [];
    for (const u of unsaid) slotProblems.push(unsaidMessage(u));
    const says = (field: UnsaidRuntime['field']) => !unsaid.some((u) => u.field === field);
    if (says('provider') && !setup.provider)
      slotProblems.push(`Choose which coding agent runs ${name}.`);
    if (management) {
      // A managed agent: the server checks all of this again, whole, before
      // creating anything; the form says it first.
      if (says('location') && setup.machine === null)
        slotProblems.push(
          setup.machineText !== null
            ? `${setup.machineText} is not one of your machines on this server.`
            : setup.location !== null
              ? `None of your machines on this server can run ${name} now. ${
                  (machines ?? [])
                    .map((m) => machineProblem(m, setup.provider, name) ?? '')
                    .join(' ') || 'You have no machine there yet.'
                }`
              : `Choose which machine ${name} runs on.`
        );
      else if (setup.machine !== null) {
        const problem = machineProblem(setup.machine, setup.provider, name);
        if (problem) slotProblems.push(problem);
      }
      if (
        says('directory') &&
        (setup.managedDirectory.trim() === '' || directoryUnresolved(setup.managedDirectory))
      )
        slotProblems.push(`Choose a directory for ${name}.`);
      for (const c of connectionStates(setup.connections, connectionsQuery.data ?? null)) {
        if (!c.ready && c.note) slotProblems.push(`${name}: ${c.note}`);
      }
    } else {
      if (setup.machineText !== null || slot.entry.connections.length > 0)
        slotProblems.push(
          `This server does not run agent management, so ${name} cannot be placed on a machine${slot.entry.connections.length > 0 ? ' or granted connections' : ''}.`
        );
      if (says('location') && setup.location === null)
        slotProblems.push(`Choose which machine ${name} runs on.`);
      else if (
        setup.location !== null &&
        setup.location !== LOCAL_RUN_LOCATION &&
        !allowedHosts.some((h) => h.sshHost === setup.location)
      )
        slotProblems.push(`${setup.location} is not a machine this Console can run agents on.`);
      if (says('directory') && setup.directory.trim() === '')
        slotProblems.push(`Choose a directory for ${name}.`);
    }
    for (const room of setup.joins) {
      if (roomsQuery.data && !roomsQuery.data.some((r) => r.name === room))
        slotProblems.push(`There is no room called ${room} on this server.`);
    }
  });
  if (joinParam && roomOn && joinValue === '')
    slotProblems.push('Pick the room, or switch it off.');
  const newSlots = slots.filter((_, i) => setups[i]?.existing === null && setups[i]?.on);
  const remoteLabel = firstRemote ? runLocationLabel(firstRemote, allowedHosts) : '';
  const blockedReason: string | null =
    phase !== 'form'
      ? null
      : loaded === null || workspaceId === null
        ? 'Loading…'
        : missing.length > 0
          ? `Fill in ${missing.map(paramLabel).join(', ')}`
          : invalid.length > 0
            ? `${paramLabel(invalid[0].p)}: ${invalid[0].problem}`
            : isV2 && newSlots.length > 0 && machinesQuery.data === null
              ? 'This template creates managed agents, and this server does not run agent management.'
              : newSlots.length > 0 && machinesQuery.isError
                ? failureText(
                    machinesQuery.error,
                    'Your machines on this server could not be listed.'
                  )
                : newSlots.length > 0 && machinesQuery.data === undefined
                  ? 'Checking your machines on this server…'
                  : slotProblems.length > 0
                    ? slotProblems[0]
                    : newSlots.length > 0 && !hostReachable
                      ? `${remoteLabel} cannot be reached right now.`
                      : newSlots.length > 0 && !hostReady
                        ? hostReadiness.checking
                          ? `Checking what ${remoteLabel} has installed…`
                          : `${remoteLabel} is missing setup the agents need.`
                        : !makesRoom
                          ? null // no room is made, so nothing below applies
                          : creatorBlocked
                            ? 'Link your messaging account first.'
                            : !isV2 && parsed !== null && noMessagingApp && parsed.usesCreator
                              ? 'This server has no messaging app, so the room would have no chat.'
                              : null;
  // Existing agents in the room whose addressing policy blocks messages from
  // another member. New agents get the template's addressing at creation.
  const handoffBlocked = useMemo(() => {
    if (!parsed) return [];
    const names = new Set<string>(editedAgents);
    for (const param of templateParams) {
      if (param.type === 'agent') {
        const v = values[param.name];
        if (typeof v === 'string' && v !== '') names.add(v);
      }
    }
    for (const setup of setups) if (setup.existing) names.add(setup.existing);
    return blockedHandoffs((agents.data ?? []).filter((a) => names.has(a.name)));
  }, [parsed, editedAgents, templateParams, values, setups, agents.data]);
  const [allowingHandoffs, setAllowingHandoffs] = useState(false);
  const allowHandoffs = useCallback(async () => {
    if (workspaceId === null) return;
    const byName = new Map((agents.data ?? []).map((a) => [a.name, a]));
    setAllowingHandoffs(true);
    try {
      for (const targetName of new Set(handoffBlocked.map((b) => b.to))) {
        const target = byName.get(targetName);
        if (!target) continue;
        const sources = handoffBlocked
          .filter((b) => b.to === targetName)
          .map((b) => byName.get(b.from))
          .filter((a): a is NonNullable<typeof a> => a !== undefined);
        const rules = (target.addressingPolicy?.rules ?? []).map((rule) => {
          const next = { ...rule };
          for (const source of sources) {
            if (target.ownerId !== null && source.ownerId === target.ownerId) {
              next.owner_agents = true;
            } else if (next.agents !== '*' && !next.agents.includes(source.id)) {
              next.agents = [...next.agents, source.id];
            }
          }
          return next;
        });
        await rpc.workspaces.updateAddressingPolicy({
          workspaceId,
          agentId: target.id,
          policy: { rules },
        });
      }
      await queryClient.invalidateQueries({ queryKey: workspaceAgentsQueryKey(workspaceId) });
    } catch (e) {
      toast({ title: failureText(e, 'Could not update the agents.'), variant: 'destructive' });
    } finally {
      setAllowingHandoffs(false);
    }
  }, [agents.data, handoffBlocked, workspaceId, queryClient]);

  // ── Create ──────────────────────────────────────────────────────────────
  const setSlot = (i: number, patch: Partial<AgentSlot>) =>
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  /** The room half as the server provisions it: agent names swapped for the
   * names the agents have, and the inputs it takes. */
  const roomRequest = async (
    templateCoreYaml: string,
    template: ParsedTemplate
  ): Promise<{ coreYaml: string; inputs: Record<string, string | number | boolean> }> => {
    const replacements: Record<string, string> = {};
    slots.forEach((slot, i) => {
      const expression = slot.entry.name ?? '';
      const actual = setups[i].existing ?? slot.createdName ?? setups[i].name;
      if (expression && actual && expression !== actual) replacements[expression] = actual;
    });
    let coreYaml = await rpc.agentTemplates.substituteSlots({
      coreYaml: templateCoreYaml,
      replacements,
    });
    if (!isGroupDoc) {
      // The member lists are rebuilt from the parsed template, so the renamed
      // agents must be renamed here too, or the original names would come back.
      const slotNamesSet = new Set(slots.map((s) => s.entry.name ?? ''));
      const keep = (list: string[]) =>
        list
          .filter((a) => hasPlaceholder(a) || slotNamesSet.has(a))
          .map((a) => replacements[a] ?? a);
      coreYaml = await rpc.roomTemplates.rewriteYaml({
        yamlText: coreYaml,
        agents: [...new Set([...keep(template.agents), ...editedAgents])],
        users: [...keep(template.users), ...editedUsers],
      });
    }
    const inputs = serverInputs(
      templateParams,
      values,
      loaded?.serverParamNames ?? new Set<string>()
    );
    if (loaded?.singular && slots.length === 1) {
      // The singular `agent:` form: the server fills `{agent}` from this input.
      inputs.agent = setups[0].existing ?? slots[0].createdName ?? setups[0].name;
    }
    return { coreYaml, inputs };
  };

  /**
   * On a server with agent management: the new agents and the room in one
   * request, which the server checks whole and keeps nothing of when it
   * fails. Records what was created, and the room in `createdRoom`, so the
   * steps after it (joins, opening the room) run as for any run. False when
   * it was refused, each reason shown on its agent's card.
   */
  /** The last run was refused whole, or undone: nothing it made is left, so there is nothing to retry from. */
  const [nothingKept, setNothingKept] = useState(false);
  // That refusal named each agent's reason, which its step shows.
  const [refusedPerAgent, setRefusedPerAgent] = useState(false);

  const createManaged = async (
    created: { slotIndex: number; name: string; switchAgentId: string | null }[]
  ): Promise<boolean> => {
    if (!loaded || workspaceId === null) return false;
    const pending = slots
      .map((slot, i) => ({ slot, i, setup: setups[i] }))
      .filter(({ slot, setup }) => setup.existing === null && slot.status !== 'created');
    const agentsToCreate = pending.map(({ slot, setup }) => {
      if (setup.machine === null || setup.provider === null)
        throw new Error(`${setup.name} has no machine or provider.`);
      return runAgent({
        slot: setup.name,
        name: setup.name,
        entry: slot.entry,
        values,
        displayName:
          setup.displayName && setup.displayName.trim() !== setup.name
            ? setup.displayName.trim()
            : null,
        provider: setup.provider,
        machine: setup.machine,
        directoryText: setup.managedDirectory,
      });
    });
    setNothingKept(false);
    setRefusedPerAgent(false);
    for (const { i } of pending) setSlot(i, { status: 'creating', error: null, step: 'create' });
    const room =
      makesRoom && loaded.coreYaml && parsed && !createdRoom.current
        ? await roomRequest(loaded.coreYaml, parsed)
        : null;
    if (room) setRoomStatus('creating');
    let result: TemplateRunResult;
    try {
      result = await rpc.workspaces.runTemplateWithAgents(workspaceId, {
        agents: agentsToCreate,
        yamlText: room?.coreYaml ?? null,
        inputs: room?.inputs ?? {},
        templateName: loaded.name,
      });
    } catch (e) {
      for (const { i } of pending) setSlot(i, { status: 'failed', step: null });
      if (room) setRoomStatus('failed');
      const serverDetail =
        e instanceof RpcError && e.code === 'GatewayError' ? e.stringField('detail') : undefined;
      setCreateError(serverDetail ?? failureText(e, 'Could not create from this template.'));
      setPhase('failed');
      return false;
    }
    if (result.kind === 'refused') {
      const bySlot = new Map<string, string[]>();
      for (const p of result.problems)
        bySlot.set(p.slot, [...(bySlot.get(p.slot) ?? []), p.message]);
      for (const { i, setup } of pending) {
        const mine = bySlot.get(setup.name);
        setSlot(i, {
          status: mine ? 'failed' : 'idle',
          step: mine ? 'create' : null,
          error: mine ? mine.join(' ') : null,
        });
      }
      // Refused before anything existed: the room was never tried. Undone
      // after the agents were made: the room is where it failed.
      if (room) setRoomStatus(result.problems.length > 0 ? 'idle' : 'failed');
      setNothingKept(true);
      setRefusedPerAgent(result.problems.length > 0 && result.leftBehind.length === 0);
      const leftBehind =
        result.leftBehind.length > 0
          ? ` ${result.leftBehind.join(', ')} could not be deleted again; delete ${result.leftBehind.length === 1 ? 'it' : 'them'} from Your Agents.`
          : '';
      setCreateError(
        (result.problems.length > 0
          ? 'Nothing was created. Each agent says what stopped it.'
          : result.message) + leftBehind
      );
      setPhase('failed');
      return false;
    }
    for (const agent of result.createdAgents) {
      const match = pending.find(({ setup }) => setup.name === agent.slot);
      if (!match) continue;
      setSlot(match.i, {
        status: 'created',
        step: null,
        createdName: agent.name,
        createdSwitchAgentId: agent.agentId,
      });
      created.push({ slotIndex: match.i, name: agent.name, switchAgentId: agent.agentId });
    }
    const deaf = result.createdAgents.filter((a) => !a.listening).map((a) => a.name);
    if (deaf.length > 0 && result.room)
      toast({
        title: `${deaf.join(', ')} may not have seen the first message`,
        description: `${deaf.length === 1 ? 'It was' : 'They were'} still starting when the room was made. Mention ${deaf.length === 1 ? 'it' : 'them'} in the room to start work.`,
        variant: 'destructive',
      });
    if (result.room) createdRoom.current = result.room;
    return true;
  };

  /** Say how the rooms came out, and open the first. */
  const showRoomResult = (result: ProvisionFromTemplateResult) => {
    if (result.kind === 'room') {
      if (result.failedAttachments.length > 0) {
        const kickoff = result.failedAttachments.find((f) => f.kind === 'kickoff');
        const others = result.failedAttachments.filter((f) => f.kind !== 'kickoff');
        toast({
          title: kickoff
            ? `"${result.roomName}" exists, but nobody has spoken in it yet`
            : `"${result.roomName}" was created with gaps`,
          description: [
            kickoff ? `The first message could not be posted: ${kickoff.error}` : null,
            others.length > 0
              ? `Could not add: ${others.map((f) => `${f.id} (${f.error})`).join(', ')}`
              : null,
          ]
            .filter(Boolean)
            .join(' '),
          variant: 'destructive',
        });
      }
      // Open the room. The kickoff and the agents' answers appear there, and the
      // agents' sessions appear in the sidebar.
      finish(`Opening ${result.roomName}…`, () => navigate('room', { roomId: result.roomId }));
    } else {
      const gaps = [
        ...result.errors.map((e) => e.error),
        ...result.rooms.flatMap((r) =>
          r.failedAttachments.map((f) => `${r.roomName}: ${f.id} (${f.error})`)
        ),
      ];
      if (gaps.length > 0) {
        toast({
          title: `"${result.groupName}" was created with gaps`,
          description: gaps.join('; '),
          variant: 'destructive',
        });
      } else {
        toast({
          title: `"${result.groupName}" is ready`,
          description: `${result.rooms.length} room${result.rooms.length === 1 ? '' : 's'} created.`,
        });
      }
      const first = result.rooms[0];
      finish(first ? `Opening ${first.roomName}…` : 'Opening Your Rooms…', () =>
        first ? navigate('room', { roomId: first.roomId }) : navigate('serverRooms', { serverId })
      );
    }
  };

  /**
   * A version 2 template: the whole run in one request, from the document and
   * the inputs. The server works out which agents and rooms the conditions
   * make, their machines and providers, and checks it whole; nothing is kept
   * when it refuses, and each reason shows on its agent.
   */
  const createFromDocument = async () => {
    if (!loaded || workspaceId === null) return;
    const pending = slots
      .map((slot, i) => ({ slot, i, setup: setups[i]! }))
      .filter(({ setup }) => setup.on && setup.existing === null);
    const filled = Object.fromEntries(
      slots.flatMap((slot, i) =>
        setups[i]?.on && setups[i]?.existing && slot.entry.key
          ? [[slot.entry.key, setups[i]!.existing!]]
          : []
      )
    );
    const inputs: Record<string, string | number | boolean> = {};
    for (const param of templateParams) {
      const value = values[param.name];
      if (isEmpty(value)) continue;
      inputs[param.name] = param.type === 'number' ? Number(value) : (value as string | boolean);
    }
    setNothingKept(false);
    setRefusedPerAgent(false);
    for (const { i } of pending) setSlot(i, { status: 'creating', error: null, step: 'create' });
    if (makesRoom) setRoomStatus('creating');
    let result: TemplateRunResult;
    try {
      const template = loaded.instructions
        ? await rpc.agentTemplates.compose({
            yamlText: loaded.yamlText,
            instructions: loaded.instructions,
          })
        : loaded.yamlText;
      result = await rpc.workspaces.runTemplateDocument(workspaceId, {
        template,
        inputs,
        filled,
        templateName: loaded.name,
      });
    } catch (e) {
      for (const { i } of pending) setSlot(i, { status: 'failed', step: null });
      if (makesRoom) setRoomStatus('failed');
      const serverDetail =
        e instanceof RpcError && e.code === 'GatewayError' ? e.stringField('detail') : undefined;
      setCreateError(serverDetail ?? failureText(e, 'Could not create from this template.'));
      setPhase('failed');
      return;
    }
    if (result.kind === 'refused') {
      const bySlot = new Map<string, string[]>();
      for (const p of result.problems)
        bySlot.set(p.slot, [...(bySlot.get(p.slot) ?? []), p.message]);
      const unmatched = result.problems.filter(
        (p) => !pending.some(({ setup }) => setup.name === p.slot)
      );
      for (const { i, setup } of pending) {
        const mine = bySlot.get(setup.name);
        setSlot(i, {
          status: mine ? 'failed' : 'idle',
          step: mine ? 'create' : null,
          error: mine ? mine.join(' ') : null,
        });
      }
      if (makesRoom) setRoomStatus(result.problems.length > 0 ? 'idle' : 'failed');
      setNothingKept(true);
      setRefusedPerAgent(
        result.problems.length > 0 && unmatched.length === 0 && result.leftBehind.length === 0
      );
      setCreateError(
        unmatched.length > 0 || result.problems.length === 0
          ? result.message
          : 'Nothing was created. Each agent says what stopped it.'
      );
      setPhase('failed');
      return;
    }
    for (const agent of result.createdAgents) {
      const match = pending.find(({ setup }) => setup.name === agent.name);
      if (match)
        setSlot(match.i, {
          status: 'created',
          step: null,
          createdName: agent.name,
          createdSwitchAgentId: agent.agentId,
        });
    }
    await agentsStore.load().catch(() => {});
    await queryClient
      .invalidateQueries({ queryKey: workspaceAgentsQueryKey(workspaceId) })
      .catch(() => {});
    const deaf = result.createdAgents.filter((a) => !a.listening).map((a) => a.name);
    if (deaf.length > 0 && result.room)
      toast({
        title: `${deaf.join(', ')} may not have seen the first message`,
        description: 'Mention it in the room to start work.',
        variant: 'destructive',
      });
    if (result.room) {
      setRoomStatus('created');
      await refreshSidebarRoomState(true).catch(() => {});
      showRoomResult(result.room);
      return;
    }
    finish('Opening Your Agents…', () => navigate('serverAgents', { serverId }));
  };

  const createAll = async () => {
    if (!loaded || workspaceId === null || blockedReason !== null) return;
    setPhase('creating');
    setCreateError(null);
    setFieldErrors({});
    const created: { slotIndex: number; name: string; switchAgentId: string | null }[] = [];

    if (isV2) {
      await createFromDocument();
      return;
    }
    if (management && newSlots.length > 0) {
      if (!(await createManaged(created))) return;
    }
    for (let i = 0; i < (management ? 0 : slots.length); i++) {
      const slot = slots[i];
      const setup = setups[i];
      if (setup.existing !== null || slot.status === 'created') continue;
      const name = slot.createdName ?? setup.name;
      const providerId = setup.provider;
      if (!providerId || setup.location === null) continue;
      const sshHost = setup.location === LOCAL_RUN_LOCATION ? null : setup.location;
      setSlot(i, { status: 'creating', error: null, step: 'prepare' });
      try {
        // An agent created on an earlier attempt is not created again; only its policy is set.
        let switchAgentId = slot.createdSwitchAgentId;
        if (!switchAgentId) {
          const prepared = await rpc.agentTemplates.prepareWorkspace({
            dir: setup.directory.trim(),
            repoUrl: slot.cloneRepo ? slot.entry.repoUrl : null,
            sshHost,
          });
          if (prepared.repo?.outcome === 'failed') {
            setSlot(i, {
              cloneWarning: `The repository could not be cloned (${prepared.repo.error ?? 'git clone failed'}). The agent clones it on its first run.`,
            });
            toast({
              title: `Could not fetch the repository for ${name}`,
              description: `${prepared.repo.error ?? 'git clone failed'}. The agent will try to clone it itself on its first run.`,
              variant: 'destructive',
            });
          }
          setSlot(i, { step: 'create' });
          const result = await rpc.agents.addAgent({
            sshHost,
            dir: setup.directory.trim(),
            name,
            providerId,
            serverId,
            description: slot.entry.description,
            displayName:
              setup.displayName && setup.displayName.trim() !== name
                ? setup.displayName.trim()
                : null,
            iconUrl: null,
            // Nobody sits at a host's terminal to approve tool calls.
            autoApprove: sshHost !== null,
            instructions: slot.entry.instructions,
            definitionAttributes: {},
            providerConfig: null,
            entryPoint: 'server_page',
            // Only a single-agent template can be loaded again for this
            // agent's instructions; a team template has no one entry to offer.
            templateOrigin: loaded.singular ? loaded.origin : null,
          });
          if (result.kind !== 'created') {
            setSlot(i, { status: 'failed', error: provisionErrorText(result, hostLabel) });
            setPhase('failed');
            return;
          }
          switchAgentId = result.agent.switchAgentId ?? null;
          // Record the created agent before setting its policy, so a retry after a
          // policy failure does not create a second agent.
          setSlot(i, { createdName: result.agent.name, createdSwitchAgentId: switchAgentId });
        }
        // A new agent answers only its owner by default. The template's `anyone`
        // must be written as the open policy; leaving the default would keep it closed.
        if (switchAgentId && slot.entry.addressing) {
          setSlot(i, { step: 'policy' });
          await rpc.workspaces.updateAddressingPolicy({
            workspaceId,
            agentId: switchAgentId,
            policy:
              slot.entry.addressing === 'owner-agents'
                ? ownerAndMyAgentsPolicy()
                : slot.entry.addressing === 'owner'
                  ? ownerOnlyPolicy()
                  : null,
          });
        }
        created.push({ slotIndex: i, name, switchAgentId });
        setSlot(i, { status: 'created' });
      } catch (e) {
        setSlot(i, { status: 'failed', error: failureText(e, 'Could not create the agent.') });
        setPhase('failed');
        return;
      }
    }
    if (created.length > 0) {
      // The agents exist whether or not the lists refresh, so a refresh that
      // fails must not fail the run.
      await agentsStore.load().catch(() => {});
      await queryClient
        .invalidateQueries({ queryKey: workspaceAgentsQueryKey(workspaceId) })
        .catch(() => {});
    }

    // Rooms the agents join: the one this page was opened from, and the ones
    // the template names for each agent.
    const byRoomName = new Map((roomsQuery.data ?? []).map((r) => [r.name, r.id]));
    const byAgentName = new Map((agents.data ?? []).map((a) => [a.name, a.id]));
    const joinsByRoom = new Map<string, string[]>();
    // Agents the server did not register cannot be put in a room; the run
    // stops and says so rather than opening the room without them.
    const missingJoin: string[] = [];
    slots.forEach((slot, i) => {
      const existing = setups[i].existing;
      const agentId =
        existing !== null
          ? (byAgentName.get(existing) ?? null)
          : (slot.createdSwitchAgentId ??
            created.find((c) => c.slotIndex === i)?.switchAgentId ??
            null);
      if (!agentId) {
        if (intoRoomId || setups[i].joins.length > 0)
          missingJoin.push(slot.createdName ?? setups[i].name);
        return;
      }
      const roomIds = [
        ...(intoRoomId ? [intoRoomId] : []),
        ...setups[i].joins.map((r) => byRoomName.get(r)).filter((id): id is string => !!id),
      ];
      for (const roomId of roomIds) {
        joinsByRoom.set(roomId, [...(joinsByRoom.get(roomId) ?? []), agentId]);
      }
    });
    if (missingJoin.length > 0) {
      setRoomStatus('failed');
      setCreateError(
        `${missingJoin.join(', ')} ${missingJoin.length === 1 ? 'was' : 'were'} created but the server has not registered ${missingJoin.length === 1 ? 'it' : 'them'} yet, so ${missingJoin.length === 1 ? 'it' : 'they'} could not be added to the room. Open the agent and add it to the room from there.`
      );
      setPhase('failed');
      return;
    }
    let joinedRoomId: string | null = null;
    if (joinsByRoom.size > 0) {
      setRoomStatus('creating');
      try {
        for (const [roomId, ids] of joinsByRoom) {
          await rpc.workspaces.addRoomAgents({
            workspaceId,
            roomId,
            agentIds: [...new Set(ids)],
            direction: 'agents_to_room',
          });
          joinedRoomId = roomId;
        }
        if (!makesRoom) setRoomStatus('created');
        await refreshSidebarRoomState(true).catch(() => {});
      } catch (e) {
        setRoomStatus('failed');
        setCreateError(
          failureText(e, 'The agents were created, but could not be added to the room.')
        );
        setPhase('failed');
        return;
      }
    }

    if (!makesRoom || !loaded.coreYaml || !parsed) {
      // No room to make. Every path out of here navigates, so a run that
      // created nothing new does not stay on the creating screen.
      if (joinedRoomId) {
        toast({
          title: 'In the room',
          description: 'Mention an agent there to start it. A message from you is what wakes it.',
        });
        const roomId = joinedRoomId;
        finish(`Opening ${switchRoomsStore.roomNameById(roomId) ?? 'the room'}…`, () =>
          navigate('room', { roomId })
        );
        return;
      }
      const firstName = created[0]?.name ?? slots.find((s) => s.createdName)?.createdName;
      const local = firstName
        ? agentsStore.agentsOnServer(serverId).find((a) => a.name === firstName)
        : undefined;
      finish(local ? `Opening ${local.name}…` : 'Opening Your Agents…', () =>
        local
          ? navigate('location', { locationId: local.locationId, agentName: local.name })
          : navigate('serverAgents', { serverId })
      );
      return;
    }

    // Then the rooms. Agent names in the document are replaced with the names
    // the agents got, so the server finds them.
    setRoomStatus('creating');
    try {
      const { coreYaml, inputs } = await roomRequest(loaded.coreYaml, parsed);
      const result =
        createdRoom.current ??
        (await rpc.workspaces.createRoomFromTemplate(workspaceId, coreYaml, inputs, loaded.name));
      createdRoom.current = result;
      setRoomStatus('created');
      // The room exists whether or not the sidebar refreshes.
      await refreshSidebarRoomState(true).catch(() => {});
      showRoomResult(result);
    } catch (e) {
      setRoomStatus('failed');
      const serverDetail =
        e instanceof RpcError && e.code === 'GatewayError' ? e.stringField('detail') : undefined;
      const message =
        serverDetail ?? failureText(e, 'Could not create the room from this template.');
      const paramMatch = message.match(/param(?:\(s\))?:?\s*['"]?(\w+)/i);
      if (paramMatch && templateParams.some((p) => p.name === paramMatch[1])) {
        setFieldErrors({ [paramMatch[1]]: message });
        open(paramMatch[1]);
      }
      setCreateError(
        created.length > 0
          ? `The agents were created, but the room could not be: ${message}`
          : message
      );
      setPhase('failed');
    }
  };

  // A short finished state before the page moves on, skipped for a deployer
  // who asked the system for less motion.
  const finish = (detail: string, go: () => void) => {
    setDoneDetail(detail);
    setPhase('done');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(go, still ? 0 : 900);
  };

  // Values for the preview cards: the inputs, `{agent}` for a single-agent
  // template, and every agent's final name.
  const railValues: Values =
    loaded?.singular && setups[0] ? { ...values, agent: setups[0].name || '{agent}' } : namedValues;
  const railRenames = useMemo(() => {
    const out: Record<string, string> = {};
    slots.forEach((slot, i) => {
      const expression = slot.entry.key ?? slot.entry.name ?? '';
      const actual = setups[i]?.existing ?? slot.createdName ?? setups[i]?.name;
      if (expression && actual && expression !== actual) out[expression] = actual;
    });
    return out;
  }, [slots, setups]);

  // ── Render ──────────────────────────────────────────────────────────────
  // A run refused whole kept nothing: the next Create is a fresh run, not a retry.
  const partlyDone =
    !nothingKept &&
    (slots.some((s) => s.status === 'created' || s.status === 'failed') || roomStatus === 'failed');
  const roomCount = makesRoom ? (parsed?.rooms.length ?? 0) : 0;
  const primaryLabel = partlyDone
    ? 'Retry remaining steps'
    : intoRoomId
      ? 'Create and add to room'
      : createsAgents && roomCount > 0
        ? slots.length === 1
          ? 'Create agent and room'
          : 'Create all'
        : createsAgents
          ? slots.length === 1
            ? 'Create agent'
            : 'Create agents'
          : roomCount > 1
            ? 'Create rooms'
            : 'Create room';
  const intoRoomName = intoRoomId ? switchRoomsStore.roomNameById(intoRoomId) : null;

  const cancel = () =>
    intoRoomId
      ? navigate('room', { roomId: intoRoomId })
      : params.templateId
        ? navigate('templateDetail', { serverId, templateId: params.templateId })
        : params.yamlText
          ? navigate('templateImport', {
              serverId,
              yamlText: params.yamlText,
              sourceName: params.sourceName,
              edit: true,
            })
          : navigate('templates', { serverId });
  const showAgentLists =
    parsed !== null &&
    !isGroupDoc &&
    (parsed.hardcodedAgents.length > 0 || editedAgents.length > 0);
  const showUserLists =
    parsed !== null && !isGroupDoc && (parsed.hardcodedUsers.length > 0 || editedUsers.length > 0);

  // The rows of the creating screen: one per call the run makes.
  const createSteps: CreateStep[] = slots.flatMap((slot, i) =>
    setups[i]?.existing === null && setups[i]?.on
      ? agentCreateSteps(i, {
          name: slot.createdName ?? setups[i]?.name ?? 'the agent',
          status: slot.status,
          step: slot.step,
          clones: slot.cloneRepo && !!slot.entry.repoUrl,
          setsPolicy: !!slot.entry.addressing,
          cloneWarning: slot.cloneWarning,
          managed: management ? { machine: setups[i]?.machine?.name ?? null } : null,
          error: slot.error,
        })
      : []
  );
  const joinNames = [
    ...(intoRoomName ? [intoRoomName] : []),
    ...new Set(setups.flatMap((s) => s.joins)),
  ];
  if (joinNames.length > 0) {
    createSteps.push({
      key: 'join',
      label: `Add to ${joinNames.join(', ')}`,
      status: makesRoom && roomStatus === 'created' ? 'done' : createStepStatus(roomStatus),
    });
  }
  if (makesRoom && parsed) {
    const count = parsed.rooms.length;
    const hasKickoff = parsed.kickoff !== null || parsed.rooms.some((r) => r.kickoff);
    createSteps.push({
      key: 'room',
      label:
        (count > 1 ? `Create ${count} rooms` : 'Create the room') +
        (hasKickoff ? (count > 1 ? ' and post their kickoffs' : ' and post the kickoff') : ''),
      status: createStepStatus(roomStatus),
    });
  }
  const runError =
    createError ?? slots.find((s) => s.status === 'failed')?.error ?? Object.values(fieldErrors)[0];

  const busy = phase === 'creating';
  const newRoomForPick =
    hasRoomPart && templateRoom
      ? {
          name: interpolate(templateRoom.name ?? 'New room', railValues),
          bridgeType: templateBridge?.type ?? null,
        }
      : null;

  /** The SSH host of the agent a param is read by, for a control that depends on that machine. */
  const sshHostOf = (param: ParamSpec): string | null => {
    const location = setups[agentIndexOf(param)]?.location ?? null;
    return location === null || location === LOCAL_RUN_LOCATION ? null : location;
  };

  /** The directory a directory param resolves to for the agent reading it. */
  const directoryShownFor = (param: ParamSpec): string => {
    const setup = setups[agentIndexOf(param)];
    if (!setup) return '';
    return management && setup.managedDirectory
      ? shownDirectory(setup.managedDirectory, setup.machine)
      : setup.directory;
  };

  /** How a value reads on one line, folded. */
  const summaryOf = (param: ParamSpec, value: string | number | boolean): string => {
    const resolvedDirectory = param.type === 'directory' ? directoryShownFor(param) : '';
    return param.type === 'provider'
      ? (providerDisplayName(String(value)) ?? String(value))
      : param.type === 'location' && !management
        ? value === ''
          ? ''
          : runLocationLabel(String(value), allowedHosts)
        : param.type === 'machine' || param.type === 'location'
          ? (() => {
              const m = machines?.find((c) => c.id === value || c.name === value);
              return m ? machineLabel(m) : String(value);
            })()
          : param.type === 'room' && value === NEW
            ? (newRoomForPick?.name ?? 'New room')
            : param.type === 'directory'
              ? (resolvedDirectory || String(value)).replace(/^\/(?:Users|home)\/[^/]+/, '~')
              : String(value);
  };

  /** One param as the template says to show it: asked, folded, or fixed.
   * Inside the Advanced fold an `advanced` param is a plain field: the fold does the folding. */
  const paramRow = (param: ParamSpec, inFold = false) => {
    const value = values[param.name] ?? '';
    const error = fieldErrors[param.name] ?? clashErrors[param.name] ?? valueProblem(param, value);
    const summary = summaryOf(param, value);
    if (param.input === 'fixed') {
      return <FixedRow key={param.name} label={paramLabel(param)} value={summary} />;
    }
    // A directory param's value can read `{$agents_dir}` and `{agent}`; the
    // control shows the path they resolve to, and an edit writes a literal.
    // A managed agent's keeps `{$agents_dir}`, the machine's own folder, so an
    // edit still writes something the server can resolve.
    const resolvedDirectory =
      param.type === 'directory'
        ? management
          ? setups[agentIndexOf(param)]?.managedDirectory || null
          : setups[agentIndexOf(param)]?.directory || null
        : null;
    const field = (
      <ParamField
        key={param.name}
        param={param}
        value={resolvedDirectory ?? value}
        onChange={(v) => setValues((prev) => ({ ...prev, [param.name]: v }))}
        error={error}
        lists={lists}
        sshHost={sshHostOf(param)}
        hosts={allowedHosts}
        machines={machines}
        locationAsMachine={management}
        newRoom={newRoomForPick}
        disabled={busy}
        onNavigateAway={() =>
          param.type === 'location'
            ? navigate('remoteHosts')
            : navigate('settings', { tab: 'clis-models' })
        }
      />
    );
    if (param.input === 'advanced' && !inFold) {
      const settled = !isEmpty(value) && error === null;
      return (
        <CollapsibleInput
          key={param.name}
          label={paramLabel(param)}
          summary={summary}
          collapsed={settled && !opened.has(param.name) && phase === 'form'}
          onOpen={() => open(param.name)}
          disabled={busy}
        >
          {field}
        </CollapsibleInput>
      );
    }
    return field;
  };

  const memberLists = (
    <>
      {showAgentLists && (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[12.5px] font-medium">agents</span>
            <span className="text-[11px] text-foreground-passive">already on the server</span>
          </div>
          <AgentListField items={editedAgents} onChange={setEditedAgents} lists={lists} />
          <p className="text-xs text-foreground-muted">
            Agents the template puts in the room. Drop any the server does not have, or add more.
          </p>
        </div>
      )}
      {showUserLists && (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[12.5px] font-medium">users</span>
            <span className="text-[11px] text-foreground-passive">people</span>
          </div>
          <UserListField items={editedUsers} onChange={setEditedUsers} lists={lists} />
          <p className="text-xs text-foreground-muted">
            People the template invites. A name the server has not seen is looked up in the
            messaging app's directory when the room is created.
          </p>
        </div>
      )}
    </>
  );

  const roomSummary =
    joinValue === NEW
      ? `New room: ${newRoomForPick?.name ?? 'from the template'}`
      : joinValue || 'Pick a room';
  // The template leaves the room to the deployer: one switch, and the room
  // choice under it only once it is on. Off, the agents are created on their own.
  const joinSwitch = joinParam ? (
    <div key={joinParam.name} className="flex flex-col gap-4">
      <label className="flex cursor-pointer items-start gap-3">
        <Switch
          checked={roomOn}
          disabled={busy}
          onCheckedChange={(on) => {
            setRoomOn(on);
            const next = on && hasRoomPart ? NEW : '';
            setValues((prev) => ({ ...prev, [joinParam.name]: next }));
            setPickingRoom(on && next === '');
          }}
          className="mt-0.5"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-[12.5px] font-medium text-foreground">{paramLabel(joinParam)}</span>
          {joinParam.description && (
            <span className="text-xs leading-relaxed text-foreground-muted">
              {joinParam.description}
            </span>
          )}
        </span>
      </label>
      {roomOn && (
        <div className="flex flex-col gap-4 border-l-2 border-border pl-4">
          {pickingRoom ? (
            <div className="flex flex-col gap-2">
              <span className="text-[12.5px] font-medium">Room</span>
              <RoomChoiceField
                rooms={lists.rooms}
                loading={lists.roomsLoading}
                newRoom={newRoomForPick}
                value=""
                onChange={(v) => {
                  setValues((prev) => ({ ...prev, [joinParam.name]: v }));
                  setPickingRoom(false);
                }}
              />
            </div>
          ) : (
            <CollapsibleInput
              label="Room"
              summary={roomSummary}
              collapsed
              onOpen={() => setPickingRoom(true)}
              disabled={busy}
            >
              {null}
            </CollapsibleInput>
          )}
        </div>
      )}
    </div>
  ) : null;

  // The inputs, in the order the template declares them. A param only the
  // room reads is left out while the room is not being made, since it does
  // nothing then. `advanced` and `fixed` params sit together in the
  // template's fold, below the asked ones, in the same order.
  const shownParams = templateParams.filter(
    (p) => p === joinParam || makesRoom || !roomOnly.has(p.name)
  );
  const askedRows = shownParams.filter((p) => p === joinParam || p.input === 'ask');
  const foldedRows = shownParams.filter((p) => p !== joinParam && p.input !== 'ask');
  const foldLabel = loaded?.form.advanced.label ?? 'Advanced';
  const foldSettled = foldedRows.every(
    (p) =>
      p.input === 'fixed' ||
      (!isEmpty(values[p.name]) &&
        (fieldErrors[p.name] ?? valueProblem(p, values[p.name] ?? '')) === null)
  );
  const fold =
    foldedRows.length > 0 ? (
      <CollapsibleInput
        label={foldLabel}
        summary={foldedRows
          .map((p) => summaryOf(p, values[p.name] ?? ''))
          .filter((v) => v !== '')
          .join('  ·  ')}
        collapsed={
          phase === 'form' &&
          !(loaded?.form.advanced.open ?? false) &&
          !opened.has('fold') &&
          foldSettled
        }
        onOpen={() => open('fold')}
        disabled={busy}
        wrap
      >
        <div className="flex flex-col gap-5 rounded-[10px] border border-border px-4 py-4">
          <span className="text-[12.5px] font-medium">{foldLabel}</span>
          {foldedRows.map((p) => paramRow(p, true))}
        </div>
      </CollapsibleInput>
    ) : null;

  /** The notices about the machine a new agent runs on, for its card. */
  const hostNotices = (setup: SlotSetup) => {
    const sshHost =
      setup.location === null || setup.location === LOCAL_RUN_LOCATION ? null : setup.location;
    if (management) return null;
    if (sshHost === null) return null;
    return (
      <>
        <HostReachabilityNotice sshHost={sshHost} />
        {hostReachable && firstRemote === sshHost && !hostReadiness.checking && (
          <HostReadinessNotice
            sshHost={sshHost}
            readiness={hostReadiness}
            onNavigateAway={() => navigate('remoteHosts')}
          />
        )}
      </>
    );
  };

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-start gap-4 border-b border-border px-8 pt-8 pb-5 [-webkit-app-region:drag]">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs text-foreground-passive">
            {intoRoomId ? `Add an agent to ${intoRoomName ?? 'the room'}` : 'Use template'}
          </span>
          <h2 className="truncate text-xl font-semibold tracking-tight">
            {loaded?.name ?? params.sourceName ?? 'Template'}
          </h2>
          {partlyDone && phase === 'form' && (
            <span className="text-xs text-foreground-muted">
              What was created stays created; the button carries on from the first step that did not
              finish.
            </span>
          )}
        </div>
        <div
          className={cn(
            'flex shrink-0 flex-col items-end gap-1 [-webkit-app-region:no-drag]',
            phase !== 'form' && 'invisible'
          )}
        >
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={cancel} disabled={phase !== 'form'}>
              {params.yamlText && !intoRoomId ? 'Back to the document' : 'Cancel'}
            </Button>
            <Button
              size="sm"
              onClick={() => void createAll()}
              disabled={blockedReason !== null || phase !== 'form'}
              title={blockedReason ?? undefined}
            >
              {primaryLabel}
            </Button>
          </div>
          {blockedReason && loaded && phase === 'form' && (
            <span className="max-w-md text-right text-[11.5px] text-foreground-muted">
              {blockedReason}
            </span>
          )}
        </div>
      </div>

      {loadError ? (
        <div className="px-8 py-6">
          <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        </div>
      ) : !loaded || (!parsed && loaded.coreYaml) ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-foreground-muted" />
        </div>
      ) : (
        <>
          {phase !== 'form' && (
            <CreatingScreen
              templateName={loaded.name}
              phase={phase}
              steps={createSteps}
              error={refusedPerAgent ? null : (runError ?? null)}
              doneDetail={doneDetail}
              onRetry={nothingKept ? null : () => void createAll()}
              onBack={() => setPhase('form')}
            />
          )}
          {/* The form stays mounted under the creating screen, so Back to the
            form finds every choice as it was left. */}
          <div className={cn('flex min-h-0 flex-1', phase !== 'form' && 'hidden')}>
            {/* Left: inputs */}
            <div className="flex w-[46%] min-w-[340px] shrink-0 flex-col gap-6 overflow-auto px-8 py-6">
              {createError && (
                <Alert variant="destructive">
                  <AlertDescription>{createError}</AlertDescription>
                </Alert>
              )}
              {loaded.warnings.map((w, i) => (
                <Alert key={i}>
                  <AlertDescription>{w}</AlertDescription>
                </Alert>
              ))}
              {creatorBlocked && makesRoom && (
                <Alert>
                  <AlertDescription>
                    <div className="flex flex-col gap-2">
                      <span>
                        This template puts you in the room, and this server does not know which
                        account is yours{templateBridge ? ` on ${templateBridge.displayName}` : ''}.
                      </span>
                      {linkAccount && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="self-start"
                          onClick={linkAccount}
                        >
                          Link account
                        </Button>
                      )}
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              {handoffBlocked.length > 0 && (
                <Alert>
                  <AlertDescription>
                    <div className="flex flex-col gap-2">
                      <span>
                        These agents will not hear each other:{' '}
                        {handoffBlocked.map((b) => `${b.to} ignores ${b.from}`).join(', ')}.
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        disabled={allowingHandoffs}
                        onClick={() => void allowHandoffs()}
                      >
                        {allowingHandoffs ? 'Updating…' : 'Let them hear each other'}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {templateParams.length === 0 && (
                <p className="text-sm text-foreground-muted">This template asks for nothing.</p>
              )}
              {askedRows.map((p) => (p === joinParam ? joinSwitch : paramRow(p)))}
              {makesRoom && memberLists}
              {fold}
            </div>

            {/* Right: what this will create */}
            <div className="flex min-w-0 flex-1 flex-col border-l border-border bg-background-1">
              <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[10.5px] font-medium tracking-wide text-foreground-passive uppercase">
                    Preview
                  </span>
                  <span className="text-[13px] font-semibold">What this will create</span>
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
                <div className="flex flex-col gap-2">
                  {slots.map((slot, i) => {
                    const setup = setups[i];
                    if (!setup || !setup.on) return null;
                    return (
                      <AgentSlotCard
                        key={i}
                        slot={slot}
                        wantedName={setup.name}
                        runtime={
                          setup.existing !== null
                            ? null
                            : management
                              ? {
                                  provider: setup.provider
                                    ? (providerDisplayName(setup.provider) ?? setup.provider)
                                    : null,
                                  location: setup.machine
                                    ? setup.machine.state === 'online'
                                      ? machineLabel(setup.machine)
                                      : `${machineLabel(setup.machine)} (${setup.machine.state})`
                                    : (setup.machineText ?? null),
                                  directory:
                                    setup.managedDirectory === ''
                                      ? null
                                      : shownDirectory(setup.managedDirectory, setup.machine),
                                  model: slot.entry.model
                                    ? interpolate(slot.entry.model, values)
                                    : null,
                                  connections: connectionStates(
                                    setup.connections,
                                    connectionsQuery.data ?? null
                                  ),
                                  managed: true,
                                }
                              : {
                                  provider: setup.provider
                                    ? (providerDisplayName(setup.provider) ?? setup.provider)
                                    : null,
                                  location:
                                    setup.location === null
                                      ? null
                                      : runLocationLabel(setup.location, allowedHosts),
                                  directory:
                                    setup.directory === ''
                                      ? null
                                      : setup.directory.replace(/^\/(?:Users|home)\/[^/]+/, '~'),
                                  model: null,
                                  connections: [],
                                  managed: false,
                                }
                        }
                        onChange={(next) =>
                          setSlots((prev) => prev.map((s, j) => (j === i ? next : s)))
                        }
                        lists={lists}
                        busy={busy}
                      >
                        {hostNotices(setup)}
                      </AgentSlotCard>
                    );
                  })}
                  {intoRoomId ? (
                    <p className="px-1 text-xs text-foreground-muted">
                      Joins{' '}
                      <span className="font-medium text-foreground">
                        {intoRoomName ?? 'the room'}
                      </span>
                      . Mention it there to start it.
                    </p>
                  ) : null}
                  {joinNames
                    .filter((n) => n !== intoRoomName)
                    .map((n) => (
                      <p key={n} className="px-1 text-xs text-foreground-muted">
                        Joins <span className="font-medium text-foreground">{n}</span>. Mention it
                        there to start it.
                      </p>
                    ))}
                  {makesRoom &&
                    (isV2 ? roomsOn : (parsed?.rooms ?? [])).map((room, i) => (
                      <RoomCard
                        key={i}
                        room={room}
                        values={railValues}
                        renames={railRenames}
                        bridgeName={templateBridge?.displayName ?? parsed?.bridge ?? null}
                        creatorIdentity={creatorIdentity}
                        status={roomStatus}
                        toggle={null}
                      />
                    ))}
                </div>
                <ResolvedDocument
                  yamlText={loaded.yamlText}
                  values={railValues}
                  renames={railRenames}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
});

function provisionErrorText(
  result: Exclude<Awaited<ReturnType<typeof rpc.agents.addAgent>>, { kind: 'created' }>,
  /** What the user calls the host they picked, keyed by SSH alias. */
  hostLabel: (sshHost: string) => string
): string {
  switch (result.kind) {
    case 'unauthenticated':
      return 'Sign in to this server first.';
    case 'name-conflict':
      return 'An agent with this name already exists in this directory or on the server.';
    case 'credentials-conflict':
      return `This directory already holds credentials for an agent of that name on ${result.endpoint}. Pick another directory.`;
    case 'already-configured':
      return 'This directory already holds credentials for an agent of that name. Load it instead.';
    case 'invalid-name':
      return result.message;
    case 'directory-unusable':
      return describeRemoteDirRefusal(result.inspection, hostLabel(result.sshHost));
    default:
      return result.message;
  }
}

export const templateUseView = {
  WrapView: ({ children }: { children: React.ReactNode } & Params) => <>{children}</>,
  TitlebarSlot: TemplateUseTitlebar,
  MainPanel: TemplateUsePanel,
  canActivate: (params: unknown): GuardResult => {
    const p = params as Partial<Params> | null;
    if (typeof p?.serverId !== 'string') return { ok: false, redirect: 'home' };
    if (!p.templateId && !p.yamlText)
      return { ok: false, redirect: 'templates', params: { serverId: p.serverId } };
    return { ok: true };
  },
} satisfies ViewDefinition<Params>;
