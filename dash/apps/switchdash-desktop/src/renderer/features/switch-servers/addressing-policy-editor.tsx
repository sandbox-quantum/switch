import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
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

const EMPTY_RULE: AddressingRule = { rooms: '*', room_groups: '*', users: '*', agents: '*' };

/** A "Specific" dimension with an empty list matches nobody. */
function matchesNobody(dim: AddressingDimension): boolean {
  return dim !== '*' && dim.length === 0;
}

/**
 * Why a rule can never match (so it would silently never apply), or null when it
 * is effective. A context dimension (rooms / room groups) that matches nobody
 * kills the rule outright; the sender is dead only when BOTH users and agents
 * match nobody (an empty list on just one kind is the intentional "none").
 */
function deadRuleReason(rule: AddressingRule): string | null {
  if (matchesNobody(rule.rooms)) return 'Rooms is Specific but empty — this rule never applies.';
  if (matchesNobody(rule.room_groups)) {
    return 'Room groups is Specific but empty — this rule never applies.';
  }
  if (matchesNobody(rule.users) && matchesNobody(rule.agents)) {
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
 * Controlled editor for an agent's scoped addressing policy (CHOO-1585). A null
 * value means "open" (anyone may address the agent); a policy value restricts to
 * senders matching a rule. Option lists (rooms / room groups / users / agents)
 * are supplied by the parent so this component stays presentational and reusable
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
  value: AddressingPolicy | null;
  onChange: (next: AddressingPolicy | null) => void;
  rooms: OptionItem[];
  roomGroups: OptionItem[];
  users: OptionItem[];
  agents: OptionItem[];
  disabled?: boolean;
}) {
  const restricted = value !== null;
  const rules = value?.rules ?? [];

  const optionsFor = (key: DimKey): OptionItem[] => {
    if (key === 'rooms') return rooms;
    if (key === 'room_groups') return roomGroups;
    if (key === 'users') return users;
    return agents;
  };

  const setRules = (next: AddressingRule[]) => onChange({ rules: next });
  const updateRule = (index: number, next: AddressingRule) =>
    setRules(rules.map((r, i) => (i === index ? next : r)));

  return (
    <div className="flex flex-col gap-3">
      <Select
        value={restricted ? 'restricted' : 'open'}
        onValueChange={(next) => onChange(next === 'restricted' ? { rules } : null)}
        disabled={disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="open">Open — anyone in the room can address it</SelectItem>
          <SelectItem value="restricted">Restricted — only matching rules</SelectItem>
        </SelectContent>
      </Select>

      {restricted && (
        <div className="flex flex-col gap-3">
          {rules.length === 0 && (
            <p className="text-destructive text-xs">
              No rules — a restricted policy with no rules means nobody can address this agent. Add
              a rule or switch back to Open.
            </p>
          )}
          {rules.map((rule, index) => (
            <div key={index} className="flex flex-col gap-2 rounded-md border border-border p-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Rule {index + 1}</span>
                {!disabled && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setRules(rules.filter((_r, i) => i !== index))}
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
                value={rule.users}
                options={optionsFor('users')}
                allowNone
                disabled={disabled}
                onChange={(users) => updateRule(index, { ...rule, users })}
              />
              <DimensionRow
                label="Agents"
                value={rule.agents}
                options={optionsFor('agents')}
                allowNone
                disabled={disabled}
                onChange={(agents) => updateRule(index, { ...rule, agents })}
              />
              {deadRuleReason(rule) !== null && (
                <p className="text-destructive text-xs">{deadRuleReason(rule)}</p>
              )}
            </div>
          ))}
          {!disabled && (
            <div>
              <Button variant="outline" size="sm" onClick={() => setRules([...rules, EMPTY_RULE])}>
                Add rule
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type DimMode = 'any' | 'specific' | 'none';

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

  const toggleId = (id: string, checked: boolean) => {
    const next = checked ? [...ids, id] : ids.filter((x) => x !== id);
    onChange(next);
  };

  const needle = search.trim().toLowerCase();
  // Always keep already-selected options visible so a filter never hides a
  // current selection the user might want to remove.
  const filtered = needle
    ? options.filter((o) => ids.includes(o.id) || o.label.toLowerCase().includes(needle))
    : options;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="w-24 text-xs font-medium text-foreground-muted">{label}</span>
        <Select value={mode} onValueChange={(m) => changeMode(m as DimMode)} disabled={disabled}>
          <SelectTrigger className="h-7 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            <SelectItem value="specific">Specific</SelectItem>
            {allowNone && <SelectItem value="none">None</SelectItem>}
          </SelectContent>
        </Select>
      </div>
      {mode === 'specific' && (
        <div className="ml-24 flex flex-col gap-1 rounded-md border border-border p-2">
          <Input
            placeholder={`Search ${label.toLowerCase()}…`}
            value={search}
            disabled={disabled}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7"
          />
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {options.length === 0 && (
              <span className="text-xs text-foreground-muted">Nothing to choose from.</span>
            )}
            {options.length > 0 && filtered.length === 0 && (
              <span className="text-xs text-foreground-muted">No matches.</span>
            )}
            {filtered.map((opt) => (
              <label key={opt.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={ids.includes(opt.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) => toggleId(opt.id, checked === true)}
                />
                <span className="truncate">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
