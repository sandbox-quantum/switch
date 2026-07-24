import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  IconButton,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import DeleteOutline from "@mui/icons-material/DeleteOutline";
import { useMemo, useState } from "react";
import {
  type AddressingDimension,
  type AddressingPolicy,
  type AddressingRule,
  type AgentDetail,
  updateAgentAddressingPolicy,
} from "../../data/api";
import {
  useAgents,
  useAllExternalUsers,
  useRoomGroups,
  useRooms,
} from "../../data/hooks";

// A pickable option for one of the four dimensions.
interface Option {
  id: string;
  label: string;
}

// Working (editable) shape of one dimension: "any" is the "*" wildcard,
// "specific" carries an explicit id list, and "none" ([]) matches nobody.
// "none" is only offered for the sender dimensions (users / agents), where
// excluding a whole sender kind is meaningful.
type DimMode = "any" | "specific" | "none";
interface DimState {
  mode: DimMode;
  ids: string[];
}
interface RuleState {
  rooms: DimState;
  room_groups: DimState;
  users: DimState;
  agents: DimState;
}

function toDimState(value: AddressingDimension, allowNone: boolean): DimState {
  if (value === "*") return { mode: "any", ids: [] };
  if (value.length === 0) {
    return { mode: allowNone ? "none" : "specific", ids: [] };
  }
  return { mode: "specific", ids: value };
}

function fromDimState(state: DimState): AddressingDimension {
  if (state.mode === "any") return "*";
  if (state.mode === "none") return [];
  return state.ids;
}

function toRuleState(rule: AddressingRule): RuleState {
  return {
    rooms: toDimState(rule.rooms, false),
    room_groups: toDimState(rule.room_groups, false),
    users: toDimState(rule.users, true),
    agents: toDimState(rule.agents, true),
  };
}

function fromRuleState(state: RuleState): AddressingRule {
  return {
    rooms: fromDimState(state.rooms),
    room_groups: fromDimState(state.room_groups),
    users: fromDimState(state.users),
    agents: fromDimState(state.agents),
  };
}

// A rule that can never match (so it would silently never apply): a context
// dimension set to Specific-but-empty, or both sender dimensions matching nobody.
function dimMatchesNobody(state: DimState): boolean {
  return state.mode === "none" || (state.mode === "specific" && state.ids.length === 0);
}
function ruleIsDead(rule: RuleState): boolean {
  return (
    dimMatchesNobody(rule.rooms) ||
    dimMatchesNobody(rule.room_groups) ||
    (dimMatchesNobody(rule.users) && dimMatchesNobody(rule.agents))
  );
}

const EMPTY_RULE: RuleState = {
  rooms: { mode: "any", ids: [] },
  room_groups: { mode: "any", ids: [] },
  users: { mode: "any", ids: [] },
  agents: { mode: "any", ids: [] },
};

function DimensionField({
  label,
  help,
  state,
  options,
  allowNone,
  disabled,
  onChange,
}: {
  label: string;
  help: string;
  state: DimState;
  options: Option[];
  allowNone: boolean;
  disabled: boolean;
  onChange: (next: DimState) => void;
}) {
  const selected = options.filter((o) => state.ids.includes(o.id));
  // Ids that no longer resolve to a known option (e.g. a deleted room) are still
  // shown as raw chips so the operator can see and remove them.
  const unknownIds = state.ids.filter(
    (id) => !options.some((o) => o.id === id),
  );

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} mb={0.5}>
        <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 100 }}>
          {label}
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={state.mode}
          disabled={disabled}
          onChange={(_e, mode: DimMode | null) => {
            if (mode) onChange({ ...state, mode });
          }}
        >
          <ToggleButton value="any">Any</ToggleButton>
          <ToggleButton value="specific">Specific</ToggleButton>
          {allowNone && <ToggleButton value="none">None</ToggleButton>}
        </ToggleButtonGroup>
      </Stack>
      {state.mode === "specific" && (
        <Autocomplete
          multiple
          freeSolo
          size="small"
          disabled={disabled}
          options={options}
          getOptionLabel={(o) => (typeof o === "string" ? o : o.label)}
          value={[
            ...selected,
            ...unknownIds.map((id) => ({ id, label: `${id} (manual)` })),
          ]}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          onChange={(_e, next) =>
            onChange({
              ...state,
              ids: next.map((o) => (typeof o === "string" ? o.trim() : o.id)),
            })
          }
          renderInput={(params) => (
            <TextField
              {...params}
              placeholder="search or type a value…"
              helperText={`${help} Type a value and press Enter to add it manually.`}
            />
          )}
        />
      )}
    </Box>
  );
}

export default function AddressingPolicySection({
  agent,
  canEdit,
  onUpdated,
}: {
  agent: AgentDetail;
  canEdit: boolean;
  onUpdated: () => void;
}) {
  const initialRestricted = !!agent.addressing_policy;
  const initialRules: RuleState[] = (agent.addressing_policy?.rules ?? []).map(
    toRuleState,
  );

  const [restricted, setRestricted] = useState(initialRestricted);
  const [rules, setRules] = useState<RuleState[]>(initialRules);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: rooms } = useRooms();
  const { data: groups } = useRoomGroups();
  const { data: agents } = useAgents();
  const { data: users } = useAllExternalUsers();

  const roomOptions: Option[] = useMemo(
    () => (rooms ?? []).map((r) => ({ id: r.id, label: r.name })),
    [rooms],
  );
  const groupOptions: Option[] = useMemo(
    () => (groups ?? []).map((g) => ({ id: g.id, label: g.name })),
    [groups],
  );
  const agentOptions: Option[] = useMemo(
    () => (agents ?? []).map((a) => ({ id: a.id, label: a.name })),
    [agents],
  );
  const userOptions: Option[] = useMemo(
    () => (users ?? []).map((u) => ({ id: u.id, label: u.external_username })),
    [users],
  );

  const desired: AddressingPolicy | null = restricted
    ? { rules: rules.map(fromRuleState) }
    : null;
  const dirty =
    JSON.stringify(desired) !==
    JSON.stringify(agent.addressing_policy ?? null);
  const hasDeadRule = restricted && rules.some(ruleIsDead);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateAgentAddressingPolicy(agent.id, desired);
      onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save policy");
    } finally {
      setSaving(false);
    }
  };

  const updateRule = (index: number, next: RuleState) =>
    setRules((prev) => prev.map((r, i) => (i === index ? next : r)));

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle2" color="text.secondary">
          Addressing policy
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Controls who may address this agent (@mention, targeted message, or task
          delegation). Open means any room participant can; restricted permits only
          senders matching an allow-rule.
        </Typography>
      </Box>

      <RadioGroup
        value={restricted ? "restricted" : "open"}
        onChange={(e) => setRestricted(e.target.value === "restricted")}
      >
        <FormControlLabel
          value="open"
          disabled={!canEdit}
          control={<Radio size="small" />}
          label="Open — anyone in the room can address this agent"
        />
        <FormControlLabel
          value="restricted"
          disabled={!canEdit}
          control={<Radio size="small" />}
          label="Restricted — only senders matching a rule below"
        />
      </RadioGroup>

      {restricted && (
        <Stack spacing={2}>
          {rules.length === 0 && (
            <Alert severity="warning">
              No rules — with a restricted policy and no rules, nobody can address
              this agent. Add a rule or switch back to Open.
            </Alert>
          )}
          {rules.map((rule, index) => (
            <Paper key={index} variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
              <Stack direction="row" alignItems="center" mb={1}>
                <Typography variant="body2" sx={{ fontWeight: 600, flexGrow: 1 }}>
                  Rule {index + 1}
                </Typography>
                {canEdit && (
                  <IconButton
                    size="small"
                    onClick={() =>
                      setRules((prev) => prev.filter((_r, i) => i !== index))
                    }
                    aria-label="Remove rule"
                  >
                    <DeleteOutline fontSize="small" />
                  </IconButton>
                )}
              </Stack>
              <Stack spacing={1.5}>
                <DimensionField
                  label="Rooms"
                  help="Rooms this rule applies in."
                  state={rule.rooms}
                  options={roomOptions}
                  allowNone={false}
                  disabled={!canEdit}
                  onChange={(rooms) => updateRule(index, { ...rule, rooms })}
                />
                <DimensionField
                  label="Room groups"
                  help="Groups of the room the message is in."
                  state={rule.room_groups}
                  options={groupOptions}
                  allowNone={false}
                  disabled={!canEdit}
                  onChange={(room_groups) =>
                    updateRule(index, { ...rule, room_groups })
                  }
                />
                <DimensionField
                  label="Users"
                  help="Human (bridged) senders this rule admits."
                  state={rule.users}
                  options={userOptions}
                  allowNone
                  disabled={!canEdit}
                  onChange={(users) => updateRule(index, { ...rule, users })}
                />
                <DimensionField
                  label="Agents"
                  help="Agent senders this rule admits."
                  state={rule.agents}
                  options={agentOptions}
                  allowNone
                  disabled={!canEdit}
                  onChange={(agents) => updateRule(index, { ...rule, agents })}
                />
                {ruleIsDead(rule) && (
                  <Alert severity="warning">
                    This rule can never match (an empty Specific/None dimension
                    excludes everyone), so it will never apply.
                  </Alert>
                )}
              </Stack>
            </Paper>
          ))}
          {canEdit && (
            <Box>
              <Button
                size="small"
                variant="outlined"
                onClick={() => setRules((prev) => [...prev, { ...EMPTY_RULE }])}
              >
                Add rule
              </Button>
            </Box>
          )}
        </Stack>
      )}

      {error && <Alert severity="error">{error}</Alert>}

      {canEdit && (
        <Box>
          <Button
            variant="contained"
            disabled={!dirty || saving || hasDeadRule}
            onClick={handleSave}
            startIcon={saving ? <CircularProgress size={16} /> : undefined}
          >
            Save policy
          </Button>
        </Box>
      )}
    </Stack>
  );
}
