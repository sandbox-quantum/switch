import { Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import type {
  AddressingDimension,
  AddressingPolicy,
  AddressingRule,
} from '@shared/core/switch-servers/switch-servers';

export type OptionItem = { id: string; label: string };

type DimKey = 'rooms' | 'room_groups' | 'users' | 'agents';

const EMPTY_RULE: AddressingRule = {
  rooms: '*',
  room_groups: '*',
  users: '*',
  agents: '*',
  owner: false,
  owner_agents: false,
};

/**
 * The two symbolic subjects, as ids that sit in the Users and Agents pickers
 * beside real ones.
 *
 * They are booleans on the rule, not members of those lists — but to the person
 * filling the form they answer the same question ("who counts as a sender
 * here?"), so they are offered in the same place and mapped on the way in and
 * out. That also keeps them composable: "me and Alice" is one rule, which a
 * separate checkbox made possible but a separate dropdown mode would not.
 *
 * The `@` prefix is what keeps them from colliding with a real id — the picker
 * accepts free text, and neither Switch ids nor platform handles start with one
 * here.
 */
const ME = '@me';
const MY_AGENTS = '@my-agents';

const ME_OPTION: OptionItem = { id: ME, label: 'Me (the agent’s owner)' };
const MY_AGENTS_OPTION: OptionItem = { id: MY_AGENTS, label: 'My agents (anyone I own)' };

/** The Users dimension as the picker sees it: the owner reads as one more
 * entry in the list. `Any` already includes them, so it stays `*`. */
function usersOf(rule: AddressingRule): AddressingDimension {
  if (rule.users === '*') return '*';
  return rule.owner === true ? [ME, ...rule.users] : rule.users;
}

function agentsOf(rule: AddressingRule): AddressingDimension {
  if (rule.agents === '*') return '*';
  return rule.owner_agents === true ? [MY_AGENTS, ...rule.agents] : rule.agents;
}

/** Split a picked Users list back into stored ids and the symbolic flag. Any
 * and None both clear the flag: "anyone" already covers the owner, and "none"
 * means no human at all — leaving it set would contradict the choice just
 * made. */
function withUsers(rule: AddressingRule, next: AddressingDimension): AddressingRule {
  if (next === '*') return { ...rule, users: '*', owner: false };
  return { ...rule, users: next.filter((id) => id !== ME), owner: next.includes(ME) };
}

function withAgents(rule: AddressingRule, next: AddressingDimension): AddressingRule {
  if (next === '*') return { ...rule, agents: '*', owner_agents: false };
  return {
    ...rule,
    agents: next.filter((id) => id !== MY_AGENTS),
    owner_agents: next.includes(MY_AGENTS),
  };
}

/** A "Specific" dimension with an empty list matches nobody. */
function matchesNobody(dim: AddressingDimension): boolean {
  return dim !== '*' && dim.length === 0;
}

/**
 * Why a rule can never match (so it would silently never apply), or null when it
 * is effective. A context dimension (rooms / room groups) that matches nobody
 * kills the rule outright; the sender is dead only when BOTH users and agents
 * match nobody, symbolic entries included (an empty list on just one kind is
 * the intentional "none", and owner-only is the whole point of the default
 * policy).
 */
function deadRuleReason(rule: AddressingRule): string | null {
  if (matchesNobody(rule.rooms)) return 'Rooms is Specific but empty — this rule never applies.';
  if (matchesNobody(rule.room_groups)) {
    return 'Room groups is Specific but empty — this rule never applies.';
  }
  if (matchesNobody(usersOf(rule)) && matchesNobody(agentsOf(rule))) {
    return 'Both Users and Agents are empty — no sender can match, so this rule never applies.';
  }
  return null;
}

/** Whether a policy contains any rule that can never match. Callers disable Save
 * so an inert rule can't be persisted silently. */
export function policyHasDeadRule(policy: AddressingPolicy | null): boolean {
  return policy !== null && policy.rules.some((r) => deadRuleReason(r) !== null);
}

/**
 * Controlled editor for the rule list of an agent's scoped addressing policy
 * (CHOO-1585). Rendered only behind the "Custom rules" choice in
 * {@link AddressingPolicyControl}, which owns the open/restricted decision and
 * the owner warning. Option lists (rooms / room groups / users / agents) are
 * supplied by the parent so this component stays presentational and reusable
 * across the settings page and the creation modal.
 */
export function AddressingPolicyEditor({
  value,
  onChange,
  rooms,
  roomGroups,
  users,
  agents,
  disabled = false,
}: {
  value: AddressingPolicy;
  onChange: (next: AddressingPolicy) => void;
  rooms: OptionItem[];
  roomGroups: OptionItem[];
  users: OptionItem[];
  agents: OptionItem[];
  disabled?: boolean;
}) {
  const rules = value.rules;
  // Which rule (by index) is currently open for editing. Loaded rules start
  // collapsed (shown as a read-only summary); a freshly added rule opens for
  // editing. Only one rule is edited at a time.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const optionsFor = (key: DimKey): OptionItem[] => {
    if (key === 'rooms') return rooms;
    if (key === 'room_groups') return roomGroups;
    // The symbolic entry leads its list: it is the one most rules want, and it
    // is the only entry that stays correct as people and agents come and go.
    if (key === 'users') return [ME_OPTION, ...users];
    return [MY_AGENTS_OPTION, ...agents];
  };

  const setRules = (next: AddressingRule[]) => onChange({ rules: next });
  const updateRule = (index: number, next: AddressingRule) =>
    setRules(rules.map((r, i) => (i === index ? next : r)));

  const addRule = () => {
    setRules([...rules, EMPTY_RULE]);
    setEditingIndex(rules.length);
  };
  const removeRule = (index: number) => {
    setRules(rules.filter((_r, i) => i !== index));
    setEditingIndex((prev) =>
      prev === null || prev === index ? null : prev > index ? prev - 1 : prev
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {rules.length === 0 && (
        <p className="text-xs text-foreground-muted">
          No rules — a policy with no rules restricts nothing, so anyone in the agent&apos;s rooms
          can address it. Add a rule, or choose “Anyone” above.
        </p>
      )}
      {rules.map((rule, index) =>
        index === editingIndex ? (
          <div
            key={index}
            className="border-primary/50 flex flex-col gap-2 rounded-md border bg-background-2/40 p-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Editing rule {index + 1}</span>
              {!disabled && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeRule(index)}
                  aria-label="Remove rule"
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
            <DimensionRow
              label="Rooms"
              value={rule.rooms}
              options={optionsFor('rooms')}
              allowNone={false}
              disabled={disabled}
              onChange={(rooms) => updateRule(index, { ...rule, rooms })}
            />
            <DimensionRow
              label="Room groups"
              value={rule.room_groups}
              options={optionsFor('room_groups')}
              allowNone={false}
              disabled={disabled}
              onChange={(room_groups) => updateRule(index, { ...rule, room_groups })}
            />
            <DimensionRow
              label="Users"
              value={usersOf(rule)}
              options={optionsFor('users')}
              allowNone
              disabled={disabled}
              onChange={(users) => updateRule(index, withUsers(rule, users))}
            />
            <DimensionRow
              label="Agents"
              value={agentsOf(rule)}
              options={optionsFor('agents')}
              allowNone
              disabled={disabled}
              onChange={(agents) => updateRule(index, withAgents(rule, agents))}
            />
            {deadRuleReason(rule) !== null && (
              <p className="text-destructive text-xs">{deadRuleReason(rule)}</p>
            )}
            {!disabled && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={deadRuleReason(rule) !== null}
                  onClick={() => setEditingIndex(null)}
                >
                  Apply rule
                </Button>
              </div>
            )}
          </div>
        ) : (
          <RuleSummary
            key={index}
            index={index}
            rule={rule}
            rooms={rooms}
            roomGroups={roomGroups}
            users={users}
            agents={agents}
            disabled={disabled}
            onEdit={() => setEditingIndex(index)}
            onRemove={() => removeRule(index)}
          />
        )
      )}
      {!disabled && (
        <div>
          <Button variant="outline" size="sm" disabled={editingIndex !== null} onClick={addRule}>
            Add rule
          </Button>
        </div>
      )}
    </div>
  );
}

/** Human-readable summary of one dimension for the collapsed rule view. */
function dimLabel(dim: AddressingDimension, options: OptionItem[]): string {
  if (dim === '*') return 'any';
  if (dim.length === 0) return 'none';
  return dim.map((id) => options.find((o) => o.id === id)?.label ?? id).join(', ');
}

/** Collapsed, read-only view of an applied rule — makes it obvious the rule is
 * set up (vs the bordered/highlighted editing view). */
function RuleSummary({
  index,
  rule,
  rooms,
  roomGroups,
  users,
  agents,
  disabled,
  onEdit,
  onRemove,
}: {
  index: number;
  rule: AddressingRule;
  rooms: OptionItem[];
  roomGroups: OptionItem[];
  users: OptionItem[];
  agents: OptionItem[];
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const dead = deadRuleReason(rule);
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-border p-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">Rule {index + 1}</span>
        <div className="flex flex-col gap-0.5 text-xs text-foreground-muted">
          <span>
            <span className="font-medium">Rooms:</span> {dimLabel(rule.rooms, rooms)}
          </span>
          <span>
            <span className="font-medium">Room groups:</span>{' '}
            {dimLabel(rule.room_groups, roomGroups)}
          </span>
          <span>
            <span className="font-medium">Users:</span>{' '}
            {dimLabel(usersOf(rule), [ME_OPTION, ...users])}
          </span>
          <span>
            <span className="font-medium">Agents:</span>{' '}
            {dimLabel(agentsOf(rule), [MY_AGENTS_OPTION, ...agents])}
          </span>
        </div>
        {dead !== null && <span className="text-destructive text-xs">{dead}</span>}
      </div>
      {!disabled && (
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove rule">
            <Trash2 className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

type DimMode = 'any' | 'specific' | 'none';

// A Base UI select trigger renders the stored value unless it is given
// something else, so the labels have to be readable from both ends.
const DIM_MODE_LABELS: Record<DimMode, string> = {
  any: 'Any',
  specific: 'Specific',
  none: 'None',
};

function initialMode(value: AddressingDimension, allowNone: boolean): DimMode {
  if (value === '*') return 'any';
  if (value.length === 0) return allowNone ? 'none' : 'specific';
  return 'specific';
}

/**
 * One dimension of a rule. `allowNone` adds an explicit "None" mode for the
 * dimensions where excluding a whole sender kind is meaningful (users, agents);
 * context dimensions (rooms, room groups) only offer Any / Specific. The mode is
 * tracked locally so "None" and an in-progress empty "Specific" (both `[]` in
 * the model) stay distinguishable in the UI.
 */
function DimensionRow({
  label,
  value,
  options,
  allowNone,
  disabled,
  onChange,
}: {
  label: string;
  value: AddressingDimension;
  options: OptionItem[];
  allowNone: boolean;
  disabled: boolean;
  onChange: (next: AddressingDimension) => void;
}) {
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<DimMode>(() => initialMode(value, allowNone));
  const ids = value === '*' ? [] : value;

  const changeMode = (next: DimMode) => {
    setMode(next);
    if (next === 'any') onChange('*');
    else if (next === 'none') onChange([]);
    else onChange(ids); // 'specific' — keep any current ids
  };

  const labelFor = (id: string) => options.find((o) => o.id === id)?.label ?? id;
  const addId = (id: string) => {
    if (!ids.includes(id)) onChange([...ids, id]);
  };
  const removeId = (id: string) => onChange(ids.filter((x) => x !== id));

  // Manual free-text entry: add the typed value. If it matches a known option's
  // label (case-insensitive), store that option's id instead of the raw text.
  const addManual = () => {
    const raw = search.trim();
    if (!raw) return;
    const byLabel = options.find((o) => o.label.toLowerCase() === raw.toLowerCase());
    addId(byLabel ? byLabel.id : raw);
    setSearch('');
  };

  const needle = search.trim().toLowerCase();
  const matches = needle
    ? options.filter((o) => !ids.includes(o.id) && o.label.toLowerCase().includes(needle))
    : [];
  // Offer "add manual" only when the typed text isn't already an option or selected.
  const canAddManual =
    needle.length > 0 &&
    !ids.includes(search.trim()) &&
    !options.some((o) => o.label.toLowerCase() === needle || o.id.toLowerCase() === needle);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="w-24 text-xs font-medium text-foreground-muted">{label}</span>
        <Select value={mode} onValueChange={(m) => changeMode(m as DimMode)} disabled={disabled}>
          <SelectTrigger className="h-7 w-32">
            <SelectValue>{DIM_MODE_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{DIM_MODE_LABELS.any}</SelectItem>
            <SelectItem value="specific">{DIM_MODE_LABELS.specific}</SelectItem>
            {allowNone && <SelectItem value="none">{DIM_MODE_LABELS.none}</SelectItem>}
          </SelectContent>
        </Select>
        {mode === 'specific' && ids.length > 0 && (
          <span className="text-xs text-foreground-muted">{ids.length} selected</span>
        )}
      </div>
      {mode === 'specific' && (
        <div className="ml-24 flex flex-col gap-2 rounded-md border border-border p-2">
          {/* Selected entries as chips, so a configured rule is obvious at a glance. */}
          {ids.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {ids.map((id) => (
                <Badge key={id} variant="secondary" className="gap-1 pr-1">
                  <span className="max-w-[180px] truncate">{labelFor(id)}</span>
                  {!disabled && (
                    <button
                      type="button"
                      aria-label={`Remove ${labelFor(id)}`}
                      className="hover:bg-muted rounded-sm"
                      onClick={() => removeId(id)}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-xs text-foreground-muted">
              None selected yet — search to pick, or type a value and press Enter.
            </span>
          )}
          <Input
            placeholder={`Search or type a ${label.toLowerCase()} value…`}
            value={search}
            disabled={disabled}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canAddManual) {
                e.preventDefault();
                addManual();
              }
            }}
            className="h-7"
          />
          {needle.length > 0 && (
            <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              {matches.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  disabled={disabled}
                  className="hover:text-accent-foreground rounded-sm px-1.5 py-1 text-left text-sm hover:bg-background-quaternary-1"
                  onClick={() => {
                    addId(opt.id);
                    setSearch('');
                  }}
                >
                  <span className="truncate">{opt.label}</span>
                </button>
              ))}
              {canAddManual && (
                <button
                  type="button"
                  disabled={disabled}
                  className="hover:text-accent-foreground rounded-sm px-1.5 py-1 text-left text-sm text-foreground-muted hover:bg-background-quaternary-1"
                  onClick={addManual}
                >
                  + Add “{search.trim()}”
                </button>
              )}
              {matches.length === 0 && !canAddManual && (
                <span className="px-1.5 py-1 text-xs text-foreground-muted">No matches.</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
